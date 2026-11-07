const $ = (id) => document.getElementById(id);
const els = {
  source: $('source'), sourceIcon: $('sourceIcon'),
  start: $('startBtn'), stop: $('stopBtn'), pause: $('pauseBtn'), theme: $('themeBtn'),
  status: $('status'), statusText: $('statusText'),
  error: $('errorBar'), errorText: $('errorText'), errorClose: $('errorClose'),
  meter: $('meter'), meterText: $('meterText'),
  transcript: $('transcript'), liveBadge: $('liveBadge'), answerLast: $('answerLastBtn'),
  askForm: $('askForm'), askInput: $('askInput'),
  answerEmpty: $('answerEmpty'), qaCard: $('qaCard'),
  question: $('question'), questionSource: $('questionSource'), questionTag: $('questionTag'),
  answer: $('answer'), answerActions: $('answerActions'),
  metrics: $('metrics'), mDetect: $('mDetect'), mTtft: $('mTtft'), mE2e: $('mE2e'), mTotal: $('mTotal'),
  history: $('history'), historyList: $('historyList'), historyCount: $('historyCount'),
  lengthGroup: $('lengthGroup'), styleGroup: $('styleGroup'), compact: $('compactBtn'),
  resume: $('resume'), jd: $('jd'), contextSaved: $('contextSaved'),
  resumeCount: $('resumeCount'), jdCount: $('jdCount'), resumeChip: $('resumeChip'), jdChip: $('jdChip'),
  tabBadge: $('tabBadge'), userName: $('userName'), logoutForm: $('logoutForm'),
};
const icon = (name) => `<svg class="icon"><use href="#i-${name}"/></svg>`;

// localStorage can throw (private mode, blocked storage): never let that break the app.
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// ---------- signed-in user ----------
// GET /session: 200 { name } when signed in, 401 when the session expired, 404 when the
// server runs without a password (then there is nothing to show).
async function checkSession() {
  try {
    const r = await fetch('/session', { cache: 'no-store' });
    if (r.status === 401) { location.href = '/login'; return false; }
    if (r.ok) {
      const { name, email } = await r.json();
      els.userName.textContent = `Hi, ${name.split(' ')[0]}`;
      els.userName.title = `Signed in as ${name}${email ? ` (${email})` : ''}`;
      els.userName.hidden = false;
      els.logoutForm.hidden = false;
    }
  } catch { /* offline: the WebSocket reconnect loop reports it */ }
  return true;
}
checkSession();

// ---------- theme ----------
els.theme.addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  root.dataset.theme = current === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('interview-assistant-theme', root.dataset.theme); } catch {}
});

// ---------- responsive sections (tablet / mobile tabs) ----------
const narrow = matchMedia('(max-width: 759px)');
function setView(view) {
  document.body.dataset.view = view;
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === view || (tab.classList.contains('tab-wide') && view !== 'context');
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-current', active ? 'page' : 'false');
  }
  if (view === 'answer') els.tabBadge.hidden = true;
}
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setView(tab.dataset.view));
setView('answer');

// ---------- profile: resume, job description, answer preferences ----------
const STORE_KEY = 'interview-assistant-context';
const PREFS_KEY = 'interview-assistant-prefs';
const savedContext = load(STORE_KEY, {});
els.resume.value = savedContext.resume || '';
els.jd.value = savedContext.jobDescription || '';
const prefs = { answerStyle: 'natural', answerLength: 'balanced', compact: false, ...load(PREFS_KEY, {}) };

function getContext() {
  return {
    resume: els.resume.value,
    jobDescription: els.jd.value,
    answerStyle: prefs.answerStyle,
    answerLength: prefs.answerLength,
  };
}

function updateProfileSummary() {
  const chip = (el, value, label) => {
    const has = value.trim().length > 0;
    el.className = `chip${has ? ' ok' : ''}`;
    el.innerHTML = has ? `${icon('check')}${label} added` : `${label} not added`;
  };
  chip(els.resumeChip, els.resume.value, 'Resume');
  chip(els.jdChip, els.jd.value, 'Job description');
  const count = (n) => (n ? `${n.toLocaleString()} characters` : '');
  els.resumeCount.textContent = count(els.resume.value.length);
  els.jdCount.textContent = count(els.jd.value.length);
}
updateProfileSummary();

