import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { openDeepgram } from './deepgram.js';
import { QuestionDetector } from './questionDetector.js';
import { EnergyVad, rms } from './vad.js';
import { buildKeyterms } from './keyterms.js';
import { streamAnswer, describeError, answerConfig, isAbortError } from './answer.js';

const PORT = Number(process.env.PORT) || 3000;
const MAX_CONTEXT_CHARS = 20000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(ROOT, '..', 'public')));
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    deepgram: !!process.env.DEEPGRAM_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    mock: process.env.MOCK_LLM === '1',
    ...answerConfig,
  }),
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });

// One Session per browser connection. Protocol:
//   client -> server: binary frames = PCM16 16kHz mono audio
//                     JSON {type:'start', context} | {type:'stop'} | {type:'ask', text} | {type:'context', context}
//   server -> client: JSON {type:'status'|'transcript'|'question'|'skipped'|'answer_delta'|'answer_done'|'error', ...}
class Session {
  constructor(ws) {
    this.ws = ws;
    this.context = { resume: '', jobDescription: '' };
    this.history = []; // [{question, answer}] conversation memory
    this.stt = null;
    this.detector = null;
    this.vad = null;
    this.current = null; // { id, abort }
    this.nextId = 1;
    this.audioBytes = 0;
    this.lastInterim = '';
  }

