// Replays a 16 kHz mono PCM16 WAV through the running server in real time and prints
// transcripts, detected questions, answers and latency metrics.
// Usage: node scripts/replay.mjs path/to/audio.wav [ws://localhost:3010/ws]
// Make a clip on macOS:
//   say -o q.aiff "Tell me about yourself." && afconvert -f WAVE -d LEI16@16000 -c 1 q.aiff q.wav
import WebSocket from 'ws';
import fs from 'node:fs';
const wav = fs.readFileSync(process.argv[2]);
const pcm = wav.subarray(wav.indexOf('data') + 8); // skip WAV header
const ws = new WebSocket(process.argv[3] || 'ws://localhost:3010/ws');
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
let ans = '';
ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'start', context: { resume: 'Priya Sharma. Backend engineer, 4 years. Node.js, Redis, AWS. Built payments reconciliation service at Finlytics (2M tx/day).', jobDescription: 'Senior Backend Engineer, fintech.' } }));
  for (let off = 0; off < pcm.length; off += 3200) { // 100 ms chunks, real time
    ws.send(pcm.subarray(off, off + 3200));
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 4000));
  ws.send(JSON.stringify({ type: 'stop' })); setTimeout(() => process.exit(0), 500);
});
ws.on('message', (d) => { const m = JSON.parse(d);
  if (m.type === 'transcript' && m.isFinal) console.log(ts(), 'FINAL', m.speechFinal ? '(speech_final)' : '', m.text);
  else if (m.type === 'status') console.log(ts(), 'STATUS', m.state, m.detail || '');
  else if (m.type === 'skipped') console.log(ts(), 'SKIPPED', m.kind, '-', m.text);
  else if (m.type === 'question') { console.log(ts(), 'QUESTION', m.text, `[${m.reason}]`); ans = ''; }
  else if (m.type === 'answer_delta') ans += m.text;
  else if (m.type === 'answer_done') console.log(ts(), 'ANSWER\n' + ans + '\n       METRICS', JSON.stringify(m.metrics));
  else if (m.type === 'error') console.log(ts(), 'ERROR', m.message);
});