let saveTimer;
let savedFadeTimer;
for (const el of [els.resume, els.jd]) {
  el.addEventListener('input', () => {
    updateProfileSummary();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      save(STORE_KEY, { resume: els.resume.value, jobDescription: els.jd.value });
      showSaved();
      send({ type: 'context', context: getContext() });
    }, 400);
  });
}
function showSaved() {
  els.contextSaved.innerHTML = `${icon('check')}Saved`;
  els.contextSaved.classList.remove('fade');
  clearTimeout(savedFadeTimer);
  savedFadeTimer = setTimeout(() => els.contextSaved.classList.add('fade'), 1600);
}

function syncPrefsUI() {
  for (const b of els.lengthGroup.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.length === prefs.answerLength));
  for (const b of els.styleGroup.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.style === prefs.answerStyle));
  els.compact.setAttribute('aria-pressed', String(prefs.compact));
  els.answer.classList.toggle('compact', prefs.compact);
}
function setPref(key, value) {
  prefs[key] = value;
  save(PREFS_KEY, prefs);
  syncPrefsUI();
  if (key !== 'compact') send({ type: 'context', context: getContext() });
}
els.lengthGroup.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-length]');
  if (b) setPref('answerLength', b.dataset.length);
});
els.styleGroup.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-style]');
  if (b) setPref('answerStyle', b.dataset.style);
});
els.compact.addEventListener('click', () => setPref('compact', !prefs.compact));
syncPrefsUI();

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
      if (offline) { offline = false; hideError(); setStatus(capture ? 'listening' : 'idle'); }
      send({ type: 'context', context: getContext() });
      if (capture) send({ type: 'start', context: getContext(), capture: capture.info });
      resolve();
    };
  });
  ws.onclose = async () => {
    // A refused socket may just mean the session expired: go to sign-in instead of retrying.
    if (!(await checkSession())) return;
    offline = true;
    setStatus('offline');
    showError(`Lost the connection to the assistant. Reconnecting in ${(retryMs / 1000).toFixed(1)} s…`);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 8000);
  };
}
let offline = false;
connect();

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- status ----------
// Server states: idle | listening | thinking | answering. Client-only: paused, offline.
const STATUS = {
  idle: ['ready', 'Ready'],
  listening: ['listening', 'Listening'],
  detected: ['detected', 'Question detected'],
  processing: ['processing', 'Processing'],
  answering: ['answering', 'Answering'],
  paused: ['paused', 'Paused'],
  offline: ['offline', 'Connection issue'],
};
let serverState = 'idle';
function setStatus(state, detail) {
  if (state !== 'paused' && state !== 'offline') serverState = state;
  let key = state;
  if (state === 'thinking') key = current.manual ? 'processing' : 'detected';
  if (offline && state !== 'offline') key = 'offline';
  else if (capture?.paused && (key === 'listening' || key === 'idle')) key = 'paused';
  const [cls, label] = STATUS[key] || STATUS.idle;
  els.status.className = `status ${cls}`;
  els.statusText.textContent = label;
  els.status.title = detail || '';
}

function showError(message) {
  els.errorText.textContent = message;
  els.error.hidden = false;
}
function hideError() { els.error.hidden = true; }
els.errorClose.addEventListener('click', hideError);

// ---------- transcript ----------
// Final segments become permanent lines; the latest interim result is shown dimmed at
// the end of the current line and replaced on every update.
let interimEl = null;
let currentLine = null; // { el, text } being built until speech_final
let lastFinalLine = '';
const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });

