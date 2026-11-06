// Thin wrapper over Deepgram's live-transcription WebSocket.
// We speak the raw protocol with `ws` rather than the SDK: it is one URL, one header
// and three message types, and it keeps the moving parts visible.
import WebSocket from 'ws';

export const SAMPLE_RATE = 16000; // browser downsamples to 16 kHz mono PCM16

export function openDeepgram({ apiKey, model, endpointingMs, keyterms = [], onTranscript, onUtteranceEnd, onError, onClose }) {
  const params = new URLSearchParams({
    model,
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    channels: '1',
    interim_results: 'true',      // live partials for the UI
    smart_format: 'true',         // punctuation -> "?" helps question detection
    endpointing: String(endpointingMs), // silence before speech_final
    utterance_end_ms: '1000',     // word-gap based end signal, robust to background noise
    vad_events: 'true',
  });
  // Keyterm prompting (nova-3 only): boosts words like "React" that get misheard.
  if (model.startsWith('nova-3')) for (const term of keyterms) params.append('keyterm', term);
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  let audioBytesSent = 0;
  const queue = []; // audio that arrives before the socket is open
  // Deepgram closes idle streams after ~10s; KeepAlive covers pauses in the audio.
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 8000);

  ws.on('open', () => {
    console.log('[stt] Deepgram stream open');
    for (const chunk of queue.splice(0)) send(chunk);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      const text = alt?.transcript ?? '';
      // Where did the speech end, in stream time? Last word end if we have words.
      const words = alt?.words ?? [];
      const audioEndSec = words.length ? words[words.length - 1].end : msg.start + msg.duration;
      // Map stream time to wall clock: the audio we have sent so far is "now".
      const sentSec = audioBytesSent / 2 / SAMPLE_RATE;
      const speechEndAt = Date.now() - Math.max(0, (sentSec - audioEndSec) * 1000);
      onTranscript({
        text,
        isFinal: !!msg.is_final,
        speechFinal: !!msg.speech_final,
        fromFinalize: !!msg.from_finalize,
        speechEndAt,
      });
    } else if (msg.type === 'UtteranceEnd') {
      onUtteranceEnd();
    } else if (msg.type === 'Error' || msg.err_code) {
      onError(new Error(msg.description || msg.err_msg || 'Deepgram error'));
    }
  });

  ws.on('unexpected-response', (_req, res) => {
    onError(new Error(`Deepgram rejected the connection (HTTP ${res.statusCode}). Check DEEPGRAM_API_KEY.`));
  });
  ws.on('error', (err) => onError(err));
  ws.on('close', (code, reason) => {
    clearInterval(keepAlive);
    onClose?.(code, reason.toString());
  });

  function send(chunk) {
    audioBytesSent += chunk.length;
    ws.send(chunk);
  }

  return {
    sendAudio(chunk) {
      if (ws.readyState === WebSocket.OPEN) send(chunk);
      else if (ws.readyState === WebSocket.CONNECTING) queue.push(chunk);
    },
    /** Ask Deepgram to finalize buffered audio now (used when endpointing misses a pause). */
    finalize() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Finalize' }));
    },
    close() {
      clearInterval(keepAlive);
      if (ws.readyState === WebSocket.OPEN) {
        // Ask Deepgram to flush remaining results, then close.
        ws.send(JSON.stringify({ type: 'CloseStream' }));
        setTimeout(() => ws.close(), 1500);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    },
  };
}
