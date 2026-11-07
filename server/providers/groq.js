import Groq from 'groq-sdk';
import { KeyPool, readKeys } from '../keyPool.js';

// Groq serves open models on custom hardware: very low time to first token.
// Measured on a free key (2 runs each): gpt-oss-120b at reasoning "low" 0.4-0.7 s TTFT,
// qwen3.8-27b at "none" 0.2-0.4 s, gpt-oss-20b 1.3-2.1 s. llama-3.3-70b is retired.
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
// Reasoning models think before answering; keep it minimal and hide the reasoning text.
// gpt-oss takes low|medium|high, Qwen takes none|default. Other models: no reasoning params.
const REASONING = process.env.GROQ_REASONING || (MODEL.startsWith('openai/gpt-oss') ? 'low' : MODEL.startsWith('qwen/') ? 'none' : '');

function reasoningParams() {
  if (!REASONING) return {};
  if (MODEL.startsWith('openai/gpt-oss')) return { reasoning_effort: REASONING, include_reasoning: false };
  return { reasoning_effort: REASONING };
}

let pool;
const clients = new Map(); // api key -> Groq client

export const groqConfig = { provider: 'groq', model: MODEL, reasoning: REASONING || undefined };

/** Stream from Groq. Same contract as streamAnthropic; rotates across GROQ_API_KEYS. */
export async function streamGroq(args) {
  pool ??= new KeyPool('groq', readKeys('GROQ'));
  return pool.run((key) => streamOnce(key, args), { skipIfAllBenched: args.skipIfAllBenched });
}

async function streamOnce(apiKey, { system, turns, signal, onDelta }) {
  if (!clients.has(apiKey)) {
    // Key rotation and the provider fallback chain do the retrying: the SDK's own
    // retry-with-backoff on the same key would add seconds before either kicks in.
    clients.set(apiKey, new Groq({ apiKey, maxRetries: 0 }));
  }
  const client = clients.get(apiKey);
  let text = '';
  let firstTokenAt = null;
  let cachedInputTokens = 0;
  try {
    const stream = await client.chat.completions.create(
      {
        model: MODEL,
        max_completion_tokens: 2000, // room for a code answer
        stream: true,
        ...reasoningParams(),
        messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))],
      },
      { signal },
    );
    for await (const chunk of stream) {
      cachedInputTokens = chunk.x_groq?.usage?.prompt_tokens_details?.cached_tokens ?? cachedInputTokens;
      const delta = chunk.choices[0]?.delta?.content;
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
  if (!text) throw new Error('Groq returned no answer.');
  return { text, firstTokenAt, model: MODEL, cachedInputTokens };
}

export function describeGroqError(err) {
  if (!readKeys('GROQ').length) return 'GROQ_API_KEY (or GROQ_API_KEYS) is not set on the server.';
  if (err instanceof Groq.AuthenticationError) return 'Every Groq API key is missing or invalid (GROQ_API_KEYS).';
  if (err instanceof Groq.RateLimitError) return 'Groq rate limit hit on every key; wait a moment or add more keys.';
  if (err instanceof Groq.APIConnectionError) return 'Could not reach the Groq API.';
  if (err instanceof Groq.APIError) return `Groq API error ${err.status}: ${err.error?.error?.message ?? err.message}`;
  return null;
}
