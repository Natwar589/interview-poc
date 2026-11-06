import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyVad, rms } from '../server/vad.js';

// 100 ms of 16 kHz PCM16: a tone at `amp`, plus optional noise.
function chunk(amp, noise = 0) {
  const buf = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) {
    const v = amp * Math.sin((2 * Math.PI * 220 * i) / 16000) + (Math.random() - 0.5) * 2 * noise;
    buf.writeInt16LE(Math.round(v), i * 2);
  }
  return buf;
}

test('rms of a sine is amplitude / sqrt(2)', () => {
  assert.ok(Math.abs(rms(chunk(10000)) - 7071) < 50);
});

test('fires once after speech followed by 400 ms of quiet', () => {
  let fired = 0;
  const vad = new EnergyVad({ silenceMs: 400, onSilence: () => fired++ });
  for (let i = 0; i < 10; i++) vad.push(chunk(8000)); // 1 s speech
  for (let i = 0; i < 3; i++) vad.push(chunk(0, 20));  // 300 ms quiet: not yet
  assert.equal(fired, 0);
  vad.push(chunk(0, 20));                              // 400 ms
  assert.equal(fired, 1);
  for (let i = 0; i < 20; i++) vad.push(chunk(0, 20)); // long silence: no repeats
  assert.equal(fired, 1);
});

test('short gaps between words do not fire', () => {
  let fired = 0;
  const vad = new EnergyVad({ silenceMs: 400, onSilence: () => fired++ });
  for (let i = 0; i < 5; i++) {
    vad.push(chunk(8000)); vad.push(chunk(8000));
    vad.push(chunk(0, 20)); vad.push(chunk(0, 20)); // 200 ms gap
  }
  assert.equal(fired, 0);
});

test('a click shorter than the minimum voice length is ignored', () => {
  let fired = 0;
  const vad = new EnergyVad({ silenceMs: 400, onSilence: () => fired++ });
  vad.push(chunk(8000)); // 100 ms
  for (let i = 0; i < 10; i++) vad.push(chunk(0, 20));
  assert.equal(fired, 0);
});

test('adapts to a steady background noise floor', () => {
  let fired = 0;
  const vad = new EnergyVad({ silenceMs: 400, onSilence: () => fired++ });
  // Loud constant background (~RMS 700) from the start: it reads as voice until the
  // floor catches up (~3 s), which may trigger one harmless Finalize. After that,
  // the background must count as quiet.
  for (let i = 0; i < 100; i++) vad.push(chunk(0, 1200));
  fired = 0;
  for (let i = 0; i < 10; i++) vad.push(chunk(9000, 1200)); // speech over the noise
  for (let i = 0; i < 5; i++) vad.push(chunk(0, 1200));    // back to just noise
  assert.equal(fired, 1);
});
