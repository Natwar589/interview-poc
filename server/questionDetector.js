// Question detection: decides when the interviewer has finished asking something
// worth answering.
//
// Approach: pause detection + text heuristics, no LLM classifier.
//   - "Pause" comes from Deepgram: `speech_final` fires after DEEPGRAM_ENDPOINTING_MS
//     of silence, `UtteranceEnd` after ~1s with no words (backup in noisy audio).
//   - At each pause we classify the buffered utterance:
//       question  + looks complete  -> fire immediately
//       question  + looks unfinished (trailing "and", "the", ...) -> hold a bit longer
//       filler / small talk / statement -> drop (statements are kept as context)
//   - Any new speech during a hold cancels it and keeps accumulating.
// Why not an LLM classifier: it adds a full round trip (~300-800ms) on the critical
// path for every pause, which eats most of the 3s budget. Heuristics are instant;
// the cost of a miss is covered by a manual "Answer this" button in the UI.

const FILLER = new Set([
  'ok', 'okay', 'yeah', 'yes', 'yep', 'no', 'nope', 'right', 'sure', 'great', 'cool',
  'hmm', 'hm', 'um', 'uh', 'umm', 'uhh', 'ah', 'oh', 'thanks', 'thank you', 'perfect',
  'got it', 'alright', 'all right', 'nice', 'i see', 'makes sense', 'awesome', 'good',
  'interesting', 'mhm', 'uh huh', 'so', 'well', 'and', 'very good', 'excellent',
]);