function renderTranscript({ text, isFinal, speechFinal }) {
  els.transcript.querySelector('.empty')?.remove();
  if (!currentLine) {
    els.transcript.querySelector('.line.latest')?.classList.remove('latest');
    const el = document.createElement('div');
    el.className = 'line latest';
    el.innerHTML = `<span class="line-time"></span><span class="line-text"></span>`;
    el.firstChild.textContent = timeFmt.format(new Date());
    els.transcript.appendChild(el);
    currentLine = { el, text: el.lastChild };
  }
  interimEl ??= Object.assign(document.createElement('span'), { className: 'interim' });
  if (isFinal) {
    currentLine.text.append(document.createTextNode(`${text} `));
    interimEl.textContent = '';
  } else {
    interimEl.textContent = text;
  }
  currentLine.text.appendChild(interimEl); // keep interim last
  if (speechFinal) {
    interimEl.remove();
    lastFinalLine = currentLine.text.textContent.trim();
    currentLine = null;
  }
  scrollToEnd(els.transcript);
}

// Only follow new lines when the reader is already at the bottom.
function scrollToEnd(el) {
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
}

function lastLine() {
  const lines = els.transcript.querySelectorAll('.line');
  return lines[lines.length - 1];
}
function markSkipped({ reason }) {
  const line = lastLine();
  if (line && !line.classList.contains('asked')) {
    line.classList.add('skipped');
    line.title = `Not treated as a question: ${reason}`;
  }
}

// ---------- question + answer ----------
const REFINE_LABEL = {
  regenerate: 'New version', shorter: 'Shorter version', conversational: 'More natural', detailed: 'More detail',
};
let current = { id: null, text: '', question: '', manual: false, refine: null, streaming: false };
const history = []; // [{ question, answer, at }]

function handle(msg) {
  switch (msg.type) {
    case 'status': return setStatus(msg.state, msg.detail);
    case 'transcript': return renderTranscript(msg);
    case 'skipped': return markSkipped(msg);
    case 'question': return onQuestion(msg);
    case 'answer_delta':
      if (msg.id !== current.id) return;
      current.text += msg.text;
      renderCurrentAnswer(true);
      return;
    case 'answer_done':
      if (msg.id !== current.id) return;
      current.streaming = false;
      renderCurrentAnswer(false);
      showMetrics(msg.metrics);
      els.answerActions.hidden = false;
      setActionsDisabled(false);
      // A rewrite replaces the answer it reworked (the server does the same).
      if (current.refine && history.length) history.pop();
      history.push({ question: current.question, answer: current.text, at: new Date() });
      renderHistory();
      return;
    case 'error':
      if (msg.id && msg.id === current.id) {
        current.streaming = false;
        els.answer.innerHTML = `<p class="skeleton-note">No answer this time. You can try again with Regenerate.</p>`;
        els.answerActions.hidden = !history.length;
        setActionsDisabled(false);
      }
      return showError(msg.message);
  }
}

function onQuestion(msg) {
  current = {
    id: msg.id, text: '', question: msg.text, manual: msg.reason === 'manual',
    refine: msg.refine || null, streaming: true,
  };
  els.answerEmpty.hidden = true;
  els.qaCard.hidden = false;
  // Restart the entrance animation for each new question (not for rewrites).
  if (!current.refine) {
    els.qaCard.style.animation = 'none';
    void els.qaCard.offsetWidth;
    els.qaCard.style.animation = '';
  }
  els.question.textContent = msg.text;
  els.question.title = msg.reason ? `Detected: ${msg.reason}` : '';
  els.questionSource.textContent = current.manual && !current.refine ? 'You asked' : 'Interviewer asked';
  els.questionTag.hidden = !current.refine;
  els.questionTag.className = 'chip accent';
  els.questionTag.textContent = REFINE_LABEL[current.refine] || '';
  els.answer.innerHTML = `<div class="skeleton" aria-label="Preparing an answer"><i></i><i></i><i></i></div>`;
  els.answerActions.hidden = true;
  els.metrics.hidden = true;
  hideError();
  if (!current.manual) lastLine()?.classList.add('asked');
  if (narrow.matches) {
    if (document.body.dataset.view === 'transcript') setView('answer');
    else if (document.body.dataset.view === 'context') els.tabBadge.hidden = false;
  }
}

function renderCurrentAnswer(streaming) {
  els.answer.innerHTML = renderAnswer(current.text, streaming);
}

function setActionsDisabled(disabled) {
  for (const b of els.answerActions.querySelectorAll('button')) b.disabled = disabled;
}

