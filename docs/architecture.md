# Gaia — Architecture (Cloud)

> **Verified against code: commit `0ac3e45` (2026-11-11).** Every path, route, flag
> and literal in this document was read from the tree on that commit. Everything
> that lives outside this repository is marked *(external)* or *(deployment)* —
> those are precisely the places this document can drift while nothing here
> changes. A claim about Foundation, Hindsight, Gaia-Web or Gaia-Desktop cannot be
> checked from this repo and is worded as such.

Gaia is a lifelong personal intelligence. This document is the architecture of
**Gaia-Cloud**, her server side: identity, cognition and memory. Her clients —
Gaia-Web and Gaia-Desktop — are *representations* of her, never a second place
she runs. They speak only the uniform Gaia API and never see a model, a provider
or a store address.

## The core model

| Facet | What it is | Where it lives |
| --- | --- | --- |
| **Gaia** | the agency — who she is | everywhere she is reached |
| **SOUL** | her constitution, loaded every turn (`loadSoul`, `SOUL_PATH`) | `services/gaia-api/identity/soul.md` |
| **Logos** | her cognitive faculty — interpretation, meaning & evidence, DecisionIQ: a prompt-level faculty plus one asynchronous background reflection | `services/gaia-api/src/logos/` |
| **Cognition** | the store of everything *derived* — hypotheses (kinds: hypothesis, mental model, relationship, open question), patterns, observations, Kairos episodes — and the lifecycle owner | `services/cognition` (Postgres) |
| **Hindsight** | long-term memory / the derived store — semantically indexable, three banks | *(external, Tailscale)* |
| **Foundation** | raw reality — immutable observations, the ingestion gateway, MCP | *(external, `Bojanni050/Foundation`)* |
| **Capabilities** | things Gaia reaches for, never defaults | optional, derived per turn |

Capabilities are the only optional layer. **Hindsight, SOUL, Logos and Cognition
are load-bearing** and are never folded into the capability set.

The set of capabilities and the skills they expose is recorded in one place,
`services/gaia-api/src/capabilityRegistry.js` — frozen metadata plus pure lookup
helpers, zero requires and zero I/O. Its ids are `hermes`, `native`, `research`,
`web_search`, `conversation_search`, `hindsight`, `memory`, `memory_retraction`,
`memory_forgetting`, `own_memory`, `foundation`, `desktop` and `tool`. The
registry also carries `routing: true` flags on a few Hermes skills; those are
*data* (read by `researchReach.js`), not routing logic. The only routing decision
in the codebase is whether to submit a research run.

