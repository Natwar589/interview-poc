// Answer generation: builds the prompt and streams a short, speakable answer from the
// providers listed in LLM_PROVIDER, in order (e.g. gemini,anthropic,groq: see providerChain.js).
import { streamAnthropic, describeAnthropicError, anthropicConfig, isAbort } from './providers/anthropic.js';
import { streamGemini, describeGeminiError, geminiConfig } from './providers/gemini.js';
import { streamGroq, describeGroqError, groqConfig } from './providers/groq.js';
import { readKeys } from './keyPool.js';
import { streamChain, parseChain } from './providerChain.js';

const MAX_HISTORY = 5; // previous Q&A pairs kept as conversation memory

const PROVIDERS = {
  gemini: { stream: streamGemini, describe: describeGeminiError, config: geminiConfig },
  anthropic: { stream: streamAnthropic, describe: describeAnthropicError, config: anthropicConfig },
  groq: { stream: streamGroq, describe: describeGroqError, config: groqConfig },
};
const keyCount = (name) => readKeys(name.toUpperCase()).length;
const requested = parseChain(process.env.LLM_PROVIDER || 'gemini,anthropic,groq');
for (const name of requested) {
  if (!PROVIDERS[name]) throw new Error(`Unknown LLM_PROVIDER "${name}" (use gemini, anthropic, groq or a comma list)`);
}
// Providers without keys drop out of the chain; if none has keys, keep the first so its
// "key not set" error reaches the UI.
const withKeys = requested.filter((name) => keyCount(name) > 0);
const chain = (withKeys.length ? withKeys : requested.slice(0, 1)).map((name) => ({ name, ...PROVIDERS[name] }));
const provider = chain[0];

const RULES = `You help a candidate during a live job interview. They will glance at your answer and say it out loud, so write exactly what they could say: first person, as the candidate.

How it should sound:
- Like a real person talking in an interview: natural, plain English, contractions ("I've", "it's"), confident but humble.
- Simple words over impressive ones. "I've been building React apps for about three years" beats "I possess extensive expertise in React".
- An occasional natural transition is good ("The way I think about it...", "In my last role...", "Honestly, the main trade-off is...").
- Never open with "Certainly", "Great question", "Sure", "So,", "As an AI" or any preamble. Start with the answer itself.
- No headings, no closing summary, no "I hope this helps".

Format:
- Lead with the spoken answer as short paragraphs (not bullets).
- Then, only if it genuinely helps, a line "Key points:" followed by 2 to 4 short "- " bullets the candidate can glance at for extra detail.
- Mark the 2 to 4 most important technical terms or phrases with **bold**. Nothing else is bold.

Content:
- Ground personal answers ("tell me about yourself", "why this role", projects, behavioral questions) in the candidate's resume and connect them to the job description. Never invent employers, titles, numbers, technologies or achievements that are not in the resume; if the resume has no fitting example, describe how they would approach it, without fake specifics.
- If the resume is "(not provided)", NEVER make up a background: for personal facts use short bracketed placeholders the candidate fills in as they speak, e.g. "I've been working as a [your role] for [X years], mostly with [main technologies]." Keep the sentences natural around them.
- Behavioral questions: tell it as a short story (situation, what I did, result) in the spoken paragraphs.
- Technical questions: answer directly first, then the reasoning or trade-offs.
- Coding requests ("write the code", "give me a C++ solution", "solve two sum"): one or two sentences on the approach and the time/space complexity, then ONE fenced code block (\`\`\`cpp, \`\`\`python, ...) with a complete, compact, correct solution in the requested language (default Python). The length limit does not apply to the code. A follow-up like "give me the full code" refers to the previous question.
- Follow-ups build on the earlier Q&A in this conversation: stay consistent and don't repeat an explanation already given.
- If the transcribed question is garbled or ambiguous, answer the most likely intended question.`;

// Answer preferences chosen in the UI. Unknown values fall back to the defaults.
const STYLES = {
  natural: 'Style: natural and conversational, like talking to a colleague.',
  concise: 'Style: professional and to the point. No small talk, no filler.',
  technical: 'Style: detailed and technical. Use precise terminology, mention trade-offs, internals and edge cases.',
  beginner: 'Style: beginner-friendly. Explain in plain terms a non-specialist would follow; a short everyday analogy is welcome.',
};
const LENGTHS = {
  short: 'Length: 2 or 3 sentences, about 40 to 60 words. No "Key points" section.',
  balanced: 'Length: about 60 to 100 words of spoken answer, plus optional key points.',
  detailed: 'Length: two short paragraphs, about 140 to 200 words, plus up to 4 key points.',
};
// Repeated next to each question: models drift long without it.
const LENGTH_NOTE = {
  short: '(Reply in 2-3 spoken sentences, under 60 words, no key points.)',
  balanced: '(Keep the spoken answer under 100 words, then at most 3 key points.)',
  detailed: '(Two short paragraphs, under 200 words, then at most 4 key points.)',
};
export const ANSWER_STYLES = Object.keys(STYLES);
export const ANSWER_LENGTHS = Object.keys(LENGTHS);