els.answerActions.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b || current.streaming) return;
  const action = b.dataset.action;
  if (action === 'copy') {
    await copyText(plainText(current.text));
    const label = b.querySelector('span');
    b.classList.add('done');
    label.textContent = 'Copied';
    b.querySelector('use').setAttribute('href', '#i-check');
    setTimeout(() => {
      b.classList.remove('done');
      label.textContent = 'Copy';
      b.querySelector('use').setAttribute('href', '#i-copy');
    }, 1500);
    return;
  }
  await ready;
  setActionsDisabled(true);
  send({ type: 'ask', refine: action, context: getContext() });
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function showMetrics(m) {
  const fmt = (v) => (v == null ? '–' : `${(v / 1000).toFixed(1)} s`);
  els.mDetect.textContent = fmt(m.detectionMs);
  els.mTtft.textContent = fmt(m.ttftMs);
  els.mE2e.textContent = fmt(m.endToEndMs);
  els.mTotal.textContent = fmt(m.totalMs);
  els.mE2e.className = m.endToEndMs == null ? '' : m.endToEndMs <= 3000 ? 'good' : 'slow';
  // Typed questions have no speech timing: show only what applies.
  els.mDetect.parentElement.hidden = m.detectionMs == null;
  els.mE2e.parentElement.hidden = m.endToEndMs == null;
  els.metrics.hidden = false;
}

// Earlier Q&A: everything before the answer currently on screen, newest first.
function renderHistory() {
  const earlier = history.slice(0, -1).reverse();
  els.history.hidden = earlier.length === 0;
  els.historyCount.textContent = earlier.length;
  els.historyList.innerHTML = '';
  for (const item of earlier) {
    const li = document.createElement('li');
    li.innerHTML = `<details><summary><span class="hist-q"></span><span class="hist-time"></span><span class="hist-preview"></span></summary><div class="hist-answer">${renderAnswer(item.answer)}</div></details>`;
    li.querySelector('.hist-q').textContent = item.question;
    li.querySelector('.hist-time').textContent = timeFmt.format(item.at);
    li.querySelector('.hist-preview').textContent = plainText(item.answer).split('\n')[0];
    els.historyList.appendChild(li);
  }
}

// ---------- answer formatting ----------
// The model writes spoken paragraphs, then optionally "Key points:" with bullets, and
// fenced code for coding questions. Escape first, so model output can't inject HTML.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const KEY_POINTS = /^\s*(\*\*)?\s*key points:?\s*(\*\*)?\s*$/i;

