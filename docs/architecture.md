# Gaia — Architecture (Cloud)

Gaia is a lifelong personal intelligence. This document is the architecture of
**Gaia-Cloud**, her server side: identity, cognition and memory. Her clients —
Gaia-Web and Gaia-Desktop — are *representations* of her, never a second place
she runs. They speak only the uniform Gaia API and never see a model, a provider
or a store address.

## The core model

| Facet | What it is | Where it lives |
| --- | --- | --- |
| **Gaia** | the agency — who she is | everywhere she is reached |
| **SOUL** | her constitution, loaded every turn | `services/gaia-api/identity/soul.md` |
| **Logos** | her cognitive faculty — interpretation, meaning & evidence, DecisionIQ | `services/gaia-api/src/logos/` + the deferred pass |
| **Cognition** | the store of everything *derived* (hypotheses, patterns, candidate models, open questions, relationships) and the lifecycle owner | `services/cognition` (Postgres) |
| **Hindsight** | long-term memory / the **derived knowledge store** — semantically indexable | external (Tailscale) |
| **Foundation** | **raw reality** — immutable observations, the ingestion gateway, MCP | external (`Bojanni050/Foundation`) |
| **Capabilities** | things Gaia reaches for, never defaults (Hermes, Melodiq, MCP, …) | optional, invoked explicitly |

Capabilities are the only optional layer. **Hindsight, SOUL, Logos and Cognition
are load-bearing** and are never folded into the capability set.

## Boundaries that are load-bearing

- **Foundation holds raw reality.** Everything entering it is an `observation`,
  stamped server-side; a client that claims a status is refused. It never stores
  a derived statement.
- **Logos reasons.** Intent interpretation, meaning & evidence, and DecisionIQ
  are prompt-level faculties of one faculty plus an asynchronous background
  reflection — not separate code subsystems. Logos emits *proposals*; it owns no
  truth.
- **Cognition owns the derived lifecycle.** A derived statement moves
  `proposed → testing → corroborated → confirmed | rejected`. Cognition only
  stores and books transitions; it never reasons.
- **Hindsight persists** the derived knowledge Gaia recalls. It is a *derived*
  store, rebuildable from Cognition with provenance.
- **Only a human confirms** — the Absolute Override. No model confidence, no
  corroboration, no automation reaches `confirmed`. That act lives in GaiaChat
  (`POST /cognition/hypotheses/:id/confirm`).

## The turn

A live turn is **direct generation**: `validate → SOUL/context prompt → gated
recall → one inference call (primary, backup on a retryable failure) → Response
Engine`. No synchronous Logos pre-flight, no planning/routing layer. Hermes is
never a fallback and never the generator. The single exception is the
**research reach**: on a research-with-sources turn Gaia submits a `run` at
Hermes naming the `grounded-citations` skill and does **not** wait for it. The
turn answers immediately; the findings are polled up later, written into the
conversation, and announced on `GET /research/jobs`. The answer stays Gaia's
(`src/researchReach.js`, `src/researchJob.js`, `src/researchRoutes.js`). A
research turn therefore requires a `conversationId` — the findings need a
conversation to land in; without one the turn simply answers.

After the reply is delivered, `runDeferredCognition` runs fire-and-forget and
never touches the reply:

1. **Observation registration** — the completed turn is registered in Foundation
   (raw).
2. **Memoryworthiness** — a cheap, deterministic gate for what deserves memory.
3. **Logos reflection** — over the turn (and, later, the Foundation observation
   delta): proposes hypotheses, patterns, open questions and relationships.
4. **Cognition writes** — proposals land in Cognition; confirmed statements
   mirror to Hindsight (`gaia:*`).
5. **Hindsight reflection** — gated, best-effort.

## Memory: what is stored where

```
Foundation (raw)            Cognition (derived lifecycle)          Hindsight (derived store)
observation · ingest ─────▶ hypothesis · pattern ·              ──▶ gaia:hypothesis
· MCP                       candidate model · open_question ·       gaia:pattern · gaia:confirmed_fact
                            relationship                          gaia:open_question · gaia:relationship
                            sources: ["foundation:<id>"]             status + provenance
```

- **Notebook ≠ memory.** Conversation history (`conversationStore`) saves every
  turn verbatim; it is not Hindsight and not Cognition.
