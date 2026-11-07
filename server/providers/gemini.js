import { GoogleGenAI, ApiError } from '@google/genai';
import { KeyPool, readKeys, AllKeysBenchedError, defaultClassify } from '../keyPool.js';

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

let pool;
const clients = new Map(); // api key -> GoogleGenAI

export const geminiConfig = { provider: 'gemini', model: MODEL, fallbackModel: FALLBACK_MODEL, thinking: THINKING };

// Gemini 2.5 models take a token budget (0 = off); Gemini 3+ take a level.
function thinkingFor(model) {
  return model.startsWith('gemini-2.') ? { thinkingBudget: 0 } : { thinkingLevel: THINKING };
}

/**
 * Stream from Gemini. Same contract as streamAnthropic.
 * Tries the main model on each key in turn (GEMINI_API_KEYS), then the fallback model.
 */
export async function streamGemini({ system, turns, signal, onDelta, skipIfAllBenched = false }) {
  pool ??= new KeyPool('gemini', readKeys('GEMINI'), classifyGeminiError);
  const models = FALLBACK_MODEL !== MODEL ? [MODEL, FALLBACK_MODEL] : [MODEL];
  for (const [i, model] of models.entries()) {
    const isLast = i === models.length - 1;
    if (!isLast && Date.now() < primaryDownUntil) continue;
    try {
      return await pool.run((key) => streamOnce(model, key, { system, turns, signal, onDelta }), {
        scope: model,
        // Every key is rate-limited on the main model: go straight to the fallback model
        // (and on the fallback model, to the next provider when there is one).
        skipIfAllBenched: !isLast || skipIfAllBenched,
      });
    } catch (err) {
      // Only fall back if nothing was shown yet; a half-answer can't be restarted cleanly.
      const retryable = err instanceof AllKeysBenchedError || (err instanceof ApiError && RETRYABLE.has(err.status));
      if (isLast || err.partial || !retryable) throw err;
      if (!(err instanceof AllKeysBenchedError)) primaryDownUntil = Date.now() + COOLDOWN_MS;
      console.warn(`[gemini] ${model}: ${err.status ?? ''} ${err instanceof AllKeysBenchedError ? 'all keys rate-limited' : 'failed'}; using ${FALLBACK_MODEL}`);
    }
  }
}

// Gemini reports an invalid key as 400 API_KEY_INVALID rather than 401.
function classifyGeminiError(err) {
  if (err?.status === 400 && /API_KEY_INVALID|API key not valid/.test(err.message)) return defaultClassify({ status: 401 });
  return defaultClassify(err);
}

async function streamOnce(model, apiKey, { system, turns, signal, onDelta }) {
  // v1beta: some models reject systemInstruction on v1.
  if (!clients.has(apiKey)) clients.set(apiKey, new GoogleGenAI({ apiKey, apiVersion: 'v1beta' }));
  const ai = clients.get(apiKey);
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
  if (!readKeys('GEMINI').length) return 'GEMINI_API_KEY (or GEMINI_API_KEYS) is not set on the server.';
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Gemini rate limit / free-tier quota hit on every key; wait a moment or add more keys to GEMINI_API_KEYS.';
    // The SDK puts the JSON error body in `message`; surface Google's own explanation.
    // The body can be nested and escaped; the innermost "message" is Google's text.
    const all = [...err.message.matchAll(/\\?"message\\?":\s*\\?"([^"\\]+)/g)];
    const detail = all.length ? all[all.length - 1][1] : err.message;
    return `Gemini API error ${err.status}: ${detail}`;
  }
  return null;
}
