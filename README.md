# Real-Time Interview Assistant (POC)

```
Browser audio ──PCM16 over WS──▶ Node server ──▶ Deepgram (streaming STT)
                                     │               │ interim / final / speech_final / UtteranceEnd
                                     │◀──────────────┘
                                     ├─ QuestionDetector (pause + heuristics)
                                     ├─ LLM: Gemini or Claude (streaming answer, resume + JD + memory)
UI ◀──JSON over the same WS────────┘  transcript · question · answer tokens · status · metrics
```

## Run it

Requires Node 20+ and Chrome or Edge (for tab-audio capture).

```bash
cp .env.example .env      # add DEEPGRAM_API_KEY plus GEMINI_API_KEY (or ANTHROPIC_API_KEY)
npm install
npm start                 # http://localhost:3000
```

1. Paste your resume and the job description into the right-hand panel. They are saved in localStorage.
2. Pick **Meeting tab audio**, press **Start**, choose the Meet or Zoom tab and tick **Share tab audio**. **Microphone** is there for solo testing.
3. Questions are detected and answered on their own. **Answer last line** forces an answer for the latest utterance, and the text box lets you type a question.

Without keys, run `MOCK_LLM=1 npm start` and use the text box. It streams a canned answer through the real UI path. `npm test` runs the detector tests. `node scripts/replay.mjs clip.wav` streams a recorded clip through the running server and prints transcripts, questions, answers and latency, with no browser needed.

## Layout

| File | Role |
|---|---|
| `public/pcm-worklet.js` | AudioWorklet: mixes down to mono, downsamples to 16 kHz PCM16 and posts 100 ms chunks |
| `public/app.js` | Capture, WebSocket client, panels, status, metrics, context form |
| `server/index.js` | Express static server, WebSocket endpoint, one `Session` per tab |
| `server/deepgram.js` | Raw Deepgram live WebSocket: KeepAlive, CloseStream, speech-end timestamps |
| `server/questionDetector.js` | Pause plus heuristic question detection (the core logic) |
| `server/answer.js` | Prompt, conversation memory, provider switch (`LLM_PROVIDER`), mock mode |
| `server/providers/gemini.js` | Gemini streaming via `@google/genai` |
| `server/providers/anthropic.js` | Claude streaming via `@anthropic-ai/sdk` |

## Key decisions

**Audio.** I chose tab audio (`getDisplayMedia`) over mixing in the mic. Tab audio carries only the interviewer, so the candidate's own speech never gets treated as a question. Downsampling happens in the browser, which cuts upload to 32 KB/s and lets Deepgram skip resampling. Each chunk is 100 ms: smaller chunks don't make Deepgram faster, they just add more frames.

**STT.** I used Deepgram `nova-3` through the raw WebSocket. It has good streaming latency, free credits, and gives two separate end-of-speech signals: `speech_final` after `endpointing` ms of silence (300 here) and `UtteranceEnd` after a 1 s word gap. `smart_format` adds punctuation, so a `?` becomes a strong signal for the detector.

**Key terms.** Generic speech-to-text mishears tech words: in a live test "What is React?" came out as "What is real?" and "What is the act?". When you press Start, [keyterms.js](server/keyterms.js) builds up to 80 terms and sends them as Deepgram `keyterm` prompts (nova-3 only):

- **Sources:** terms from the job description and resume, plus a base list of common interview terms.
- **What gets picked from the resume and JD:** acronyms like AWS, tech spellings like Node.js and p99, product and company names, and long domain words like "reconciliation".
- **Result:** in a replay test, "React", "Kafka", "RabbitMQ", "reconciliation" and the company name "Finlytics" were all transcribed correctly.
- **Limit:** editing the resume or JD mid-session changes the answers right away, but the transcription terms only on the next Start.

**Question detection.** This uses pause detection plus heuristics, with no LLM classifier. At each pause the buffered utterance is classified sentence by sentence.

Testing showed Deepgram's `speech_final` sometimes misses a pause entirely, so a pause comes from any of three sources:

1. **Our energy VAD** ([vad.js](server/vad.js)). The server measures the loudness of each 100 ms chunk against an adaptive noise floor. After `VAD_SILENCE_MS` (600 ms) of quiet following speech, it sends Deepgram `Finalize`, which flushes the transcript immediately. At 400 ms it was faster but clipped the first word of the next sentence in about 1 in 10 test questions.
2. **Deepgram's `speech_final`**, after 300 ms of silence.
3. **Repeated interim text**, for noisy audio where the VAD never hears quiet. When two consecutive interim results carry the same text (no new words for about 1 s), the server also sends `Finalize`.

- **Filler** ("okay", "yeah, got it") and **small talk** ("can you hear me?", "thanks for joining") are skipped per sentence, so small talk at the start never hides the question after it.
- **Fragments** cut mid-sentence (no closing punctuation, like "Alright. Tell me") stay buffered and get completed by the next segment.
- **Statements** stay buffered until a long pause, then are kept as *preamble*. For "We run 50 services on k8s. … How would you monitor them?", the answer sees both parts.
- **Questions** are detected by a trailing `?`, an interrogative opening ("how would you…"), or an imperative prompt ("tell me about", "walk me through"). If the question looks finished it fires right away. If it ends on "and", "the", "so" and similar words, the detector waits `QUESTION_HOLD_MS` (900 ms). Any new speech cancels that wait and the utterance keeps growing.
- Two-word questions count when they open with a question word and end in "?" ("Is React?", "Why Kafka?"), often a longer question with its first word clipped. "You sure?" does not count.
- The hold timer never answers a fragment that ends mid-phrase without punctuation ("How does Kafka compare to…"). It waits for the rest.
- If several questions are buffered, the **latest** one is answered and the earlier text goes in as context. Leading acknowledgements are trimmed ("Great, thanks. So how…" becomes "So how…"). A new question cancels the answer in progress.