- **The transcript is readable, literally.** Hindsight holds only what was
  judged worth remembering, so a lookup that asks what was *actually* said
  (`conversation_search`, `src/conversationSearch.js`) reads the raw transcripts
  instead. The turn reaches for it only on a lookup / past-reference signal, and
  never for the in-flight conversation (already in the prompt verbatim); clients
  reach the same seam at `GET /conversations/search`. It is the honest
  counterpart to reflection: the words, not the memory of them. A past-facing
  turn opens Hindsight recall too (`recallRelevantContext`'s `pastReference`),
  so what she understands and what was actually said are consulted together.
- **Provenance points back.** Every derived record carries the raw observation
  ids it was derived from.
- **Hindsight is derivable.** Sync is Cognition → Hindsight only; the mirror is
  rebuildable, and `npm run reconcile:hindsight` re-pushes it.
- **Three banks, split by origin.** `bojan` is the system-memory bank — the
  memoryworthiness-gated conversation reflection writes there, unchanged
  (the gate lives in `turn.js`). `gaia` is Gaia's own bank — her memories,
  her human side; hers alone, no gate. A background Aion pass
  (`reasoning/aion.js`, scheduled every few turns and when a session
  ends) asks her whether anything is hers to keep and writes what she answers
  there, tagged `gaia:aion`. The
  derived mirror above lives in its own `gaia-logos` bank. Per-turn recall
  spans all three, so a derived statement or one of her own memories is as
  surfaceable as a raw memory of Bo's. When the person asks her to remember
  something, the `remember` tool (`reasoning/memoryTool.js`) writes it to the
  system bank (`bojan`) — the explicit, in-conversation counterpart to Aion.
- **Recall reranks via a remote API, with an RRF fallback.** Hindsight's
  cross-encoder is pluggable; set to `local`/`flashrank` it scored 300
  candidates in 10–18 s on the VPS CPU — far past `hindsightClient.js`'s 4 s
  timeout, so the richest bank (`bojan`) was dropped on every turn (measured
  live 2026-10-12). It now uses Jina's rerank API (Cohere-compatible:
  `HINDSIGHT_API_RERANKER_PROVIDER=cohere`,
  `..._COHERE_BASE_URL=https://api.jina.ai/v1/rerank`, model
  `jina-reranker-v3.5`) with **`HINDSIGHT_API_RERANKER_1_PROVIDER=rrf`** as a
  second chain member — a reranker failure (Jina rate-limits: `429`) degrades to
  RRF order instead of failing the recall, which a bare 429 otherwise does
  (HTTP 500 for the whole bank). Config lives in Hindsight's own deploy env on
  the host (`/opt/hindsight/.env`) — **not in git**; the key lives there, file
  mode 600. After the switch: rerank ~0.3–1.1 s; `bojan` ~1.9 s, `gaia` ~0.7 s,
  `gaia-logos` ~1.8 s. `enable_reranking` stays `true` per bank. Sanity check on
  startup: `Reranker: provider=cohere` then `RRF passthrough provider initialized`.
  The per-call cap is configurable — `HINDSIGHT_TIMEOUT_MS` (default 4000 ms;
  8000 ms on the VPS) — a safety cap, not a latency target. A failed or
  timed-out Hindsight call logs a content-free `hindsight.call_failed` line
  (bank, op, reason `timeout`/`unreachable`, ms) to the container log, so a
  dropped call is visible instead of silently swallowed by the best-effort
  recall path.

## Derived lifecycle

```
proposed ──▶ testing ──▶ corroborated (machine, C ≥ 0.80) ──▶ confirmed (HUMAN ONLY)
    │           │                    │
    └───────────┴────────────────────┴──▶ rejected  ({ verwerp_bron: 'mens' | 'consolidatie' })
```

- `corroborated` may inform retrieval/behaviour; it is never presented as settled.
- Supersession: confirming a newer statement rejects the older contradicting one
  with `verwerp_bron: 'consolidatie'` and a pointer to the winner.

## Kairos — raw observations into narrative episodes

Chronos (raw clock time) and Kairos (narrative time) are kept apart. The raw
stream is Foundation's observations; **Kairos** folds a *cluster* of them into
one narrative episode — a derived statement, never a raw one, so it is always
`epistemic_status = 'interpretation'` and always carries `sources` back to its
observations (`['foundation:<uuid>']`).

```
Foundation (raw)                    services/gaia-api (Kairos)              Cognition (derived)
GET /api/memory/episodes  ─────▶    clusterer (0 tokens) ─▶ synthesizer ──▶  kairos_episodes
?since=&with_source=1               (admin 'kairos' role)     │             · interpretation
 · observation                      watermark worker          │             · sources → raws
                                    ─▶ emitter ─▶ GET /kairos/episodes/stream (SSE)
```

- **Deterministic first.** `clusterer.js` groups observations on a >5 min
  inactivity gap, an app switch, or a 30 min cap, spending zero LLM tokens. The
  trailing, still-open run is never finalized on a poll — it keeps growing into
  one episode instead of fragmenting.
