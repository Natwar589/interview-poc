// Answer generation: builds the prompt and streams a short, speakable answer from the
// provider selected by LLM_PROVIDER (gemini | anthropic).
import { streamAnthropic, describeAnthropicError, anthropicConfig, isAbort } from './providers/anthropic.js';
import { streamGemini, describeGeminiError, geminiConfig } from './providers/gemini.js';

const PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
const MAX_HISTORY = 5; // previous Q&A pairs kept as conversation memory

const PROVIDERS = {
  gemini: { stream: streamGemini, describe: describeGeminiError, config: geminiConfig },
  anthropic: { stream: streamAnthropic, describe: describeAnthropicError, config: anthropicConfig },
};
const provider = PROVIDERS[PROVIDER];
if (!provider) throw new Error(`Unknown LLM_PROVIDER "${PROVIDER}" (use gemini or anthropic)`);

const RULES = `You are a real-time interview copilot. A candidate is in a live interview and will glance at your answer and say it out loud.

Answer the interviewer's latest question AS the candidate, in the first person.

Format (strict):
- 4 or 5 bullet points, each starting with "- ".
- Each bullet is ONE short sentence of 12 to 18 words. Never more than 90 words in total.
- Spoken-style phrases the candidate can glance at and say; no jargon dumps, no hedging filler.
- No heading, no preamble, no closing remark. Start with the first bullet.
- Use **bold** for at most one key phrase per bullet.

Content:
- Ground personal answers ("tell me about yourself", "why this role", past projects, behavioral questions) in the candidate's resume and the job description below. Never invent employers, titles, numbers or projects that are not in the resume; if the resume lacks a fitting example, give a plausible approach without fake specifics.
- Behavioral questions: compress Situation, Task, Action, Result into the bullets.
- Technical questions: lead with the direct answer, then key points or trade-offs.
- Follow-up questions refer to the earlier Q&A in this conversation; stay consistent with it.
- If the transcribed question is garbled or ambiguous, answer the most likely intended question.`;

// Resume + JD go in the system prompt, which stays identical for the whole session so
// both providers can cache it.
function buildSystem(context) {
  const resume = context.resume?.trim() || '(not provided)';
  const jd = context.jobDescription?.trim() || '(not provided)';
  return `${RULES}\n\n<candidate_resume>\n${resume}\n</candidate_resume>\n\n<job_description>\n${jd}\n</job_description>`;
}

function buildTurns(history, question, preamble) {
  const turns = [];
  for (const turn of history.slice(-MAX_HISTORY)) {
    turns.push({ role: 'user', text: `Interviewer: ${turn.question}` });
    turns.push({ role: 'assistant', text: turn.answer });
  }
  const lead = preamble ? `(Interviewer said just before: "${preamble}")\n` : '';
  turns.push({ role: 'user', text: `${lead}Interviewer: ${question}` });
  return turns;
}

/**
 * Stream an answer. Calls onDelta(text) per text chunk and resolves with
 * { text, firstTokenAt, cachedInputTokens } once done. Pass an AbortSignal to cancel.
 */
export async function streamAnswer({ question, preamble, context, history, signal, onDelta }) {
  if (process.env.MOCK_LLM === '1') return mockAnswer({ question, signal, onDelta });
  return provider.stream({
    system: buildSystem(context),
    turns: buildTurns(history, question, preamble),
    signal,
    onDelta,
  });
}

// MOCK_LLM=1: canned streamed answer, for exercising the UI without an API key.
async function mockAnswer({ question, signal, onDelta }) {
  const text = `- **Mock answer** for: "${question.slice(0, 60)}"\n- Set an API key and unset MOCK_LLM for real answers\n- Tokens stream in like this, word by word`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);
  const firstTokenAt = Date.now();
  for (const piece of text.split(/(?<= )/)) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    onDelta(piece);
    await sleep(30);
  }
  return { text, firstTokenAt, cachedInputTokens: 0 };
}

export function isAbortError(err) {
  return err?.name === 'AbortError' || isAbort(err);
}

/** Turn provider errors into something a user can act on. */
export function describeError(err) {
  return provider.describe(err) || err?.message || String(err);
}

export const answerConfig = provider.config;