Why not an LLM classifier? It puts a second model round trip (about 0.3 to 0.8 s) on the critical path at every pause, which uses up much of the 3 s budget. The heuristics take microseconds. A false positive costs a few tokens. A false negative is covered by the manual button. The main weakness is long rambling questions with mid-thought pauses over 300 ms, which can fire early. Next step: run a small, fast classifier *in parallel* with answer generation and cancel the answer if it says "not a question", so it never adds latency.

**Answers.** The LLM is chosen with `LLM_PROVIDER`, and the default is `gemini`. Both providers get the same prompt and memory and stream token by token. Only the SDK call differs.

- The system prompt fixes the format: first person, 4 or 5 one-sentence bullets, at most 90 words, no preamble. An earlier "60 to 90 words" wording produced 100 to 110 words, and per-bullet limits fixed it (now 54 to 60). It also forbids inventing resume facts and compresses behavioral answers into STAR form.
- The resume and JD sit in the system prompt, which stays identical all session, so both providers can cache it.
- **Gemini** defaults to `gemini-2.5-flash-lite` with thinking off. If it is overloaded (503/429/500) before any text arrives, the request retries once on `gemini-2.5-flash`, and later questions go straight to that model for 60 s instead of paying for a failing call each time. On the free tier, the 429 quota errors added about 1 s to every answer before this cooldown existed. On a free-tier key I timed time to first token per model (3 runs each):

  | Model | Time to first token |
  |---|---|
  | gemini-2.5-flash-lite | 0.9 to 1.7 s, no errors |
  | gemini-2.5-flash | about 1.1 s, 1 of 3 runs got a 503 |
  | gemini-3.1 / 3.5 flash-lite | 1.5 to 2.6 s |
  | gemini-3.5 / 3.6 flash (thinking LOW) | 3.6 to 5 s |
  | gemini-3.7 / 3.8 flash | 503 "high demand" on every run |

- **Claude** (`claude-opus-5-5`) runs at `effort: "low"`, with an explicit `cache_control` block and server-side refusal fallback.

**Nice-to-haves picked (2):**
1. **Conversation memory.** The last 5 Q&A pairs are sent as prior turns, so "and how would you scale that?" works.
2. **Latency metrics in the UI.** See below.

## Latency

The UI shows four numbers per answer:

| Metric | Meaning |
|---|---|
| Speech end → detected | Endpointing silence + any hold. Speech end is reconstructed from Deepgram word timestamps mapped to wall clock (`now − (audio sent − last word end)`) |
| Time to first token | LLM request → first answer token |
| Speech end → first token | **The number the target is about.** Green if ≤ 3 s |
| Full answer | Request → last token |

**Measured** (gemini-2.5-flash-lite). Interview audio was synthesized with `say` and streamed in real time through the real server and Deepgram with `scripts/replay.mjs`:

| Setup | Questions caught | Detection | Model TTFT | Speech end → first token |
|---|---|---|---|---|
| Deepgram `speech_final` + interim backup only | 2 of 2* | 0.9 s / **3.4 s** | 0.9 to 1.2 s | 1.8 s / **4.6 s** |
| + energy VAD at 400 ms | 9 of 10 (one first word clipped) | 0.7 to 1.0 s | 1.0 to 2.3 s | 2.0 to 3.0 s |
| + energy VAD at 600 ms (default) | 8 of 8 | 0.9 to 1.0 s (one 1.9 s) | 1.1 to 2.5 s | 2.0 to 3.5 s; 5 of 8 ≤ 3 s |

\* after the detector fixes; before them, the first question was lost.

Typed questions over the WebSocket: TTFT 0.8 to 1.2 s across 9 runs.

Detection is now steady at about 1 s. Gemini free-tier TTFT varies from 1.1 to 2.5 s between identical requests, and it is now the main reason some answers go over 3 s. Next steps:

- **Speculative generation:** start the LLM call at the VAD pause on the interim transcript and discard it if more speech arrives. This hides about 0.5 s of detection.
- **A paid or dedicated model tier** for steadier TTFT, or `LLM_PROVIDER=anthropic` with `ANSWER_MODEL=claude-haiku-5-5`.
- Prewarm the model connection when Start is pressed.

## Known limits / not done

- No WebSocket auto-reconnect. A dropped connection shows an error and asks for a reload. Reconnect was a third nice-to-have and I stayed within two.
- No speaker diarization. In mic mode the candidate's own speech can trigger answers; tab mode avoids this.
- The detector is English-only and rule-based. Its tests cover typical phrasings, not adversarial ones.
- One Deepgram stream per browser tab, no rate limiting. That's fine for a POC, not for multiple users.
- Context is capped at 20 k characters per field.