- **Satellite synthesis.** `synthesizer.js` runs one cheap inference call under
  the admin-selected **Kairos** role (Logos's "younger sibling"). The model only
  returns a summary and an app name; the epistemic literals are set in code, and
  the model cannot name an app the cluster never saw.
- **Watermark is burst-safe.** The cursor (`captured_at`) advances only past the
  last cluster that actually completed; a failed cluster stops the batch so its
  observations are retried, never skipped. Mirrors Foundation's own reflection
  job.
- **Cognition only stores.** The worker writes episodes through
  `cognitionClient.createKairosEpisode`; `cognitionSync` mirrors them into
  Hindsight under `gaia:kairos_episode`. Clients reach episodes **only** through
  `/kairos/*` on Gaia API — never Cognition or Foundation directly.
- **Auditable.** `GET /kairos/episodes/:id/evidence` walks `sources` back to
  Foundation and returns the raw observations an interpretation was built from.
- Off by default: `GAIA_KAIROS_ENABLED=true` starts the worker.
- When on, each episode is also mirrored into Hindsight's `gaia-logos` bank
  (`gaia:kairos_episode`, versioned) so it is recallable. **Auto-consolidation is
  off for that bank** (`enable_auto_consolidation=false` — a Hindsight bank
  setting, not in git): the mirror keeps working, but a backfill episode no
  longer also triggers a consolidation round on top of its retain. Live evidence
  (2026-10-12, backfill running): Hindsight CPU ~48% → ~32% after the change.
- **The watermark is `captured_at`-safe.** The worker clusters on `observed_at`
  (event time) but Foundation's read seam filters on `captured_at` (ingest
  time); for a backfill those diverge (capture-rs ingests a year of events over
  a few days). `computeSafeWatermark` may only name a `captured_at` below which
  every observation is finalized, and never moves backwards — so a mid-run
  failure can never skip observations. A cluster whose episode already exists is
  skipped (no second model call), so the conservative re-fetch costs nothing.

## Eleos — coming back to a moment, unprompted

Kairos builds narrative time; **Eleos** acts in it. When someone says they are
having a hard time (or names something hard that is happening), Eleos notes it
as an open loop and — about a day later, outside the conversation — starts a
**new conversation** to ask how they are doing.

```
turn (deferred, never awaited)                later (background tick)
gate (free, bilingual)  ─ signal ─▶  model     due loop ─▶ politeness policy
  (reasoning/eleosSignals.js)   (role eleos)     ─▶ eleosVoice (role generation)
                                 ─▶ open loop      ─▶ NEW conversation written
                                    (eleos-intents) ─▶ GET /eleos/checkins (poll)
```

- **Gate-then-call.** Same shape as Logos: a free lexical gate
  (`reasoning/eleosSignals.js`) must fire before one model call
  (`reasoning/eleos.js`, role `eleos`; env fallback the reasoning role) is
  spent. The model returns one grounded loop (a short summary + the person's
  own quote) or an honest nothing, and can let a resolved loop go.
- **She speaks first.** The opening is generated by her own voice (the
  `generation` role) with the same constitution-first prompt a turn uses, and
  written into a NEW conversation (`eleos-<loopId>`) — so the check-in
  literally is Gaia starting a conversation. The message is grounded only in
  the loop's summary and quote; nothing is invented.
- **Never noisy (PRD's proactivity ceiling).** One check-in per rolling 24h; a
  recent turn defers delivery; quiet hours (default 22:00–08:00) defer unless
  the person is active then; delays are 20–28h. Off by default:
  `GAIA_ELEOS=true`.
- **Delivered like research.** The check-in is an ordinary assistant message in
  the conversation; `GET /eleos/checkins` (Bearer) lists `pending` and
  `delivered` metadata so a client can open `deliveredConversationId` and ack,
  surviving a closed window or a reconnect. `conversationStore`'s
  `/conversations/events` ping fires too.

## Clients

Clients reach Gaia only through the uniform Gaia API (`services/gaia-api`):
turns, the file library, chat history, speech, and the **GaiaChat review
surface** (`/cognition/*`) where the human confirms. `/admin/*` is operator-only
and never part of any client's contract.
Clients read live Kairos episodes at `GET /kairos/episodes` and stream them at
`GET /kairos/episodes/stream` (SSE) — both on Gaia API.
Clients discover Gaia-initiated check-ins at `GET /eleos/checkins` (poll) and
read the message itself as an ordinary turn in the new conversation it names.
Clients search the saved transcripts at `GET /conversations/search?q=`.
