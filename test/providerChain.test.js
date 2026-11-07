import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamChain, parseChain } from '../server/providerChain.js';

const quiet = () => {
  const warn = console.warn;
  console.warn = () => {};
  return () => (console.warn = warn);
};
const ok = (name) => ({ name, describe: () => null, stream: async () => ({ text: `from ${name}` }) });
const failing = (name, err = Object.assign(new Error('quota'), { status: 429 })) => ({
  name,
  describe: (e) => `${name} said ${e.message}`,
  stream: async () => { throw err; },
});
const args = () => ({ signal: new AbortController().signal });

test('parses the provider list', () => {
  assert.deepEqual(parseChain('Gemini, anthropic,groq,gemini'), ['gemini', 'anthropic', 'groq']);
  assert.deepEqual(parseChain('gemini > groq'), ['gemini', 'groq']);
});

test('uses the first provider when it works', async () => {
  const r = await streamChain([ok('gemini'), ok('anthropic')], args());
  assert.equal(r.provider, 'gemini');
});

test('falls through gemini -> anthropic -> groq', async () => {
  const restore = quiet();
  const r = await streamChain([failing('gemini'), failing('anthropic'), ok('groq')], args());
  assert.equal(r.provider, 'groq');
  assert.equal(r.text, 'from groq');
  restore();
});

test('only the last provider is forced to try benched keys', async () => {
  const restore = quiet();
  const seen = [];
  const spy = (name) => ({ name, describe: () => null, stream: async (a) => { seen.push(a.skipIfAllBenched); throw new Error('x'); } });
  await assert.rejects(streamChain([spy('a'), spy('b'), spy('c')], args()));
  assert.deepEqual(seen, [true, true, false]);
  restore();
});

test('does not switch provider once text was shown, or after cancel', async () => {
  const partial = Object.assign(new Error('cut'), { partial: true });
  await assert.rejects(streamChain([failing('gemini', partial), ok('groq')], args()), /cut/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(streamChain([failing('gemini'), ok('groq')], { signal: ac.signal }), /quota/);
});

test('reports every provider when all fail', async () => {
  const restore = quiet();
  await assert.rejects(streamChain([failing('gemini'), failing('groq')], args()), (err) => {
    assert.ok(err.chainFailure);
    assert.match(err.message, /gemini: gemini said quota \| groq: groq said quota/);
    return true;
  });
  restore();
});
