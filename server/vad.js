// Energy-based voice activity detection on the incoming PCM16 stream.
//
// Deepgram's endpointing sometimes misses a pause, and the interim-text backup needs
// ~1s+ of repeated results. This is faster: measure loudness of each chunk ourselves
// and call onSilence once `silenceMs` (default 600) of quiet follows speech. The caller then sends
// Deepgram `Finalize`, which flushes the transcript immediately.
//
// Loudness threshold adapts to the source: tab audio, a quiet mic and a noisy room
// all have different floors, so "voice" = RMS well above a running noise-floor estimate.

const SAMPLE_RATE = 16000;
const MIN_THRESHOLD = 300;  // RMS out of 32768 (~ -40 dBFS): never call quieter than this voice
const FLOOR_RATIO = 3;      // voice must be ~10 dB above the noise floor
const MIN_VOICE_MS = 200;   // ignore clicks/coughs shorter than this

export function rms(chunk) {
  const n = Math.floor(chunk.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = chunk.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

export class EnergyVad {
  constructor({ silenceMs = 600, onSilence }) {
    this.silenceMs = silenceMs;
    this.onSilence = onSilence;
    this.noiseFloor = MIN_THRESHOLD / FLOOR_RATIO;
    this.voiceMs = 0;   // voiced audio since the last onSilence
    this.quietMs = 0;   // consecutive quiet audio
  }

  get threshold() {
    return Math.max(MIN_THRESHOLD, this.noiseFloor * FLOOR_RATIO);
  }

  /** Feed one PCM16 mono 16 kHz chunk (Buffer). Time is audio time, not wall time. */
  push(chunk) {
    const ms = (chunk.length / 2 / SAMPLE_RATE) * 1000;
    const level = rms(chunk);
    const voiced = level >= this.threshold;

    // Noise floor: drops fast on quieter audio, creeps up slowly (~10s) otherwise.
    // The slow rise lets a constant loud background become "floor" even if it was
    // there from the first chunk; normal speech has gaps that pull the floor back down.
    const alpha = level < this.noiseFloor ? 0.3 : ms / 10000;
    this.noiseFloor += (level - this.noiseFloor) * alpha;

    if (voiced) {
      this.voiceMs += ms;
      this.quietMs = 0;
      return;
    }
    this.quietMs += ms;
    if (this.voiceMs >= MIN_VOICE_MS && this.quietMs >= this.silenceMs) {
      this.voiceMs = 0;
      this.onSilence();
    }
  }
}
