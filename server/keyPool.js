// API key rotation: each provider can take several keys (GEMINI_API_KEYS=k1,k2,...).
// Requests go round-robin across the keys; a key that hits a rate limit / quota (429) or
// is rejected (401/403) is benched for a while and the request retries on the next key.
// Free tiers are per key (per project for Gemini), so N keys ~ N times the quota.
//
// Cooldowns are tracked per scope (Gemini: per model, since its quotas are per model),
// so a key exhausted on one model is still used for another.

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const DAILY_QUOTA_COOLDOWN_MS = 60 * 60_000;
const BAD_KEY_COOLDOWN_MS = 60 * 60_000; // a rejected key won't fix itself; restart to retry

/** Keys from NAME_API_KEYS (comma/space/newline separated) plus NAME_API_KEY, de-duplicated. */
export function readKeys(prefix, env = process.env) {
  const raw = `${env[`${prefix}_API_KEYS`] ?? ''},${env[`${prefix}_API_KEY`] ?? ''}`;
  return [...new Set(raw.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean))];
}

export class KeyPool {
  /**
   * @param {string} name  provider name, for logs
   * @param {string[]} keys
   * @param {(err) => number|null} classify  how long to bench a key after this error
   *   (ms), or null if the error has nothing to do with the key (don't rotate)
   */
  constructor(name, keys, classify = defaultClassify) {
    this.name = name;
    this.keys = keys;
    this.classify = classify;
    this.next = 0;
    this.benchedUntil = new Map(); // `${scope}|${index}` -> timestamp
  }

  get size() {
    return this.keys.length;
  }

  /** Keys not benched for this scope, starting at the round-robin cursor. */
  available(scope = '', now = Date.now()) {
    const out = [];
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.next + i) % this.keys.length;
      if ((this.benchedUntil.get(`${scope}|${idx}`) ?? 0) <= now) out.push(idx);
    }
    return out;
  }

  bench(scope, idx, ms, reason) {
    this.benchedUntil.set(`${scope}|${idx}`, Date.now() + ms);
    console.warn(`[keys] ${this.name} key ${idx + 1}/${this.size}${scope ? ` (${scope})` : ''}: ${reason}; benched ${Math.round(ms / 1000)}s`);
  }

  /**
   * Run fn(key) on the next available key; on a key-related error, bench that key and
   * retry on the next one. Never retries once text was streamed (err.partial).
   * If every key is benched, tries them all anyway (soonest-to-recover first) unless
   * `skipIfAllBenched` is set, in which case it throws an AllKeysBenchedError.
   */
  async run(fn, { scope = '', skipIfAllBenched = false } = {}) {
    if (!this.size) throw new MissingKeyError(this.name);
    let order = this.available(scope);
    if (!order.length) {
      if (skipIfAllBenched) throw new AllKeysBenchedError(this.name, scope);
      order = this.keys
        .map((_, idx) => idx)
        .sort((a, b) => (this.benchedUntil.get(`${scope}|${a}`) ?? 0) - (this.benchedUntil.get(`${scope}|${b}`) ?? 0));
    }
    // Advance the cursor so consecutive requests spread across keys.
    this.next = (order[0] + 1) % this.size;

    let lastErr;
    for (const idx of order) {
      try {
        return await fn(this.keys[idx], idx);
      } catch (err) {
        // Report a rate limit over a bad key: "add keys / wait" is the more useful message.
        if (!lastErr || lastErr.status !== 429) lastErr = err;
        const benchMs = err?.partial ? null : this.classify(err);
        if (benchMs == null) throw err;
        this.bench(scope, idx, benchMs, `HTTP ${err.status ?? '?'}`);
      }
    }
    throw lastErr;
  }
}

/** 429 = rate limit/quota, 401/403 = bad or revoked key. Anything else is not the key's fault. */
export function defaultClassify(err) {
  const status = err?.status;
  if (status === 429) return rateLimitCooldown(err);
  if (status === 401 || status === 403) return BAD_KEY_COOLDOWN_MS;
  return null;
}

// How long a rate-limited key sits out. Retrying an exhausted key costs a failed round
// trip (1-2 s) on the next question, so honour the provider's own hint:
//   - Retry-After header (Anthropic, Groq)
//   - Gemini's "retryDelay": "37s" in the error body
//   - a per-day quota (Gemini "...PerDay...") won't reset soon: an hour
function rateLimitCooldown(err) {
  const msg = String(err?.message ?? '');
  if (/per ?day|daily/i.test(msg)) return DAILY_QUOTA_COOLDOWN_MS;
  const header = err?.headers?.get?.('retry-after') ?? err?.headers?.['retry-after'];
  const delay = Number(header) || Number(msg.match(/retryDelay\\?"?:\s*\\?"(\d+(?:\.\d+)?)s/)?.[1]);
  if (delay > 0) return Math.min(Math.max(delay * 1000, 5_000), DAILY_QUOTA_COOLDOWN_MS);
  return RATE_LIMIT_COOLDOWN_MS;
}

export class MissingKeyError extends Error {
  constructor(name) {
    super(`No ${name} API key set.`);
    this.name = 'MissingKeyError';
  }
}

export class AllKeysBenchedError extends Error {
  constructor(name, scope) {
    super(`All ${name} keys are cooling down after rate limits or rejections${scope ? ` (${scope})` : ''}.`);
    this.name = 'AllKeysBenchedError';
    this.status = 429;
  }
}
