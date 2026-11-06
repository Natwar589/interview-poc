import { GoogleGenAI, ApiError } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
// Used when the main model is overloaded (503/429/500) before any text arrives.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
// Only Gemini 3+ models use this (2.5 models run with thinking off). LOW keeps time to first token low
// (gemini-3.8-flash rejects MINIMAL).
const THINKING = process.env.GEMINI_THINKING || 'LOW';
const RETRYABLE = new Set([429, 500, 503]);
// After the main model fails with one of those, skip it for this long instead of paying
// for a doomed request (plus the retry) on every question. Free-tier quotas are per model.
const COOLDOWN_MS = 60_000;
let primaryDownUntil = 0;

let ai;

export const geminiConfig = { provider: 'gemini', model: MODEL, fallbackModel: FALLBACK_MODEL, thinking: THINKING };

// Gemini 2.5 models take a token budget (0 = off); Gemini 3+ take a level.
function thinkingFor(model) {
  return model.startsWith('gemini-2.') ? { thinkingBudget: 0 } : { thinkingLevel: THINKING };
}

/** Stream from Gemini. Same contract as streamAnthropic. */
export async function streamGemini({ system, turns, signal, onDelta }) {
  if (Date.now() < primaryDownUntil && FALLBACK_MODEL !== MODEL) {
    return streamOnce(FALLBACK_MODEL, { system, turns, signal, onDelta });
  }
  try {
    return await streamOnce(MODEL, { system, turns, signal, onDelta });
  } catch (err) {
    // Only fall back if nothing was shown yet; a half-answer can't be restarted cleanly.
    if (err instanceof ApiError && RETRYABLE.has(err.status) && !err.partial && FALLBACK_MODEL !== MODEL) {
      primaryDownUntil = Date.now() + COOLDOWN_MS;
      console.warn(`[gemini] ${MODEL} returned ${err.status}; using ${FALLBACK_MODEL} for the next ${COOLDOWN_MS / 1000}s`);
      return streamOnce(FALLBACK_MODEL, { system, turns, signal, onDelta });
    }
    throw err;
  }
}

async function streamOnce(model, { system, turns, signal, onDelta }) {
  // v1beta: some models reject systemInstruction on v1.
  ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: 'v1beta' });
  let text = '';
  let firstTokenAt = null;
  let usage;
  try {
    const stream = await ai.models.generateContentStream({
      model,
      // Gemini names the assistant role "model".
      contents: turns.map((t) => ({
        role: t.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: t.text }],
      })),
      config: {
        systemInstruction: system,
        maxOutputTokens: 4000,
        thinkingConfig: thinkingFor(model),
        abortSignal: signal,
      },
    });
    for await (const chunk of stream) {
      if (signal.aborted) break;
      usage = chunk.usageMetadata ?? usage;
      const delta = chunk.text;
      if (delta) {
        firstTokenAt ??= Date.now();
        text += delta;
        onDelta(delta);
      }
    }
  } catch (err) {
    if (text) err.partial = true;
    throw err;
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!text) throw new Error('Gemini returned no answer (possibly blocked by safety filters).');
  // Gemini caches repeated prompt prefixes implicitly; this reports the hit.
  return { text, firstTokenAt, model, cachedInputTokens: usage?.cachedContentTokenCount ?? 0 };
}

export function describeGeminiError(err) {
  if (!process.env.GEMINI_API_KEY) return 'GEMINI_API_KEY is not set on the server.';
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Gemini rate limit / free-tier quota hit; wait a moment and try again.';
    // The SDK puts the JSON error body in `message`; surface Google's own explanation.
    // The body can be nested and escaped; the innermost "message" is Google's text.
    const all = [...err.message.matchAll(/\\?"message\\?":\s*\\?"([^"\\]+)/g)];
    const detail = all.length ? all[all.length - 1][1] : err.message;
    return `Gemini API error ${err.status}: ${detail}`;
  }
  return null;
}
