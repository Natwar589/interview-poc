const $ = (id) => document.getElementById(id);
const els = {
  source: $('source'), start: $('startBtn'), stop: $('stopBtn'),
  status: $('status'), statusText: $('statusText'), error: $('errorBar'),
  transcript: $('transcript'), answerLast: $('answerLastBtn'),
  askForm: $('askForm'), askInput: $('askInput'),
  question: $('question'), questionReason: $('questionReason'), answer: $('answer'),
  metrics: $('metrics'), mDetect: $('mDetect'), mTtft: $('mTtft'), mE2e: $('mE2e'), mTotal: $('mTotal'),
  historyList: $('historyList'), historyCount: $('historyCount'),
  meter: $('meter'), meterBar: $('meterBar'), meterText: $('meterText'),
  resume: $('resume'), jd: $('jd'), contextSaved: $('contextSaved'),
};

// ---------- context form (persisted locally) ----------
const STORE_KEY = 'interview-assistant-context';
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  els.resume.value = saved.resume || '';
  els.jd.value = saved.jobDescription || '';
} catch { /* storage unavailable */ }

function getContext() {
  return { resume: els.resume.value, jobDescription: els.jd.value };
}
let saveTimer;
for (const el of [els.resume, els.jd]) {
  el.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(getContext())); } catch {}
      els.contextSaved.textContent = 'saved';
      if (capture) send({ type: 'context', context: getContext() });
    }, 400);
  });
}

// ---------- websocket ----------
// Auto-reconnects with backoff. If audio is being captured when the connection comes
// back, capture keeps running and the server session is restarted with the same context.
let ws;
let ready;
let retryMs = 500;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ready = new Promise((resolve) => {
    ws.onopen = () => {
      retryMs = 500;
      hideError();
      if (capture) send({ type: 'start', context: getContext(), capture: capture.info });
      resolve();
    };
  });
  ws.onclose = () => {
    setStatus('error', 'Disconnected');
    showError(`Connection to server lost. Reconnecting in ${(retryMs / 1000).toFixed(1)} s…`);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 8000);
  };
}
connect();

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- server messages ----------
let currentAnswerId = null;
let answerText = '';
let lastFinalLine = '';

function handle(msg) {
  switch (msg.type) {
    case 'status': return setStatus(msg.state, msg.detail);
    case 'transcript': return renderTranscript(msg);
    case 'skipped': return markSkipped(msg);
    case 'question':
      currentAnswerId = msg.id;
      answerText = '';
      els.question.textContent = msg.text;
      els.question.classList.remove('muted');
      els.questionReason.textContent = msg.reason;
      els.answer.innerHTML = '<span class="cursor"></span>';
      els.metrics.hidden = true;
      hideError();
      return;
    case 'answer_delta':
      if (msg.id !== currentAnswerId) return;
      answerText += msg.text;
      els.answer.innerHTML = renderMarkdown(answerText) + '<span class="cursor"></span>';
      return;
    case 'answer_done':
      if (msg.id !== currentAnswerId) return;
      els.answer.innerHTML = renderMarkdown(answerText);
      showMetrics(msg.metrics);
      addHistory(els.question.textContent, answerText);
      return;
    case 'error':
      if (msg.id && msg.id === currentAnswerId) els.answer.innerHTML = '';
      return showError(msg.message);
  }
}

const STATUS_LABEL = { idle: 'Idle', listening: 'Listening', thinking: 'Thinking', answering: 'Answering', error: 'Error' };
function setStatus(state, detail) {
  els.status.className = `status ${state}`;
  els.statusText.textContent = STATUS_LABEL[state] || state;
  els.status.title = detail || '';
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}
function hideError() { els.error.hidden = true; }

