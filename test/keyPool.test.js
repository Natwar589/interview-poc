import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool, readKeys, AllKeysBenchedError, MissingKeyError, defaultClassify } from '../server/keyPool.js';

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const quiet = () => {
  const warn = console.warn;
  console.warn = () => {};
  return () => (console.warn = warn);
};

test('reads plural and singular env vars, de-duplicated', () => {
  const env = { GROQ_API_KEYS: 'a, b\nc', GROQ_API_KEY: 'b' };
  assert.deepEqual(readKeys('GROQ', env), ['a', 'b', 'c']);
  assert.deepEqual(readKeys('GROQ', { GROQ_API_KEY: 'x' }), ['x']);
  assert.deepEqual(readKeys('GROQ', {}), []);
});

test('spreads requests round-robin across keys', async () => {
  const pool = new KeyPool('t', ['a', 'b', 'c']);
  const used = [];
  for (let i = 0; i < 4; i++) await pool.run(async (k) => used.push(k));
  assert.deepEqual(used, ['a', 'b', 'c', 'a']);
});

test('a 429 benches the key and retries on the next one', async () => {
  const restore = quiet();
  const pool = new KeyPool('t', ['a', 'b']);
  const used = [];
  const result = await pool.run(async (k) => {
    used.push(k);
    if (k === 'a') throw httpError(429);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(used, ['a', 'b']);
  assert.deepEqual(pool.available().map((i) => pool.keys[i]), ['b']); // a is benched
  restore();
});

test('errors unrelated to the key are not retried', async () => {
  const pool = new KeyPool('t', ['a', 'b']);
  let calls = 0;
  await assert.rejects(pool.run(async () => { calls++; throw httpError(503); }), /503/);
  assert.equal(calls, 1);
});

test('never retries once text was streamed', async () => {
  const pool = new KeyPool('t', ['a', 'b']);
  let calls = 0;
  const err = Object.assign(httpError(429), { partial: true });
  await assert.rejects(pool.run(async () => { calls++; throw err; }));
  assert.equal(calls, 1);
});

test('cooldowns are per scope (Gemini: per model)', async () => {
  const restore = quiet();
  const pool = new KeyPool('t', ['a']);
  await assert.rejects(pool.run(async () => { throw httpError(429); }, { scope: 'lite' }));
  await assert.rejects(pool.run(async () => 'x', { scope: 'lite', skipIfAllBenched: true }), AllKeysBenchedError);
  assert.equal(await pool.run(async () => 'flash', { scope: 'flash' }), 'flash');
  // Without skipIfAllBenched a benched key is still tried (it may have recovered).
  assert.equal(await pool.run(async () => 'retry', { scope: 'lite' }), 'retry');
  restore();
});

test('no keys -> clear error', async () => {
  await assert.rejects(new KeyPool('groq', []).run(async () => 1), MissingKeyError);
});

test('rate-limit bench follows the provider hint', () => {
  const e = (message, headers) => Object.assign(new Error(message), { status: 429, headers });
  assert.equal(defaultClassify(e('quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier')), 3_600_000);
  assert.equal(defaultClassify(e('"retryDelay":"37s"')), 37_000);
  assert.equal(defaultClassify(e('slow down', { 'retry-after': '12' })), 12_000);
  assert.equal(defaultClassify(e('slow down')), 60_000);
  assert.equal(defaultClassify({ status: 503 }), null);
});