function renderAnswer(md, streaming = false) {
  const lines = md.split('\n');
  const split = lines.findIndex((l) => KEY_POINTS.test(l));
  const caret = streaming ? '<span class="caret"></span>' : '';
  if (split === -1) return renderBlocks(lines, caret);
  return (
    renderBlocks(lines.slice(0, split)) +
    `<div class="support"><div class="support-label">Supporting points</div>${renderBlocks(lines.slice(split + 1), caret)}</div>`
  );
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderBlocks(lines, caret = '') {
  let html = '';
  let list = null; // 'ul' | 'ol' while a list is open
  let code = null; // lines of an open ``` block (also rendered while still streaming)
  let para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = escapeHtml(raw);
    if (/^\s*```/.test(line)) {
      if (code) { html += `<pre><code>${code.join('\n')}</code></pre>`; code = null; }
      else { flushPara(); closeList(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const bullet = line.match(/^\s*[-*•]\s+(.*)/);
    const numbered = !bullet && line.match(/^\s*\d+[.)]\s+(.*)/);
    if (bullet || numbered) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) { closeList(); html += `<${type}>`; list = type; }
      html += `<li>${inline((bullet || numbered)[1])}</li>`;
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  if (code) {
    html += `<pre><code>${code.join('\n')}${caret}</code></pre>`;
    caret = '';
  }
  // Put the caret at the end of the last paragraph or list item.
  if (para.length) { html += `<p>${inline(para.join(' '))}${caret}</p>`; caret = ''; }
  if (list) {
    if (caret) html = html.replace(/<\/li>$/, `${caret}</li>`);
    caret = '';
    html += `</${list}>`;
  }
  return html + caret;
}

// Clipboard / preview text: markdown removed, structure kept.
function plainText(md) {
  return md
    .split('\n')
    .filter((l) => !/^\s*```/.test(l))
    .map((l) => (KEY_POINTS.test(l) ? 'Key points:' : l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- audio capture ----------
let capture = null; // { stream, ctx, node, info, paused }

function getMic() {
  // Echo cancellation also removes the meeting audio Chrome plays through the speakers,
  // so in tab + mic mode the interviewer isn't picked up twice.
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
}

async function getStream(kind) {
  if (kind === 'mic') return getMic();
  if (kind === 'tabmic') {
    // Tab first (the share picker), then the mic. The tab only carries the other
    // participants, so the mic adds the candidate's own voice.
    const tab = await getStream('tab');
    try {
      const mic = await getMic();
      return new MediaStream([...tab.getTracks(), ...mic.getAudioTracks()]);
    } catch (err) {
      tab.getTracks().forEach((t) => t.stop());
      throw err;
    }
  }
  // Tab/system audio. Chrome requires video. We keep the video track alive (stopping it
  // can silence the captured tab audio in Chrome) but ask for it tiny and at 1 fps.
  // displaySurface 'browser' opens Chrome's picker on the "Chrome Tab" list: on macOS only
  // a tab reliably carries audio (a window never does; a whole screen only with macOS
  // system-audio permission).
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: 320, height: 180, frameRate: 1, displaySurface: 'browser' },
    audio: { echoCancellation: false, noiseSuppression: false, suppressLocalAudioPlayback: false },
    systemAudio: 'include',
    selfBrowserSurface: 'exclude', // hide this app's own tab from the list
    surfaceSwitching: 'include', // lets the user switch tabs from Chrome's sharing bar
  });
  if (!stream.getAudioTracks().length) {
    throw new Error('No audio in the shared source. Share a browser tab and tick "Share tab audio".');
  }
  return stream;
}

async function startCapture() {
  hideError();
  els.start.disabled = true;
  els.start.querySelector('span').textContent = 'Starting…';
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
    // One source per audio track (tab + mic mode has two); a node sums its inputs, so the
    // worklet receives the mix. createMediaStreamSource alone would use only one track.
    const sources = stream.getAudioTracks().map((t) => ctx.createMediaStreamSource(new MediaStream([t])));
    const node = new AudioWorkletNode(ctx, 'pcm-worklet');
    // 'browser' (a tab), 'window' or 'monitor' (whole screen): drives the silence hint.
    const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
    const silence = { ms: 0, warned: false, surface };
    node.port.onmessage = (e) => {
      if (capture?.paused) return; // paused: keep the stream, send nothing
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
      watchSilence(new Int16Array(e.data), silence);
    };
    for (const src of sources) src.connect(node);
    // Second, independent level reading straight off Chrome's stream (before our
    // worklet), so diagnostics can tell "Chrome gives silence" from "worklet loses it".
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    for (const src of sources) src.connect(analyser);
    // Route through a muted gain to the speakers so Chrome always pulls the graph;
    // we never replay the audio (the meeting tab already plays it).
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    const track = stream.getAudioTracks()[0];
    const labels = stream.getAudioTracks().map((t) => t.label);
    const info = { source: els.source.value, surface, label: labels.join(' + '), settings: track.getSettings() };
    capture = { stream, ctx, node, info, paused: false };
    runDiagnostics(capture, analyser, track, silence);
    setMeter('silent', 'Waiting for sound');
    // If the user clicks the browser's "Stop sharing" bar (or a mic is unplugged).
    for (const t of stream.getAudioTracks()) t.addEventListener('ended', () => stopCapture());

    // Tell the server what was captured, so silent-capture problems are diagnosable.
    send({ type: 'start', context: getContext(), capture: info });
    setCaptureUI(true);
  } catch (err) {
    setCaptureUI(false);
    if (err.name !== 'NotAllowedError') showError(err.message);
    else showError('Audio access was not allowed. Click Start interview again and allow sharing (or the microphone).');
  }
}

