import Anthropic from '@anthropic-ai/sdk';
import { KeyPool, readKeys } from '../keyPool.js';

const MODEL = process.env.ANSWER_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.ANSWER_EFFORT || 'low';

let pool;
const clients = new Map(); // api key -> Anthropic client

export const anthropicConfig = { provider: 'anthropic', model: MODEL, effort: EFFORT };

/**
 * Stream from Claude. `system` is the full system prompt, `turns` alternate user/assistant.
 * Rotates across ANTHROPIC_API_KEYS on rate limits / bad keys.
 */
export async function streamAnthropic(args) {
  pool ??= new KeyPool('anthropic', readKeys('ANTHROPIC'));
  return pool.run((key) => streamOnce(key, args), { skipIfAllBenched: args.skipIfAllBenched });
}

async function streamOnce(apiKey, { system, turns, signal, onDelta }) {
  if (!clients.has(apiKey)) {
    // Key rotation and the provider fallback chain do the retrying: the SDK's own
    // retry-with-backoff on the same key would add seconds before either kicks in.
    clients.set(apiKey, new Anthropic({ apiKey, maxRetries: 0 }));
  }
  const client = clients.get(apiKey);
  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 4000,
      // Low effort keeps adaptive thinking short; the answers are deliberately simple.
      output_config: { effort: EFFORT },
      // If a safety classifier declines, the API retries on a suitable model in-call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        {
          type: 'text',
          text: system,
          // Resume + JD are identical for every question in a session: cache them so
          // later questions skip re-processing that prefix (lower time to first token).
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: turns.map((t) => ({ role: t.role, content: t.text })),
    },
    { signal },
  );

  let text = '';
  let firstTokenAt = null;
  let final;
  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        firstTokenAt ??= Date.now();
        text += event.delta.text;
        onDelta(event.delta.text);
      }
    }
    final = await stream.finalMessage();
  } catch (err) {
    if (text) err.partial = true;
    throw err;
  }
  if (final.stop_reason === 'refusal') {
    throw new Error('The model declined to answer this question.');
  }
  return { text, firstTokenAt, model: final.model, cachedInputTokens: final.usage?.cache_read_input_tokens ?? 0 };
}

export function isAbort(err) {
  return err instanceof Anthropic.APIUserAbortError;
}

export function describeAnthropicError(err) {
  if (!readKeys('ANTHROPIC').length) return 'ANTHROPIC_API_KEY (or ANTHROPIC_API_KEYS) is not set on the server.';
  if (err instanceof Anthropic.AuthenticationError) return 'Every Anthropic API key is missing or invalid (ANTHROPIC_API_KEYS).';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit hit on every key; wait a moment or add more keys.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return null;
}