  send(msg) {
    if (msg.type === 'error') console.warn(`[error] ${msg.message}`);
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  status(state, detail) {
    this.send({ type: 'status', state, detail });
  }

  setContext(ctx = {}) {
    this.context = {
      resume: String(ctx.resume ?? '').slice(0, MAX_CONTEXT_CHARS),
      jobDescription: String(ctx.jobDescription ?? '').slice(0, MAX_CONTEXT_CHARS),
    };
  }

  start(ctx) {
    this.setContext(ctx);
    if (this.stt) return;
    this.audioBytes = 0;
    this.peakLevel = 0;
    this.finals = 0;
    console.log(`[start] resume ${this.context.resume.length} chars, JD ${this.context.jobDescription.length} chars`);
    if (!process.env.DEEPGRAM_API_KEY) {
      this.send({ type: 'error', message: 'DEEPGRAM_API_KEY is not set on the server.' });
      return;
    }
    this.detector = new QuestionDetector({
      holdMs: Number(process.env.QUESTION_HOLD_MS) || 900,
      onQuestion: (q) => this.answer(q),
      onSkipped: (s) => {
        console.log(`[skip] ${s.kind}: "${s.text}"`);
        this.send({ type: 'skipped', ...s });
      },
    });
    // Terms from the resume/JD are fixed for this stream; editing the context mid-session
    // updates answers immediately but transcription only on the next Start.
    const keyterms = buildKeyterms(this.context);
    console.log(`[stt] ${keyterms.length} key terms: ${keyterms.slice(0, 12).join(', ')}${keyterms.length > 12 ? ', …' : ''}`);
    this.stt = openDeepgram({
      apiKey: process.env.DEEPGRAM_API_KEY,
      model: process.env.DEEPGRAM_MODEL || 'nova-3',
      keyterms,
      endpointingMs: Number(process.env.DEEPGRAM_ENDPOINTING_MS) || 300,
      onTranscript: ({ text, isFinal, speechFinal, fromFinalize, speechEndAt }) => {
        if (isFinal && text) {
          this.finals++;
          console.log(`[stt] ${text}`);
        }
        // A forced finalize means we already saw a pause, so treat it like speech_final.
        const pause = speechFinal || fromFinalize;
        if (text) this.send({ type: 'transcript', text, isFinal, speechFinal: pause });
        if (isFinal) {
          this.lastInterim = '';
          this.detector?.onFinal(text, { speechFinal: pause, speechEndAt });
        } else {
          // Second backup (e.g. noisy audio where the VAD never hears quiet): Deepgram
          // re-sends the same interim text when no new words arrived for ~1s.
          if (text && text === this.lastInterim) this.stt?.finalize();
          this.lastInterim = text;
          this.detector?.onInterim(text);
        }
      },
      onUtteranceEnd: () => this.detector?.onUtteranceEnd(),
      onError: (err) => {
        this.send({ type: 'error', message: `Speech-to-text: ${err.message}` });
        this.stopListening();
      },
      onClose: (code, reason) => {
        console.log(`[stt] Deepgram stream closed (code ${code}${reason ? `, ${reason}` : ''})`);
        if (this.stt) {
          this.stt = null;
          this.status('idle', 'transcription stream closed');
        }
      },
    });
    // Our own pause detector: on ~600ms of quiet after speech, make Deepgram finalize
    // right away instead of waiting on its endpointing (which can miss pauses).
    this.vad = new EnergyVad({
      silenceMs: Number(process.env.VAD_SILENCE_MS) || 600,
      onSilence: () => this.stt?.finalize(),
    });
    this.status('listening');
  }

  stopListening() {
    const stt = this.stt;
    this.stt = null;
    stt?.close();
    this.detector?.dispose();
    this.detector = null;
    this.vad = null;
  }

  stop() {
    if (this.stt) {
      // Peak RMS tells silent capture (~0) apart from real audio (speech is ~1000+).
      console.log(
        `[stop] received ${(this.audioBytes / 32000).toFixed(1)}s of audio, ` +
          `peak level ${Math.round(this.peakLevel)} of 32768, ${this.finals} final transcripts`,
      );
    }
    this.stopListening();
    this.current?.abort.abort();
    this.status('idle');
  }

  audio(chunk) {
    // Log once so a silent capture (no audio frames at all) is easy to spot.
    if (this.audioBytes === 0) console.log('[audio] first audio chunk received');
    this.audioBytes += chunk.length;
    this.peakLevel = Math.max(this.peakLevel, rms(chunk));
    this.stt?.sendAudio(chunk);
    this.vad?.push(chunk);
  }

  async answer({ text, preamble = '', reason, speechEndAt, detectedAt = Date.now() }) {
    // A new question supersedes the one being answered.
    this.current?.abort.abort();
    const id = this.nextId++;
    const abort = new AbortController();
    this.current = { id, abort };

    this.send({ type: 'question', id, text, reason, preamble });
    this.status('thinking');
    const requestAt = Date.now();
    let answerStarted = false;
    try {
      const result = await streamAnswer({
        question: text,
        preamble,
        context: this.context,
        history: this.history,
        signal: abort.signal,
        onDelta: (delta) => {
          if (!answerStarted) {
            answerStarted = true;
            this.status('answering');
          }
          this.send({ type: 'answer_delta', id, text: delta });
        },
      });
      const doneAt = Date.now();
      const sec = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(2)}s`);
      console.log(
        `[q${id}] "${text}" (${reason}) detect=${sec(speechEndAt && detectedAt - speechEndAt)} ` +
          `ttft=${sec(result.firstTokenAt && result.firstTokenAt - requestAt)} ` +
          `e2e=${sec(speechEndAt && result.firstTokenAt && result.firstTokenAt - speechEndAt)} model=${result.model ?? answerConfig.model}`,
      );
      this.history.push({ question: text, answer: result.text });
      this.history = this.history.slice(-10);
      this.send({
        type: 'answer_done',
        id,
        metrics: {
          // speech end -> question detected (endpointing + hold), only for spoken questions
          detectionMs: speechEndAt ? detectedAt - speechEndAt : null,
          // LLM request -> first answer token
          ttftMs: result.firstTokenAt ? result.firstTokenAt - requestAt : null,
          // what the candidate feels: interviewer stops talking -> first token on screen
          endToEndMs: speechEndAt && result.firstTokenAt ? result.firstTokenAt - speechEndAt : null,
          totalMs: doneAt - requestAt,
          cachedInputTokens: result.cachedInputTokens,
          model: result.model ?? answerConfig.model,
        },
      });
    } catch (err) {
      if (isAbortError(err) || abort.signal.aborted) return;
      console.error('[answer]', err);
      this.send({ type: 'error', id, message: describeError(err) });
    } finally {
      if (this.current?.id === id) {
        this.current = null;
        this.status(this.stt ? 'listening' : 'idle');
      }
    }
  }

  handleJson(msg) {
    switch (msg.type) {
      case 'start':
        if (msg.capture) {
          const { source, label, settings = {} } = msg.capture;
          console.log(`[capture] source=${source} track="${label}" sampleRate=${settings.sampleRate ?? '?'} channels=${settings.channelCount ?? '?'}`);
        }
        return this.start(msg.context);
      case 'stop': return this.stop();
      case 'diag': return console.log('[diag]', JSON.stringify(msg.diag));
      case 'context': return this.setContext(msg.context);
      case 'ask': {
        // Manual trigger (button or typed question): bypasses the detector.
        const text = String(msg.text ?? '').trim().slice(0, 2000);
        if (msg.context) this.setContext(msg.context);
        if (text) this.answer({ text, reason: 'manual' });
        return;
      }
      default:
        this.send({ type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  }

  dispose() {
    this.stop();
  }
}

wss.on('connection', (ws) => {
  console.log('[ws] browser connected');
  const session = new Session(ws);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return session.audio(data);
    let msg;
    try { msg = JSON.parse(data.toString()); } catch {
      return session.send({ type: 'error', message: 'Invalid JSON message' });
    }
    session.handleJson(msg);
  });
  ws.on('close', () => {
    console.log('[ws] browser disconnected');
    session.dispose();
  });
  ws.on('error', (err) => console.error('[ws]', err.message));
  session.status('idle');
});

server.listen(PORT, () => {
  console.log(`Interview assistant running at http://localhost:${PORT}`);
  if (!process.env.DEEPGRAM_API_KEY) console.warn('  ! DEEPGRAM_API_KEY not set: live transcription disabled');
  console.log(`  answers: ${answerConfig.provider} / ${answerConfig.model}${process.env.MOCK_LLM === '1' ? ' (MOCK_LLM on)' : ''}`);
  const keyVar = answerConfig.provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!process.env[keyVar] && process.env.MOCK_LLM !== '1') console.warn(`  ! ${keyVar} not set: answers will fail`);
});