function setCaptureUI(on) {
  els.start.hidden = on;
  els.start.disabled = false;
  els.start.querySelector('span').textContent = 'Start interview';
  els.stop.hidden = !on;
  els.pause.hidden = !on;
  els.source.disabled = on;
  els.liveBadge.hidden = !on;
  setPauseUI(false);
}

function setPauseUI(paused) {
  els.pause.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
  els.pause.setAttribute('aria-label', paused ? 'Resume listening' : 'Pause listening');
  els.pause.title = paused ? 'Resume listening' : 'Pause listening';
  els.pause.setAttribute('aria-pressed', String(paused));
}

// Pause keeps the shared tab/mic open but stops sending audio, so nothing is transcribed
// or answered until Resume. The server keeps its speech stream alive meanwhile.
function togglePause() {
  if (!capture) return;
  capture.paused = !capture.paused;
  setPauseUI(capture.paused);
  els.liveBadge.hidden = capture.paused;
  if (capture.paused) setMeter('paused', 'Paused');
  else setMeter('silent', 'Waiting for sound');
  setStatus(capture.paused ? 'paused' : serverState);
}

function silenceHint(surface) {
  const reshare = 'Click Stop, then Start, and in the picker choose the "Chrome Tab" list, pick the meeting tab, and keep "Also share tab audio" on.';
  if (surface === 'window') return `No sound for 5 s: you shared a window, and Chrome can't capture a window's audio. ${reshare}`;
  if (surface === 'monitor') {
    return `No sound for 5 s: you shared the entire screen. On a Mac that needs Chrome allowed under System Settings > Privacy & Security > Screen & System Audio Recording, and "Also share system audio" on. Easier: ${reshare}`;
  }
  if (!surface) return 'No sound from the microphone for 5 s. Is the right mic selected and unmuted?';
  return 'No sound from the shared tab for 5 s. Is the meeting playing in that tab and unmuted? (A meeting in the Zoom/Teams desktop app has no tab: use Microphone, or join from the browser.)';
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
  // Map RMS to a -60..0 dBFS scale so quiet speech still moves the bars.
  const db = 20 * Math.log10(Math.sqrt(sum / samples.length) / 32768 || 1e-6);
  els.meter.style.setProperty('--level', Math.max(0, Math.min(1, (db + 60) / 60)).toFixed(2));

  state.peak = Math.max(state.peak || 0, peak);
  if (peak > 50) {
    state.ms = 0;
    setMeter('live', 'Hearing audio');
    if (state.warned) { state.warned = false; hideError(); }
    return;
  }
  state.ms += 100;
  // Short gaps are normal between sentences; only call it silent after 1 s.
  if (state.ms >= 1000) setMeter('silent', 'Silent');
  if (state.ms >= 5000 && !state.warned) {
    state.warned = true;
    showError(silenceHint(state.surface));
  }
}

function setMeter(state, text) {
  els.meter.className = `audio-indicator ${state}`;
  els.meterText.textContent = text;
  if (state === 'off' || state === 'paused') els.meter.style.setProperty('--level', 0);
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
  setCaptureUI(false);
  if (currentLine) { interimEl?.remove(); currentLine = null; }
}


els.start.addEventListener('click', startCapture);
els.stop.addEventListener('click', stopCapture);
els.pause.addEventListener('click', togglePause);
const SOURCE_ICON = { tab: 'monitor', tabmic: 'monitor', mic: 'mic' };
const syncSourceIcon = () => els.sourceIcon.querySelector('use').setAttribute('href', `#i-${SOURCE_ICON[els.source.value]}`);
els.source.addEventListener('change', syncSourceIcon);
syncSourceIcon();

// Manual triggers: a safety net for detector misses, and quick questions without audio.
els.answerLast.addEventListener('click', () => {
  const text = (currentLine?.text.textContent || lastFinalLine).trim();
  if (text) send({ type: 'ask', text, context: getContext() });
  else showError('Nothing has been said yet. Type a question in the box below instead.');
});
els.askForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.askInput.value.trim();
  if (!text) return;
  await ready;
  send({ type: 'ask', text, context: getContext() });
  els.askInput.value = '';
});
