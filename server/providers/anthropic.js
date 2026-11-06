import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANSWER_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.ANSWER_EFFORT || 'low';

let client;

export const anthropicConfig = { provider: 'anthropic', model: MODEL, effort: EFFORT };

/** Stream from Claude. `system` is the full system prompt, `turns` alternate user/assistant. */
export async function streamAnthropic({ system, turns, signal, onDelta }) {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY
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
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      firstTokenAt ??= Date.now();
      text += event.delta.text;
      onDelta(event.delta.text);
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    throw new Error('The model declined to answer this question.');
  }
  return { text, firstTokenAt, cachedInputTokens: final.usage?.cache_read_input_tokens ?? 0 };
}

export function isAbort(err) {
  return err instanceof Anthropic.APIUserAbortError;
}

export function describeAnthropicError(err) {
  if (!process.env.ANTHROPIC_API_KEY && !(err instanceof Anthropic.APIError)) {
    return 'ANTHROPIC_API_KEY is not set on the server.';
  }
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic API key is missing or invalid (ANTHROPIC_API_KEY).';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit hit; wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return null;
}