// Follow-up actions on the last answer (UI buttons).
const REFINE = {
  regenerate: null, // a fresh take on the same question, previous answer not shown
  shorter: 'Say that again, shorter: about half the length, keep only what matters most.',
  conversational: 'Say that again in a more relaxed, conversational way, simpler words, as if chatting with the interviewer.',
  detailed: 'Expand on that with more depth: the reasoning, a concrete example and the main trade-offs.',
};
export const REFINE_KINDS = Object.keys(REFINE);

// Resume + JD go in the system prompt, which stays identical for the whole session so
// providers can cache it (the style/length lines change only when the user changes them).
function buildSystem(context) {
  const resume = context.resume?.trim() || '(not provided)';
  const jd = context.jobDescription?.trim() || '(not provided)';
  const prefs = `${STYLES[context.answerStyle] ?? STYLES.natural}\n${LENGTHS[context.answerLength] ?? LENGTHS.balanced}`;
  return `${RULES}\n\n${prefs}\n\n<candidate_resume>\n${resume}\n</candidate_resume>\n\n<job_description>\n${jd}\n</job_description>`;
}

// Models readily invent a plausible career when there is no resume; a reminder right
// next to the question is followed far more reliably than the system prompt alone.
const NO_RESUME_NOTE =
  '\n(No resume was shared. For any personal fact — role, years, companies, numbers, projects — write a [bracketed placeholder] instead of inventing one. For a story about past work, give the story\'s shape with placeholders, e.g. "At [company], we had [the problem]. I [what you did], and [the result]." No invented numbers, durations, tools or outcomes: those are placeholders too. Technical explanations need no placeholders.)';

function buildTurns(history, question, preamble, refine, { noResume = false, lengthNote = '' } = {}) {
  const turns = [];
  for (const turn of history.slice(-MAX_HISTORY)) {
    turns.push({ role: 'user', text: `Interviewer: ${turn.question}` });
    turns.push({ role: 'assistant', text: turn.answer });
  }
  const lead = preamble ? `(Interviewer said just before: "${preamble}")\n` : '';
  // Code answers are exempt from the word limit (see RULES), so the note is safe there too.
  turns.push({ role: 'user', text: `${lead}Interviewer: ${question}${noResume ? NO_RESUME_NOTE : ''}\n${lengthNote}` });
  // Rewrites: show the previous answer, then ask for the variant.
  if (refine?.previous && REFINE[refine.kind]) {
    turns.push({ role: 'assistant', text: refine.previous });
    turns.push({ role: 'user', text: `${REFINE[refine.kind]} Same format rules.` });
  }
  return turns;
}

/**
 * Stream an answer. Calls onDelta(text) per text chunk and resolves with
 * { text, firstTokenAt, cachedInputTokens } once done. Pass an AbortSignal to cancel.
 * `refine` = { kind, previous } rewrites the previous answer to the same question.
 */
export async function streamAnswer({ question, preamble, context, history, refine, signal, onDelta }) {
  if (process.env.MOCK_LLM === '1') return mockAnswer({ question, signal, onDelta });
  return streamChain(chain, {
    system: buildSystem(context),
    turns: buildTurns(history, question, preamble, refine, {
      noResume: !context.resume?.trim(),
      lengthNote: LENGTH_NOTE[context.answerLength] ?? LENGTH_NOTE.balanced,
    }),
    signal,
    onDelta,
  });
}

// MOCK_LLM=1: canned streamed answer, for exercising the UI without an API key.
async function mockAnswer({ question, signal, onDelta }) {
  const text = `This is a **mock answer** for "${question.slice(0, 60)}". Set an API key and turn off MOCK_LLM to get real answers.\n\nKey points:\n- Answers stream in **word by word**\n- Nothing here came from a model`;
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
  if (err?.chainFailure) return err.message;
  return provider.describe(err) || err?.message || String(err);
}

// Key counts only, never the keys themselves.
export const answerConfig = {
  ...provider.config,
  chain: chain.map((p) => ({ provider: p.name, model: p.config.model, keys: keyCount(p.name) })),
  skipped: requested.filter((name) => !chain.some((p) => p.name === name)),
};