// Things that are grammatically questions but not interview questions.
const SMALL_TALK = [
  /\bcan you (hear|see) me\b/,
  /\bcan you see my screen\b/,
  /\bis my (screen|audio|video|mic)\b/,
  /\bhow are you( doing)?( today)?\b/,
  /\bhow('s| is) it going\b/,
  /\bhow('s| is) your day\b/,
  /\bare you there\b/,
  /\b(am i|are we) audible\b/,
  /\bgive me (a|one) (sec|second|minute|moment)\b/,
  /\blet me (share|stop sharing|pull up)\b/,
  /\bdo you have any questions for (me|us)\b/,
  /\b(thanks|thank you) for (joining|coming|your time|having me)\b/,
  /\bnice to (meet|see) you\b/,
];

// Leading words that make a sentence a question.
const INTERROGATIVE_START =
  /^(what|what's|whats|why|how|how's|when|where|which|who|whom|whose|can|could|would|will|should|do|does|did|have|has|had|are|is|was|were|if you)\b/;

// Imperative prompts interviewers use instead of questions.
const IMPERATIVE_CUE =
  /\b(tell me|tell us|walk me through|walk us through|talk me through|talk about|describe|explain|give me an example|give an example|share (an|a|some) (example|time|story)|help me understand|elaborate|introduce yourself|take me through|compare|contrast|differentiate|difference between|pros and cons)\b/;

// Utterances ending like this are probably mid-sentence pauses.
// Without closing punctuation, ending on any of these means the speaker is mid-phrase
// ("How does Kafka compare to …"): never answer that on a timer.
const DANGLING =
  /\b(and|or|but|the|a|an|to|of|for|with|about|between|versus|vs|than|from|into|on|in|at|by|like|so|um|uh|your|my|our|their|this|that|if|because|when|how|what|which|is|are|was|were)$/;

const TRAILING_INCOMPLETE =
  /\b(and|or|but|the|a|an|like|so|um|uh|your|my|if|because)[,.]?$/;

export function normalize(text) {
  return text.toLowerCase().replace(/[^\w\s'?]/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitSentences(text) {
  return text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Classify a finished-for-now utterance.
 * @returns {{ kind: 'question'|'filler'|'smalltalk'|'statement', complete: boolean,
 *             question?: string, reason: string }}
 */
export function classifyUtterance(rawText) {
  const text = rawText.trim();
  const sentences = splitSentences(text);

  // Walk sentence by sentence: filler and small talk are skipped, and the LAST
  // sentence with a question cue starts the question. Everything before it is "lead"
  // (context like "Great, thanks." or "We run 50 services."), everything after it
  // belongs to the question.
  let startIdx = -1;
  let reason = '';
  let sawSmallTalk = false;
  let sawStatement = false;
  for (let i = 0; i < sentences.length; i++) {
    const plain = normalize(sentences[i]).replace(/\?/g, '').trim();
    if (isFiller(sentences[i])) continue;
    if (SMALL_TALK.some((re) => re.test(plain))) { sawSmallTalk = true; continue; }
    const s = plain.replace(/^((so|okay|ok|alright|and|now|great|cool|right)\s+)+/, '');
    let cue = '';
    if (sentences[i].endsWith('?')) cue = 'ends with "?"';
    else if (IMPERATIVE_CUE.test(s)) cue = 'imperative prompt';
    else if (INTERROGATIVE_START.test(s) && s.split(' ').length >= 4) cue = 'interrogative opening';
    if (cue) { startIdx = i; reason = cue; } else sawStatement = true;
  }

  if (startIdx === -1) {
    if (sawStatement) return { kind: 'statement', complete: true, reason: 'no question cue' };
    if (sawSmallTalk) return { kind: 'smalltalk', complete: true, reason: 'small talk / meeting logistics' };
    return { kind: 'filler', complete: true, reason: 'filler words only' };
  }

  const question = sentences.slice(startIdx).join(' ');
  const qWords = normalize(question).replace(/\?/g, '').split(' ').filter(Boolean);
  // Two words is enough when it is unmistakably a question: "Is React?", "Why Kafka?"
  // (often a longer question whose first word got clipped). "You sure?" still isn't.
  const shortQuestion = qWords.length === 2 && question.endsWith('?') && INTERROGATIVE_START.test(qWords.join(' '));
  if (qWords.length < 3 && !shortQuestion) {
    return { kind: 'filler', complete: true, reason: 'too short to be a question' };
  }

  // "Complete" = safe to answer without waiting for more speech.
  const lastChunk = normalize(sentences[sentences.length - 1]);
  const endsWithQ = text.endsWith('?');
  const trailing = TRAILING_INCOMPLETE.test(lastChunk.replace(/\?$/, ''));
  const complete = (endsWithQ || /[.!]$/.test(text)) && !trailing;

  const lead = sentences.slice(0, startIdx).join(' ');
  return { kind: 'question', complete, question, lead, reason };
}

// Filler can be several phrases: "Yeah, got it, makes sense."
function isFiller(sentence) {
  const phrases = sentence.toLowerCase().split(/[,.!?;]+/).map(normalize).filter(Boolean);
  return phrases.every((p) => FILLER.has(p) || p.split(' ').every((w) => FILLER.has(w)));
}

/**
 * Stateful wrapper fed by STT events. Emits via callbacks:
 *   onQuestion({ text, reason, speechEndAt, detectedAt })
 *   onSkipped({ text, kind, reason })
 */
export class QuestionDetector {
  constructor({ holdMs = 900, onQuestion, onSkipped }) {
    this.holdMs = holdMs;
    this.onQuestion = onQuestion;
    this.onSkipped = onSkipped;
    this.buffer = [];          // final segments of the current utterance
    this.recentStatements = []; // recent non-question utterances, used as context
    this.holdTimer = null;
    this.speechEndAt = null;
    this.lastAsked = '';
  }

  get text() {
    return this.buffer.join(' ').trim();
  }

  /** Any interim speech means the speaker continued: cancel a pending hold. */
  onInterim(text) {
    if (text.trim() && this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  /** A finalized segment. `speechFinal` = Deepgram saw a pause after it. */
  onFinal(text, { speechFinal, speechEndAt }) {
    if (text.trim()) {
      this.onInterim(text);
      this.buffer.push(text.trim());
      this.speechEndAt = speechEndAt ?? Date.now();
    }
    if (speechFinal) this.evaluate('pause');
  }

  /** Deepgram UtteranceEnd: a longer gap; treat anything held as final. */
  onUtteranceEnd() {
    this.evaluate('utterance_end', { force: true });
  }

  evaluate(trigger, { force = false } = {}) {
    const text = this.text;
    if (!text) return;
    const result = classifyUtterance(text);

    if (result.kind !== 'question') {
      // Statements can still be mid-thought ("We have a service that handles...").
      // Keep them buffered until a long pause, then file them as context. The same goes
      // for anything cut mid-sentence (no closing punctuation), e.g. "Alright. Tell me".
      const midSentence = !/[.?!]$/.test(text);
      if ((result.kind === 'statement' || midSentence) && !force) return;
      if (result.kind === 'statement') {
        this.recentStatements.push(text);
        this.recentStatements = this.recentStatements.slice(-3);
      }
      this.onSkipped?.({ text, kind: result.kind, reason: result.reason });
      this.reset();
      return;
    }

    if (result.complete || force) {
      this.fire(result, trigger);
      return;
    }
    // Looks like a question but may be unfinished: wait a little for more speech.
    if (!this.holdTimer) {
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        const text = this.text;
        const again = classifyUtterance(text);
        // Still dangling mid-phrase: keep waiting for more words or the long pause.
        if (!/[.?!]$/.test(text) && DANGLING.test(normalize(text))) return;
        if (again.kind === 'question') this.fire(again, 'hold_timeout');
      }, this.holdMs);
    }
  }

  fire(result, trigger) {
    const question = result.question.trim();
    // Statements said just before the question ("We run 50 services on k8s.") often
    // carry the context the answer needs.
    const preamble = [...this.recentStatements, result.lead].filter(Boolean).join(' ');
    const speechEndAt = this.speechEndAt;
    this.recentStatements = [];
    this.reset();
    if (normalize(question) === normalize(this.lastAsked)) return; // STT duplicate
    this.lastAsked = question;
    this.onQuestion?.({
      text: question,
      preamble,
      reason: `${result.reason} (${trigger})`,
      speechEndAt,
      detectedAt: Date.now(),
    });
  }

  reset() {
    this.buffer = [];
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  dispose() {
    this.reset();
  }
}