// Transcript: final segments become permanent lines; the latest interim result is
// shown in grey at the end and replaced on every update.
let interimEl = null;
let currentLine = null; // the line being built until speech_final
function renderTranscript({ text, isFinal, speechFinal }) {
  els.transcript.querySelector('.empty')?.remove();
  if (!currentLine) {
    currentLine = document.createElement('p');
    currentLine.className = 'line';
    els.transcript.appendChild(currentLine);
  }
  if (!interimEl) {
    interimEl = document.createElement('span');
    interimEl.className = 'interim';
  }
  if (isFinal) {
    const seg = document.createElement('span');
    seg.className = 'final';
    seg.textContent = text + ' ';
    currentLine.appendChild(seg);
    interimEl.textContent = '';
  } else {
    interimEl.textContent = text;
  }
  currentLine.appendChild(interimEl); // keep interim last
  if (speechFinal) {
    lastFinalLine = currentLine.textContent.trim();
    interimEl.remove();
    currentLine = null;
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function markSkipped({ reason }) {
  const lines = els.transcript.querySelectorAll('.line');
  const last = lines[lines.length - 1];
  if (last && !last.dataset.tag) {
    last.dataset.tag = 'skipped';
    last.classList.add('skipped');
    last.title = `Ignored: ${reason}`;
  }
}

function showMetrics(m) {
  const fmt = (v) => (v == null ? '–' : `${(v / 1000).toFixed(2)} s`);
  els.mDetect.textContent = fmt(m.detectionMs);
  els.mTtft.textContent = fmt(m.ttftMs);
  els.mE2e.textContent = fmt(m.endToEndMs);
  els.mTotal.textContent = fmt(m.totalMs);
  els.mE2e.className = m.endToEndMs == null ? '' : m.endToEndMs <= 3000 ? 'good' : 'bad';
  els.metrics.hidden = false;
}

function addHistory(q, a) {
  const li = document.createElement('li');
  li.innerHTML = `<b></b><div class="hist-answer">${renderMarkdown(a)}</div>`;
  li.querySelector('b').textContent = q;
  els.historyList.prepend(li);
  els.historyCount.textContent = els.historyList.children.length;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Minimal markdown: "- " bullets and **bold**. Escape first, so model output can't inject HTML.
function renderMarkdown(md) {
  const lines = escapeHtml(md).split('\n').filter((l) => l.trim());
  const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  let html = '';
  let inList = false;
  for (const line of lines) {
    const m = line.match(/^\s*[-*•]\s+(.*)/);
    if (m) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${bold(m[1])}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${bold(line)}</p>`;
    }
  }
  return inList ? html + '</ul>' : html;
}

// ---------- audio capture ----------
let capture = null; // { stream, ctx, node }

async function getStream(kind) {
  if (kind === 'mic') {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  }
  // Tab/system audio. Chrome requires video. We keep the video track alive (stopping it
  // can silence the captured tab audio in Chrome) but ask for it tiny and at 1 fps.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: 320, height: 180, frameRate: 1 },
    audio: { echoCancellation: false, noiseSuppression: false },
    systemAudio: 'include',
  });
  if (!stream.getAudioTracks().length) {
    throw new Error('No audio in the shared source. Share a browser tab and tick "Share tab audio".');
  }
  return stream;
}

async function startCapture() {
  hideError();
  els.start.disabled = true;
  try {
    await ready;
    // Create the AudioContext inside the click (before the share picker), so Chrome's
    // autoplay policy can't leave it suspended.
    const ctx = new AudioContext();
    await ctx.resume();
    let stream;
    try {
      stream = await getStream(els.source.value);
    } catch (err) {
      ctx.close();
      throw err;
    }
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-worklet');
    const silence = { ms: 0, warned: false };
    node.port.onmessage = (e) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
      watchSilence(new Int16Array(e.data), silence);
    };
    src.connect(node);
    // Second, independent level reading straight off Chrome's stream (before our
    // worklet), so diagnostics can tell "Chrome gives silence" from "worklet loses it".
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    // Route through a muted gain to the speakers so Chrome always pulls the graph;
    // we never replay the audio (the meeting tab already plays it).
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    const track = stream.getAudioTracks()[0];
    const info = { source: els.source.value, label: track.label, settings: track.getSettings() };
    capture = { stream, ctx, node, info };
    runDiagnostics(capture, analyser, track, silence);
    setMeter('silent', 'Capturing…');
    // If the user clicks the browser's "Stop sharing" bar.
    stream.getAudioTracks()[0].addEventListener('ended', () => stopCapture());

    // Tell the server what was captured, so silent-capture problems are diagnosable.
    send({ type: 'start', context: getContext(), capture: info });
    els.stop.disabled = false;
    els.source.disabled = true;
  } catch (err) {
    els.start.disabled = false;
    if (err.name !== 'NotAllowedError') showError(err.message);
    else showError('Permission denied for audio capture.');
  }
}

// 3 s after Start, report where the sound is (or isn't) to the server log and console.
function runDiagnostics(cap, analyser, track, silence) {
  const buf = new Float32Array(analyser.fftSize);
  let analyserPeak = 0;
  let workletPeak = 0;
  const origWatch = silence;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    for (const v of buf) analyserPeak = Math.max(analyserPeak, Math.abs(v));
    workletPeak = Math.max(workletPeak, origWatch.peak || 0);
  }, 50);
  setTimeout(() => {
    clearInterval(timer);
    if (capture !== cap) return;
    const diag = {
      contextState: cap.ctx.state,
      contextSampleRate: cap.ctx.sampleRate,
      trackLabel: track.label,
      trackMuted: track.muted,
      trackEnabled: track.enabled,
      trackState: track.readyState,
      streamLevel: Math.round(analyserPeak * 32768), // straight from Chrome's stream
      processorLevel: workletPeak,                  // after our worklet
    };
    console.log('[diag]', diag);
    send({ type: 'diag', diag });
  }, 3000);
}

// Level meter + silence warning, fed by every 100 ms chunk sent to the server.
// The usual cause of silence is "Share tab audio" left off, or a muted/paused tab.
function watchSilence(samples, state) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  // Map RMS to a -60..0 dBFS scale so quiet speech still moves the bar.
  const db = 20 * Math.log10(Math.sqrt(sum / samples.length) / 32768 || 1e-6);
  els.meterBar.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;

  state.peak = Math.max(state.peak || 0, peak);
  if (peak > 50) {
    state.ms = 0;
    setMeter('live', 'Receiving audio');
    if (state.warned) { state.warned = false; hideError(); }
    return;
  }
  state.ms += 100;
  // Short gaps are normal between sentences; only call it silent after 1 s.
  if (state.ms >= 1000) setMeter('silent', 'Capturing · silent');
  if (state.ms >= 5000 && !state.warned) {
    state.warned = true;
    showError('No sound in the shared audio for 5 s. Is the tab playing and unmuted, and was "Also share tab audio" turned on?');
  }
}

function setMeter(state, text) {
  els.meter.className = `meter ${state}`;
  els.meterText.textContent = text;
  if (state === 'off') els.meterBar.style.width = '0';
}

function stopCapture() {
  if (capture) {
    capture.node.port.onmessage = null;
    capture.stream.getTracks().forEach((t) => t.stop());
    capture.ctx.close();
    capture = null;
  }
  setMeter('off', 'No audio');
  send({ type: 'stop' });
  els.start.disabled = false;
  els.stop.disabled = true;
  els.source.disabled = false;
}

els.start.addEventListener('click', startCapture);
els.stop.addEventListener('click', stopCapture);

// Manual triggers: a safety net for detector misses, and a way to test without audio.
els.answerLast.addEventListener('click', () => {
  const text = (currentLine?.textContent || lastFinalLine).trim();
  if (text) send({ type: 'ask', text, context: getContext() });
});
els.askForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.askInput.value.trim();
  if (!text) return;
  await ready;
  send({ type: 'ask', text, context: getContext() });
  els.askInput.value = '';
});
