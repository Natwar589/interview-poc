// Provider fallback: LLM_PROVIDER=gemini,anthropic,groq tries Gemini first; if it fails
// before any answer text appears (every key out of quota, overloaded, bad keys, ...),
// the same question goes to Anthropic, then to Groq.
//
// Each provider first rotates through its own keys (keyPool.js). A provider whose keys
// are all benched is skipped instantly instead of costing a doomed request, except the
// last one in the chain, which is always tried (its keys may have recovered).

/**
 * @param {{ name: string, stream: Function, describe: Function }[]} chain
 * @param {object} args  passed to each provider's stream()
 * @returns provider result + { provider }
 */
export async function streamChain(chain, args) {
  const failures = [];
  for (const [i, p] of chain.entries()) {
    const isLast = i === chain.length - 1;
    try {
      const result = await p.stream({ ...args, skipIfAllBenched: !isLast });
      if (failures.length) console.warn(`[llm] answered by ${p.name} after: ${failures.map((f) => f.name).join(', ')}`);
      return { ...result, provider: p.name };
    } catch (err) {
      // Cancelled, or text already on screen: a different provider can't continue it.
      if (args.signal?.aborted || err?.name === 'AbortError' || err?.partial) throw err;
      const reason = p.describe(err) || err?.message || String(err);
      failures.push({ name: p.name, reason, err });
      if (!isLast) console.warn(`[llm] ${p.name} failed (${reason}); trying ${chain[i + 1].name}`);
    }
  }
  if (failures.length === 1) throw failures[0].err;
  const err = new Error(`All providers failed. ${failures.map((f) => `${f.name}: ${f.reason}`).join(' | ')}`);
  err.chainFailure = true;
  throw err;
}

/** "gemini, anthropic,groq" -> ['gemini','anthropic','groq'] (lowercased, de-duplicated). */
export function parseChain(value = 'gemini') {
  return [...new Set(value.toLowerCase().split(/[\s,>]+/).filter(Boolean))];
}