Which capabilities Gaia may claim is derived **per turn** in `turn.js`'s
`generationCapabilities`: an entry appears only when its tool or client is
actually wired *this* turn (the tool's presence is what makes the claim honest).
She is never told she can do something she cannot.

**`desktop`** (Desktop Commander) is a capability of the *person's own computer*,
not of the server: Gaia-Cloud never executes anything on it. Gaia-Desktop runs
Desktop Commander locally and is the executor. Gaia claims `desktop` only on a
**streamed** turn whose client sent `desktop: true` *and* when the broker is up.
Reads and searches run freely; writes and commands need the person's confirmation
in the client; `open-url` is policy-free. The server sets the policy
(`desktopBroker.js`'s `SKILL_POLICY`) and the client may only tighten it. Off
unless `GAIA_DESKTOP=true`; see `desktop-capability.md` for the full flow.
*(The executor half — `desktop/src/state/desktopActions.js`, the Tauri MCP client
in `src-tauri/src/mcp/` — lives in the Gaia-Desktop repo, not here.)*

## Boundaries that are load-bearing

- **Foundation holds raw reality.** Everything entering it is an `observation`:
  Gaia-Cloud's write seam (`foundationClient.submitObservation`) sends no status
  field at all, and Foundation refuses a client that claims one. Gaia-Cloud never
  writes a derived statement into it. *(Foundation's own epistemic tables and its
  switched-off automatic layer are external and not verifiable from here.)*
- **Logos reasons.** Intent interpretation, meaning & evidence, and DecisionIQ are
  prompt-level faculties of one faculty plus an asynchronous background reflection
  — not separate code subsystems. Logos emits *proposals*; it owns no truth and
  writes to no database itself.
- **Cognition owns the derived lifecycle.** A derived statement moves
  `proposed → testing → corroborated → confirmed | rejected | expired`. Cognition
  only stores and books transitions; it never reasons.
- **Hindsight persists** the derived knowledge Gaia recalls. It is a *derived*
  store, rebuildable from Cognition with provenance.
- **Only a human confirms** — the Absolute Override. No model confidence, no
  corroboration, no automation reaches `confirmed`. That act is reached from
  GaiaChat at `POST /cognition/hypotheses/:id/confirm`, which calls Cognition's
  own `POST /v1/banks/:bankId/hypotheses/:id/confirm`.

## The turn

A live turn is **direct generation**:

```
validate + auth → resolve attachments (library → text | vision OCR)
  → gated recall (parallel) → prompt assembly (SOUL + recall blocks + capability awareness)
  → ONE inference call (primary; backup on a retryable, pre-output failure)
  → Response Engine
```

Note the order: **recall runs before the prompt is assembled** — `turn.js` calls
`recallForTurn` and only then builds the system prompt out of what came back.
There is no synchronous Logos pre-flight, no planner, no router and no decision
engine: the intent classifier that once produced a decision was removed, so
`intentDecision` is deliberately `null` on the live path and every gate runs on
the one `shape` reading of the turn.

Recall is a parallel fan-out, every leg best-effort (a failed leg returns
nothing and never fails the turn): Hindsight reflections, the seven standing
mental models, patterns (only on a retrieval signal), knowledge pages, Foundation
archive asks (only when the turn asks what is *recorded*), conversation search
(only on a lookup / archive signal), the open-question raise, and the research
reach.

The reply is delivered either as one JSON `{ reply }` or, with `{ stream: true }`,
as an SSE frame family (`step`, `research`, `memory`, `desktop`, `title`,
`error`). The **Response Engine** (`src/responseEngine.js`) owns both wire
formats and is the only place a reply reaches a client: no provider name, model
name, transport detail or stack trace crosses that seam (`toCalmError`).

**Hermes is never a fallback and, in the live server path, never the
generator**: `server.js` does not hand `hermes` into a turn at all. A legacy
`adaptHermesToGenerator` early-return still exists in `resolveLiveGenerators`
for non-server callers, and is the one way Hermes could become the primary — dead
code in production, not a design decision.

**Tools inside the one inference call.** The generator may call tools within the
single inference call, bounded by `maxToolRounds`
(`generation/gaiaGenerator.js`, `DEFAULT_MAX_TOOL_ROUNDS = 3`). That is three
*rounds*, and every call inside a round runs — so the bound is not "three tool
calls". The real tool names:

| Tool | Where | Gated by |
| --- | --- | --- |
| `remember` (→ `bojan`), `keep` (→ `gaia`), `search_memory`, `retract_memory`, `forget_memory` | `reasoning/memoryTool.js` | `GAIA_MEMORY_TOOL` (one flag for all five) |
| `web_search` | `reasoning/webSearchTool.js` | presence of `GAIA_WEB_SEARCH_API_KEY` |
| `read_back` | `reasoning/conversationTool.js` | the transcript seam being wired |
| `desktop` | `desktopBroker.js` | `GAIA_DESKTOP` + client `desktop: true` + streamed turn |

There is no tool named `conversation_search` — that is the *capability* id, and
`read_back` is the tool behind it.

## Deferred cognition (after the reply)

`runDeferredCognition` runs fire-and-forget and never touches the delivered
reply. The code numbers its own steps 1–8, with two side tasks that start as soon
as their input exists and are awaited together at the end:

```
side tasks (concurrent, awaited last)
  1   Foundation.submitObservation — the completed turn as a RAW observation
  7b  Aion — Gaia's own bank (`gaia`), ungated, at her own discretion
  7c  Eleos — the check-in faculty: gate now, deliver hours later

sequential chain
  2   Memoryworthiness — cheap deterministic gate (six dimensions)
  3a  hypothesis lifecycle preparation (manager + Hindsight recall seeding)
  3b  background Logos reflection — the depth gate decides whether ONE model
      call happens at all
  4   applyReasoningResult — the structured result into the manager
  5   gated pattern formation (needs ≥1 durable hypothesis changed by this turn,
      and a non-discarded turn)
  6   Cognition retention of observations, open questions and relationships
      (deliberately ignores the Memoryworthiness gate: Gaia-knowledge, not
      conversational memory)
  7   post-turn Hindsight reflection — gated by Memoryworthiness
  8   DecisionIQ review — post-turn observability only
```

Nothing in this phase can reach the user: the reply was delivered before it
started, and the transport never awaits it.

## Memory: what is stored where

```
Foundation (raw)            Cognition (derived lifecycle)        Hindsight (derived store)
observation · ingest ─────▶ hypothesis (kind: hypothesis ·       ──▶ gaia:hypothesis
· MCP                       mental_model · relationship ·             gaia:mental_model
                            open_question) · pattern ·               gaia:pattern
                            observation · kairos_episode             gaia:confirmed_fact
                            sources: ["foundation:<uuid>"]           gaia:open_question
                                                                     gaia:relationship
                                                                     gaia:kairos_episode
```

- **Notebook ≠ memory.** Conversation history (`conversationStore`) saves every
  turn verbatim; it is not Hindsight and not Cognition.
- **The transcript is readable, literally.** Hindsight holds only what was judged
  worth remembering, so a lookup that asks what was *actually* said
  (`conversation_search`, `src/conversationSearch.js`) reads the raw transcripts
  instead — saved conversations only; searching the in-flight one would only
  duplicate what is already in the prompt verbatim. The turn reaches for it only
  on a lookup / past-reference signal; clients reach the same seam at
  `GET /conversations/search`. A past-facing turn also opens Hindsight recall
  (via `recallRelevantContext`'s `pastReference`), so what she understands and
  what was actually said are consulted together.
- **Provenance points back.** Every derived record carries the raw observation ids
  it was derived from, and `reasoning/evidenceRecall.js` +
  `reasoning/evidenceAssembler.js` walk them back to the literal Foundation
  records for the turn they were cited in.
- **Hindsight is derivable.** Sync is Cognition → Hindsight only;
  `reasoning/cognitionSync.js` owns the `gaia:*` namespace. The mirror is
  rebuildable, and `npm run reconcile:hindsight` re-pushes it — **dry-run unless
  `--apply` is passed** (`--apply --clear` invalidates `gaia:*` first).
- **Three banks — and per-turn recall does *not* span all three.** Since
  2026-10-23, measured that day (`server.js`, and the comment there is the
  argument):
  - `bojan` — the system-memory bank. The memoryworthiness-gated conversation
    reflection writes there (the gate lives in `turn.js`), and it is the *only*
    bank that fills the nine recall lines on an ordinary turn.
  - `gaia` — Gaia's own bank, hers alone, no gate. Two writers: the background
    Aion pass (`reasoning/aion.js`, tagged `gaia:aion`) and the on-demand `keep`
    tool. It joins recall **only when the turn asks about her**.
  - `gaia-logos` — the derived mirror (`gaia:*`). It takes **no lines of its own**
    in a turn; it is put back only by setting `HINDSIGHT_RECALL_BANK_IDS`.
    The *full* three-bank client is what `search_memory` uses: when she looks
    something up herself, her own notes and the derived knowledge are memory too.
    So a derived statement is reachable — just not as surfaceable on an ordinary
    turn as a raw memory of Bo's, deliberately.
- **Reading back, and taking back, are first-class verbs on both sides.**
  `search_memory` opens an ungated cross-bank lookup, so a phrasing that missed
  the lexical recall gate is no longer a dead end. `retract_memory` /
  `forget_memory` — and `POST /memory/retract` / `POST /memory/forget` for clients
  — are the person's own way to take something back: retracting judges the
  statement false, forgetting says only that it should not be recalled.
- **Recall reranking and the call cap.** `HINDSIGHT_TIMEOUT_MS` caps every
  Hindsight call (client default 4000 ms, `hindsightClient.js`) — a safety cap,
  not a latency target. A failed or timed-out call logs a content-free
  `hindsight.call_failed` line (bank, op, reason `timeout`/`unreachable`, ms)
  instead of being silently swallowed by the best-effort recall path.
  *(The reranker chain itself — `HINDSIGHT_API_RERANKER_*`, the Jina/Cohere
  endpoint, the RRF second chain member, per-bank `enable_reranking` and
  `enable_auto_consolidation` — lives in Hindsight's own deploy env on the host,
  not in git, and cannot be verified from this repository.)*

## Derived lifecycle

```
                            ┌──────────── verlopen: machine, no evidence, 14 days ─────────┐
                            ▼                                                             │
proposed ──▶ testing ──▶ corroborated ──▶ confirmed (HUMAN ONLY)                          │
    │           │        (micro + testing + C ≥ 0.80 + no counter-evidence)               │
    │           │                 │                                                       │
    └───────────┴─────────────────┴──────────▶ rejected  ({ verwerp_bron: 'mens' | 'consolidatie' })
                                                                                          │
    expired is NOT a quarantine: later evidence revives it (expired → testing) ◀───────────┘
```

- Six statuses, enforced by Cognition's transition table
  (`services/cognition/src/hypotheses.js`): `proposed`, `testing`,
  `corroborated`, `confirmed`, `rejected`, `expired`.
- `verwerp_bron` has **three** values: `mens` (a person dismissed it),
  `consolidatie` (a newer statement superseded it), `verlopen` (the machine's own
  lapse reason — kept apart from the other two because nothing was judged).
- **`corroborated` is the machine tier and it is narrow.** `isSoftPromotable`
  (`hypothesisManager.js`) requires `scope === 'micro'` (a `macro` claim — the
  safe default — always waits for the person), `status === 'testing'`, confidence
  ≥ `softPromoteConfidence` (0.8) and no contradicting evidence. It may inform
  retrieval and behaviour; it is never presented as settled, and a contradiction
  demotes a corroborated micro back to `testing` — the same rule a confirmed
  statement gets.
- **`expired` is a lapse, not a judgement.** Only an evidence-less `proposed`
  statement can lapse; nothing is deleted and nothing is quarantined, so evidence
  arriving later revives it (`expired → testing`, `reasoning/expiryScan.js`).
- **Supersession** rejects the older contradicting statement with
  `verwerp_bron: 'consolidatie'` and a `superseded_by_id` pointer to the winner.
- **Human verbs**, all reachable from the review surface: `test`, `reject`,
  `reopen` (the only exit from the `rejected` quarantine), `correct` (rewording a
  settled statement), `answer` (an open question) and `confirm`. `reject` and
  `reopen` require a stated reason; a `macro` confirmation requires a `rationale`
  and a quarantined counter-hypothesis.

## Background passes

Loops that change the store with no turn involved, and therefore need their own
description:

| Pass | File | Default | What it does |
| --- | --- | --- | --- |
| Soft-promotion scan | `reasoning/softPromotionScan.js` | on | promotes stranded `micro` hypotheses stuck in `testing` to `corroborated` |
| Expiry pass | `reasoning/expiryScan.js` | on | lapses evidence-less `proposed` hypotheses after `GAIA_HYPOTHESIS_EXPIRY_DAYS` (14) |
| Belief formation | `reasoning/beliefFormationScan.js` | on | the ONLY thing that forms a statement from observations — it needs repeated ground (the same `sourceRef` in more than one conversation, or overlapping Hindsight recall ground) |
| Aion | `reasoning/aion.js` + `aionScheduler.js` | on | when the scheduler says so (every few turns, on a session change, and when a session goes idle), asks Gaia whether anything is hers to keep and writes her answer to her own bank |
| Logos depth gate | `logos/logos.js` | social filter | a social turn (greeting, thanks, ack, farewell) is shallow and costs nothing; every other turn gets one deep background reflection |

Per-turn hypothesis formation is **off** by default (Optie 2): a claim must rest
on repeated ground, not on one turn's recall slice.
`GAIA_HYPOTHESIS_FORMATION=per_turn` restores the old behaviour.

## Kairos — raw observations into narrative episodes

Chronos (raw clock time) and Kairos (narrative time) are kept apart. The raw
stream is Foundation's observations; **Kairos** folds a *cluster* of them into one
narrative episode — a derived statement, never a raw one, so it is always
`epistemic_status = 'interpretation'` and always carries `sources` back to its
observations (`['foundation:<uuid>']`, `foundationRef.js`).

```
Foundation (raw)                    services/gaia-api (Kairos)              Cognition (derived)
GET /api/memory/episodes  ─────▶    clusterer (0 tokens) ─▶ synthesizer ──▶  kairos_episodes
?since=&with_source=1               (admin 'kairos' role)     │             · interpretation
 · observation                      watermark worker          │             · sources → raws
                                    ─▶ emitter ─▶ GET /kairos/episodes/stream (SSE)
```

- **Deterministic first.** `clusterer.js` groups observations on a >5 min
  inactivity gap, an app switch, or a 30 min cap, spending zero LLM tokens. The
  trailing run is *not* finalised while it is still recent — but once it has been
  quiet longer than the inactivity window (measured against *now*) or hits the
  30 min cap, it **is** finalised on that poll. A session therefore ends in one
  closed episode instead of an open one nobody ever closes.
- **Satellite synthesis.** `synthesizer.js` runs one cheap inference call under
  the admin-selected **Kairos** role (Logos's "younger sibling"). The model
  returns a **title**, a summary and an app name; the epistemic literals are set
  in code, and the model cannot name an app the cluster never saw. A messaging
  app gets a higher fragment cap — the content under the header is the point.
  The episode is a **work report, not a screen log**: what he read, wrote,
  decided, sent or fixed and what came of it, with names, files, amounts,
  errors and literal quotes. Opening, clicking and switching are at most the
  run-up; an app is named only when the app itself is the subject. Where a
  cluster holds nothing but navigation, the episode says so in one or two
  sentences instead of narrating the clicks, and it keeps to "Bojan/hij" in
  active voice — never "de gebruiker".
- **Watermark is burst-safe.** The cursor (`captured_at`) advances only past the
  last cluster that actually completed; a failed cluster stops the batch so its
  observations are retried, never skipped, and the cursor never moves backwards
  (`computeSafeWatermark`). The worker clusters on `observed_at` (event time)
  while Foundation's read seam filters on `captured_at` (ingest time) — for a
  backfill those diverge (capture-rs ingests a year of events over a few days),
  which is exactly why the watermark is conservative. A cluster whose episode
  already exists is skipped (no second model call), so the conservative re-fetch
  costs nothing.
- **Only activity observations are clustered.** `source_type ===
  'system-observation'` (what capture-rs feeds). `chat-import` (Chronicle-Gaia
  already summarises those) and `document` are filtered out *before* clustering —
  one owner per job — and a missing or unknown `source_type` is skipped too, never
  silently kept; the per-source counts are logged. Skipped observations count as
  done for the watermark, so a chat-only batch still advances.
- **Cognition only stores.** The worker writes episodes through
  `cognitionClient.createKairosEpisode`; `cognitionSync` mirrors them into
  Hindsight under `gaia:kairos_episode` (versioned) in the `gaia-logos` bank.
  Clients reach episodes **only** through `/kairos/*` on Gaia API — never
  Cognition or Foundation directly.
- **Auditable.** `GET /kairos/episodes/:id/evidence` walks `sources` back to
  Foundation and returns the raw observations an interpretation was built from.
- **Day digest.** `digest.js` folds one **closed** day's episodes into a Dutch
  overview of 90–220 words in 2–4 paragraphs (`kairos_digests` in Cognition, one
  row per bank per day, `episode_ids` back to the episodes). The prompt is
  explicitly about *what was done* — the work, its outcome, names, amounts and
  decisions — not which window was opened; an app is named only when the app is
  the subject. The scheduler writes yesterday's after
  `GAIA_KAIROS_DIGEST_HOUR` (07:00) in `GAIA_KAIROS_DIGEST_TIMEZONE`
  (`Europe/Amsterdam`); `POST /kairos/digest` writes any closed day on demand,
  and `GET /kairos/digests` / `GET /kairos/digest?date=` read it back. Before
  the model sees them, low-signal episodes (no quote and under ~200 chars) are
  dropped, each keeps up to 600 characters, and a busy day is sampled evenly
  rather than truncated; a day with no
  episodes — or fewer than `GAIA_KAIROS_DIGEST_MIN_EPISODES` (5) — writes no row
  and spends no tokens, so a quiet day stays honestly empty instead of becoming
  a one-line "je keek wat rond". A forced write (`POST … {"force": true}`, the
  Command Center's *Herschrijf*) may go under that floor. The Command Center
  shows the latest overview at the top of the Kairos tab.
- Off by default. `GAIA_KAIROS_ENABLED=true` starts the worker, which polls every
  `GAIA_KAIROS_INTERVAL_MS` (30 s) and finalises at most
  `GAIA_KAIROS_MAX_CLUSTERS_PER_RUN` (120) clusters per run. Turned on without a
  Kairos model, reads and the stream still serve whatever already exists.
  *(The `gaia-logos` bank's `enable_auto_consolidation=false` is a Hindsight bank
  setting on the host, not in git.)*

## Eleos — coming back to a moment, unprompted

Kairos builds narrative time; **Eleos** acts in it. When someone says they are
having a hard time (or names something hard that is happening), Eleos notes it as
an open loop and — about a day later, outside the conversation — starts a **new
conversation** to ask how they are doing.

```
turn (deferred, never awaited)                later (background tick)
gate (free, bilingual)  ─ signal ─▶  model     due loop ─▶ politeness policy
  (reasoning/eleosSignals.js)   (role eleos)     ─▶ eleosVoice (role generation)
                                 ─▶ open loop      ─▶ NEW conversation written
                                    (eleos-intents) ─▶ GET /eleos/checkins (poll)
```

- **Gate-then-call.** Same shape as Logos: a free lexical gate
  (`reasoning/eleosSignals.js`) must fire before one model call
  (`reasoning/eleos.js`, role `eleos`; env fallback the reasoning role) is spent.
  The model returns one grounded loop (a short summary + the person's own quote)
  or an honest nothing, and can let a resolved loop go. A new moment in the same
  conversation *updates* the open loop instead of creating a second one.
- **She speaks first.** The opening is generated by her own voice (the
  `generation` role) with the same constitution-first prompt a turn uses, and
  written into a NEW conversation (`eleos-<loopId>`) — so the check-in literally
  is Gaia starting a conversation. The message is grounded only in the loop's
  summary and quote; nothing is invented.
- **Never noisy (the PRD's proactivity ceiling).** One check-in per rolling 24h
  (`GAIA_ELEOS_MAX_PER_DAY`); a recent turn defers delivery
  (`GAIA_ELEOS_ACTIVE_MS`); quiet hours (22:00–08:00, local to
  `GAIA_ELEOS_TIMEZONE`) defer *unless the person is active then*; delays are
  20–28h, with the model's proposal clamped to those bounds. Off by default;
  `GAIA_ELEOS=true` enables it.
- **Delivered like research.** The check-in is an ordinary assistant message in
  the conversation; `GET /eleos/checkins` (Bearer) lists `pending` and
  `delivered` metadata (with `deliveredConversationId`) so a client can open the
  conversation and `POST /eleos/checkins/:id/ack`, surviving a closed window or a
  reconnect. The conversation-list SSE ping fires too.

## Research reach, web search, open-question reach

Three narrow, explicitly-opted-in ways Gaia reaches outside a turn — deliberately
different things with deliberately separate switches:

- **Research reach** (`GAIA_RESEARCH_REACH=on`): on a research-with-sources turn
  Gaia submits a `run` at Hermes naming the `grounded-citations` skill and does
  **not** wait for it. The turn answers immediately; the findings are polled up
  later, written into the conversation, and announced on `GET /research/jobs`. A
  research turn therefore requires a `conversationId` — the findings need a
  conversation to land in; without one the turn simply answers. A long run
  checks in in the conversation itself, and a parked run can be answered at
  `POST /research/jobs/:id/approval`. Off by default.
- **Web search** (needs `GAIA_WEB_SEARCH_API_KEY`): one HTTP call inside the turn,
  a handful of results with their URLs, seconds. No agent, no job, no outbox. No
  key means no tool — so the capability is not claimed at all.
- **Open-question reach** (`GAIA_OPEN_QUESTION_REACH=on`): the one place Gaia may
  bring one of her own unanswered questions up herself — at most one per turn, in
  the conversation the question came from or a new one about the same subject,
  never more than three times in total, and only once the retry term has passed.
  Raising changes nothing: the question stays open until the person answers it.

## Switches

Optional behaviour is controlled by environment flags, read through
`createApp(env = process.env)`; a module that owns a subsystem reads its own flag
(Kairos reads its own in `src/kairos/runtime.js`). **The idiom is not uniform** —
some flags are `'true'`, some `'on'`, some disable only on an exact `'false'` —
so the table states the real semantics per flag.

| Flag | Default | Where read | Turns on / off |
| --- | --- | --- | --- |
| `GAIA_KAIROS_ENABLED` | off | `kairos/runtime.js` | the Kairos episode worker (`'true'` enables) |
| `GAIA_ELEOS` | off | `server.js` | Eleos check-ins (`'true'` enables) |
| `GAIA_DESKTOP` | off | `server.js` | the `desktop` capability, its broker and `/desktop/*` (`'true'` enables) |
| `GAIA_RESEARCH_REACH` | off | `server.js` | research jobs at Hermes (only the literal `'on'` enables) |
| `GAIA_OPEN_QUESTION_REACH` | off | `server.js` | Gaia re-raising her own open question (`'on'` enables) |
| `GAIA_AION` | on | `server.js` | the Aion pass (`'false'` disables) |
| `GAIA_MEMORY_TOOL` | on | `server.js` | **all five** memory tools (`'false'` disables); the `/memory/*` routes are independent of it |
| `GAIA_HYPOTHESIS_PERSISTENCE` | on | `server.js` | the whole derived-knowledge runtime: manager, pattern manager, knowledge adapter, open-question reach and the three scans (`'false'` disables) |
| `GAIA_HYPOTHESIS_FORMATION` | `'beliefs'` | `server.js` | per-turn hypothesis formation — off unless `'per_turn'` |
| `GAIA_HYPOTHESIS_SCAN` | on | `softPromotionScan.js` | only the literal `'true'` (or unset) keeps it on |
| `GAIA_HYPOTHESIS_EXPIRY` | on | `expiryScan.js` | same shape; `GAIA_HYPOTHESIS_EXPIRY_DAYS` = 14 |
| `GAIA_BELIEF_FORMATION` | on | `beliefFormationScan.js` | same shape; `GAIA_BELIEF_RECALL_GROUND` on unless `'false'` |
| `GAIA_LOGOS_SOCIAL_GATE` | social filter | `logos/logos.js` | `'off'` restores the legacy depth gate |
| `GAIA_NATIVE_SUPPORTS_VISION` | `false` | `server.js` | whether image bytes go to the generator or are OCR-described first |
| `GAIA_WEB_SEARCH_API_KEY` | unset | `webSearchClient.js` | presence gate: no key ⇒ no `web_search` tool and no capability |
| `HINDSIGHT_RECALL_BANK_IDS` | unset | `server.js` | puts `gaia-logos` back into the passive recall set |
| `MEMORY_MAX_LINES` | 9 | `server.js` | how many recall lines may reach the prompt |
| `HINDSIGHT_TIMEOUT_MS` | 4000 | `hindsightClient.js` | the per-Hindsight-call cap, not a latency target |
| `GAIA_API_TOKEN` | unset | `auth.js` | comma-separated client tokens; **unset means fail closed** |

Subsystems wired by *presence* rather than a boolean: `GAIA_NATIVE_BASE_URL` /
`GAIA_NATIVE_MODEL` (no generator ⇒ a calm 503), `GAIA_BACKUP_*` (no failover),
`FOUNDATION_URL` (no Foundation seam), `COGNITION_URL`, `GAIA_TTS_*` and
`GAIA_STT_*` (503 when unset), and every provider key (`<PROVIDER>_API_KEY`, plus
`HOPSCOTCH_KEY`).

Models and storage paths are configured per role through further `GAIA_*`
variables and the admin provider settings; the full annotated list lives in
`services/gaia-api/.env.example`.

## HTTP surface

All client routes require the Bearer token. `/admin` is operator-only and never
part of a client's contract — but note it shares the *same* Bearer token, and its
HTML shell (`GET /admin`) is unauthenticated.

| Mount | Routes |
| --- | --- |
| inline | `GET /health`, `GET /`, `GET /soul`, `POST /conversation/turn` (JSON or SSE), `GET /speech/info`, `GET /speech/stt-info`, `POST /speech`, `POST /speech/stream`, `POST /speech/transcribe` |
| `/library` | `POST /files`, `GET /files`, `GET /files/:id`, `DELETE /files/:id` |
| `/conversations` | `GET /`, `GET /events` (SSE), `GET /search?q=`, `GET /:id`, `GET /:id/export/:format`, `DELETE /:id` |
| `/cognition` | `GET /hypotheses`, `POST /hypotheses/:id/{test,reject,reopen,correct,answer,confirm}` |
| `/memory` | `POST /retract`, `POST /forget` |
| `/kairos` | `GET /episodes`, `GET /episodes/stream` (SSE), `GET /episodes/:id/evidence` |
| `/eleos` | `GET /checkins`, `POST /checkins/:id/ack` |
| `/research` | `GET /jobs`, `POST /jobs/:id/ack`, `POST /jobs/:id/approval` |
| `/desktop` | `POST /actions/:id/decision`, `POST /actions/:id/result` — mounted only when `GAIA_DESKTOP=true` |
| `/admin` | ~30 API routes: provider config / roles / keys / models, backup, TTS (default and English), STT, the durable Logos decision log, activity logs |
| `/api` | `GET /version` — **public, no auth** |

Cognition's own service speaks
`POST|GET|PATCH|DELETE /v1/banks/:bankId/{hypotheses,patterns,episodes,observations}`
and is unauthenticated, bound to the tailnet — the same posture as Hindsight and
Foundation. Clients never reach it directly.

## These documents are runtime content

Six documents in this repo are not only read by people. `scripts/build-foundation-artifact.js`
bundles `services/gaia-api/identity/soul.md` with `docs/principles.md`, `docs/lexicon.md`,
`docs/identity.md`, `docs/architecture.md` and `docs/evolution.md` into
`foundation-artifact.json`; `publish-foundation.yml` publishes that file as the
`foundation-latest` release on every push touching `docs/**` or `soul.md` (and then triggers a
Gaia-Web rebuild), and `deploy.yml` materializes it into `services/gaia-api/` so the container
bakes it in. gaia-api refuses to start without it (`foundation.js`).

Per turn, `src/foundation.js` classifies the last three user messages and picks the set —
joined with `\n\n---\n\n` in selection order, silently skipping a document the artifact does
not carry:

| Intent | Documents in the system prompt |
| --- | --- |
| technical (`implement`, `refactor`, `architecture`, `code`, `bug`, `api`, `database`, `deploy`, …) | `soul.md` + `principles.md` + `lexicon.md` + **`identity.md`** |
| gaia (`who are you`, `how do you think`, `wat zijn je principes`, `evolutie`, …) | `soul.md` + `principles.md` + `lexicon.md` + **`identity.md`** |
| conversation (everything else) | `soul.md` + `principles.md` + `lexicon.md` |

**Narrowed on 2026-11-11.** Until then the technical branch carried `architecture.md`
(~33 kB ≈ 8k tokens) and the gaia branch `evolution.md` (~131 kB ≈ 33k tokens) — the two
heaviest documents in the repo, on any turn that happened to contain words like `code`,
`api`, `fout` or `evolutie`. A turn now carries `identity.md` instead: the self-knowledge
those two had in common, ~7 kB. Both full documents stay in the artifact — they are the
reference, and Gaia-Web's own copy of the selection rules is in that repository, unchanged
by this.

So a change under `docs/` is a change in what Gaia reads about herself — and deleting one of
those six documents breaks the publish workflow outright
(`Error: Could not find document at …/principles.md`). The document list is
`DOCUMENTS` in `build-foundation-artifact.js`; change it in the same commit as the file.

## Clients, and what this repo does not contain

Clients reach Gaia only through the uniform Gaia API: turns, the file library,
chat history, speech, the **GaiaChat review surface** (`/cognition/*`) where the
human confirms, memory retraction, Kairos episodes (read and stream), Eleos
check-ins, research jobs and desktop decisions. A client discovers Gaia-initiated
messages by polling and then reads the message itself as an ordinary turn in the
conversation it names. *(That Gaia-Web's direct Hermes, Hindsight and Cognition
routes are retired is a claim about the Gaia-Web repository — external, not
verifiable here.)*

Not in this repository, and therefore not verifiable here: Gaia-Web, Gaia-Desktop
(including Desktop Commander), Foundation, Hindsight, and every deployment fact
(VPS paths such as `/root/gaia`, Tailscale addresses, container names, and the
Hindsight bank settings). `proxy/` — an nginx front for hermes-agent that injects
its auth token so clients never hold it — is in this repo but is not part of
Gaia's own architecture.

Handover to the host: `.github/workflows/deploy.yml` tests both services on every
push and pull request, then deploys by resetting `/root/gaia` to `origin/main`,
rebuilding the Cognition stack first (whose external network gaia-api joins),
applying migrations, and rebuilding gaia-api last.
