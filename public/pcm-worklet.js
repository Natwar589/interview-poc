// AudioWorklet: downsample the capture stream (usually 48 kHz float32) to 16 kHz
// mono PCM16 and post ~100 ms chunks to the main thread.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz: small enough for low latency, few frames/sec

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
    this.pos = 0; // fractional read position carried across render quanta
    this.acc = 0;
    this.accCount = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channels = input.length;
    const frames = input[0].length;

    for (let i = 0; i < frames; i++) {
      // Mix down to mono.
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      // Box-filter decimation: average the samples that fall into each output slot.
      this.acc += s / channels;
      this.accCount++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.accCount));
        this.out[this.outLen++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.acc = 0;
        this.accCount = 0;
        if (this.outLen === CHUNK_SAMPLES) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(CHUNK_SAMPLES);
          this.outLen = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
