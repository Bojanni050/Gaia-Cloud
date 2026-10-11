# Background Voice — Gaia Cloud Changes

Status: **proposed** (2026-10-11). Companion to `gaia-desktop/docs/background-voice-spec.md`,
which holds the full desktop design. This file lists only what Gaia Cloud must
provide. Nothing here is implemented.

**[verified]** = read in this repo on 2026-10-11. **[unverified]** = assumption to check first.

## Context

Desktop captures the microphone, detects a local wake word, cuts speech into
utterances with a local VAD, and sends each finished utterance to Cloud. The
transcript becomes an ordinary user turn through the existing
`POST conversation/turn` path. Cloud stays responsible for identity, reasoning
and memory; the new endpoint is a transport/adapter like `/speech`, not
cognition.

## Current state **[verified]**

- Speech routes are `GET /speech/info` and `POST /speech` only (`services/gaia-api/src/server.js`, ~609–668). Both are TTS (`src/speech/mimoTts.js`, `src/speech/mistralTts.js`).
- No speech-to-text route exists.
- `server.js` has no client-disconnect handling (`on('close')`, `AbortController`, `aborted` do not occur in it). Whether the rest of the service handles aborts is **[unverified]**.
- Speech modules are tested to have no dependency on Hermes, IntentIQ/ReasonIQ, the Decision Engine, the Orchestrator or the Response Engine (`test/mimoTts.test.js`, `test/mistralTts.test.js`). The new STT module must keep that property.

## C1. `POST /speech/transcribe`

Transcribes one finished utterance.

**Request** (authenticated like `/speech`, same `auth` middleware):
- Body: raw audio, `Content-Type: audio/wav` (16 kHz mono PCM s16le) — the desktop always sends this format.
- Optional header or query `language` hint (`nl`, `en`); absent = provider auto-detect.
- Size limit: reject above ~30 s of audio / ~1 MB with `413`.

**Response** `200`: `{ "text": string, "language": string | null }`. An empty `text` is valid (silence/noise) and is not an error.

**Errors** (calm and generic, same posture as `/speech`; never forward provider names, endpoints or underlying errors):
- `400` empty or unreadable body
- `413` too large
- `503` `{ "error": "speech recognition is not configured" }`
- `502` `{ "error": "gaia could not listen right now" }`

**Adapter:** new `src/speech/mistralStt.js` (first candidate: Mistral Voxtral transcription **[unverified]** — confirm the API shape, Dutch quality, latency and terms before building), with the same factory pattern as `mistralTts.js` (`createMistralStt({ baseUrl, apiKey, model, fetch })`). The provider is resolved through `providerStore` the way `resolveTtsConfig` does it, so the admin UI can configure it.

**Admin:** extend `adminRoutes.js` / `public/admin.html` with an STT provider block and a log (`GET /admin/api/stt/log`) mirroring `ttsLog`. The log records provider, model, audio duration, outcome, status and timing — **never the audio and never the transcript text** (the TTS log's 80-char `preview` must not be copied here).

**Info:** add `GET /speech/stt-info` → `{ configured, provider, languages }` so the desktop can hide the microphone controls when STT is unavailable.

**Privacy:** audio is held in memory for the request only, never written to disk, never forwarded to Hermes/Hindsight. Only the resulting text enters the normal turn path.

**Tests** (in the existing style under `services/gaia-api/test/`):
- adapter unit tests with an injected fetch (success, empty result, provider error → calm 502)
- route tests: auth required, 400/413/503/502, no transcript or provider detail in error bodies
- a source-level test that `mistralStt.js` references none of Hermes, IntentIQ/ReasonIQ, the Decision Engine, the Orchestrator or the Response Engine
- a test that the STT log never contains audio or text

## C2. Turn abort on client disconnect

Desktop will interrupt Gaia mid-reply. When it does, it closes the streaming connection to `POST conversation/turn` (SSE).

**Required behaviour:**
1. Detect the closed connection on the streaming turn and abort generation upstream (propagate an `AbortSignal` into `performStreamingTurn` / the generator and Hermes call) so no tokens are spent after the interruption.
2. **Saved transcript:** save the assistant text streamed so far, marked interrupted, rather than dropping the turn. Proposed message field: `interrupted: true`. The desktop and gaia-web must tolerate the extra field when reading history **[unverified]**.
3. **Reflection:** per the existing rule that an aborted turn reflects nothing (`docs/evolution.md`: "an aborted or failed turn reflects nothing"), an interrupted turn must not trigger reflection into Hindsight.
4. No stack traces or provider detail to the client; the connection is already gone.

**Tests:** abort mid-stream stops upstream work; partial text is saved with `interrupted: true`; no reflection call is made; a normal completed turn is unchanged.

Open question: how the existing non-desktop clients (gaia-web) already abort a stream, and whether that path already covers this **[unverified]**.

## C3. Optional voice-modality hint

Add an optional `modality: "voice"` field to the `conversation/turn` body. Cloud decides what to do with it (for example a shorter, speakable answer style through the Response Engine); the desktop only reports how the user spoke and never shapes the reply.

- First confirm the turn body parser tolerates unknown fields today **[unverified]**.
- If Cloud ignores it initially, the feature is a no-op and nothing breaks.
- Must not alter what is stored as the user's message text.

## Rollout order

1. C1 first — Desktop Phase 2 (push-to-talk) depends on it.
2. C2 — Desktop Phase 3 (barge-in) depends on it.
3. C3 — independent, any time.

## Acceptance

- A WAV utterance in Dutch and in English returns correct text through `/speech/transcribe` with a valid token, and `401` without one.
- With STT unconfigured, `/speech/stt-info` reports `configured: false` and `/speech/transcribe` returns `503`.
- Disconnecting a streaming turn stops generation and leaves a saved, interrupted partial reply with no reflection.
- No audio or transcript text appears in server logs, the admin STT log, or error responses.
