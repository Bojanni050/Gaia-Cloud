# The memory pipe

The memory pipe is the one path by which a turn reads long-term memory and the
path by which a completed turn writes into it. This document maps it as the
code builds it: every seam named below is a file in `services/gaia-api`.

## Overview

```
                        ┌──────────── READ SIDE (per turn) ─────────────┐
                        │  turn.js: recallForTurn()                     │
user message ──▶ gate ──┼─▶ hindsight.recall()  (3 banks, cross-bank    │
(shouldRecall,          │    merge)                                      │
 memoryPolicy.js)       │  + mental models (10-min cache)                │
                        │  + patterns, knowledge pages, Foundation,     │
                        │    transcript search                          │
                        │  + Dual Recall: raw Foundation observations    │
                        │    rendered beneath each item                 │
                        └──────────────┬─────────────────────────────────┘
                                       ▼
                              prompt → one inference call → reply

                        ┌────── WRITE SIDE (deferred, after the reply) ──┐
completed turn ──▶ runDeferredCognition (fire-and-forget)                │
 1. Foundation: raw observation registration                             │
 2. Memoryworthiness gate → retain / discard                             │
 3. Logos reflection → hypotheses, patterns, open questions →            │
    Cognition (proposed)                                                 │
 4. Cognition mirror → Hindsight bank `gaia-logos` (gaia:* tags)         │
 5. reflectOnTurn → Hindsight bank `bojan` (async retain, role-labelled)  │
 6. Aion pass (background) → Hindsight bank `gaia` (her own memory)      │
                        └────────────────────────────────────────────────┘
```

## The three banks, split by origin

| Bank | Contents | Writer | Gate |
| --- | --- | --- | --- |
| `bojan` | system memory: conversation reflections + the 7 standing mental models | `src/memory.js` (`reflectOnTurn`) via `src/hindsightClient.js`; the `remember` tool (`src/reasoning/memoryTool.js`) | Memoryworthiness (`src/memoryWorthiness.js`, gate at the call site in `turn.js`) |
| `gaia` | Gaia's own memory, her human side | `src/reasoning/aion.js` (background pass, every few turns + session end); the `keep` tool | none — she decides herself (ungated by design) |
| `gaia-logos` | derived knowledge: hypotheses, patterns, confirmed facts, Kairos episodes | `src/reasoning/cognitionSync.js` (+ hypothesis/pattern adapters, `retainSync`) | the Cognition lifecycle; only a human confirmation reaches `confirmed` |

Recall spans all three via `createCrossBankRecallClient`
(`src/hindsightClient.js`) with a **per-bank quota** (`CROSS_BANK_QUOTA = 3`,
quota scaled to the line budget) — the banks' scores are not on one scale, so
each bank speaks before any bank repeats; the remainder follows in global
score order.

## The read side, step by step

1. **Gate** — `memoryPolicy.shouldRecall` (`src/memoryPolicy.js`): lexical
   signals ("weet je nog", "wat weet je over", "geheugen", "memory", …). The
   gate also opens without a cue via `pastReference` (a literal-lookup signal
   from the turn), `shape.asksAboutHer` (the one turn that reads her own
   bank), or an IntentIQ decision (`intentDecision`).
2. **Distillation** — `memoryPolicy.distillQuery`: only the words that carry
   the question reach retrieval.
3. **Recall** — `hindsightClient.recall` → Hindsight
   `POST /v1/default/banks/{bank}/memories/recall`, `budget: mid`, per-call
   timeout (`HINDSIGHT_TIMEOUT_MS`; default 4000 ms, 8000 ms on the VPS).
   Reranking is remote (Jina's rerank API) with an RRF fallback chain member
   so a reranker failure degrades instead of failing the bank. Per-bank
   fail-soft: a slow or unreachable bank drops its slice with a content-free
   `hindsight.call_failed` log line, never a broken turn.
4. **Rendering** — `memory.js` `renderDualRecallContext`: at most 9 lines
   (`MEMORY_MAX_LINES`), deduplicated, each line carrying its epistemic mark
   read from the item's tags (`memoryKindOf`): "confirmed by the person",
   "your own hypothesis, never confirmed", "a pattern you formed", the item's
   age, and `(uncertain)` below confidence 0.55.
5. **Dual Recall** — `src/reasoning/evidenceRecall.js`: a recalled item that
   carries `sources` gets the literal Foundation observations beneath it as
   `  - [observatie]` lines — the way back from interpretation to raw reality.
6. **Alongside the pipe** — mental models (`fetchMentalModelContext`, cached
   10 minutes), patterns, knowledge pages, Foundation recall and
   `conversation_search` (the literal transcript) run in parallel in
   `recallForTurn`; the transcript is deliberately not memory but the honest
   counterpart to reflection.

## The write side, step by step

1. **Foundation** — the completed turn is registered as an `observation`
   (raw, stamped server-side).
2. **Memoryworthiness** — `src/memoryWorthiness.js`: a deterministic score
   over six dimensions (novelty, persistence, personalRelevance,
   futureUtility, correctionValue, explicitRecallRequest) with hard rules;
   `discard` stops the reflection entirely, `retain`/`retain_low_priority`
   ride along as `gaia_memory_*` metadata. The gate lives in `turn.js`;
   `memory.js` stays the transport.
3. **Logos reflection** — proposes hypotheses, patterns, open questions and
   relationships; proposals only, it owns no truth.
4. **Cognition** — owns the lifecycle
   `proposed → testing → corroborated → confirmed (human only) | rejected`;
   every state change becomes a new superseding version in Hindsight with
   the previous unit invalidated (`cognitionSync.js`); a rejection is a pure
   invalidation. `npm run reconcile:hindsight` rebuilds the mirror.
5. **System memory** — `reflectOnTurn` (`src/memory.js`): the User/Assistant
   exchange as role-labelled JSON, retained async (`async: true`,
   `timeout: null`); identity is always Gaia and `agent_identity` cannot be
   overridden by caller metadata.
6. **Aion** — `src/reasoning/aion.js`: the one ungated writer; a background
   pass asks her what she wants to keep as her own memory, and an empty
   answer is normal and honest; tagged `gaia:aion`.

## Boundaries the code enforces

- **Notebook ≠ memory.** `conversationStore` saves every turn verbatim;
  Hindsight holds only what the gates let through.
- **One-way.** Derived knowledge never lands in Foundation; every derived
  record carries provenance (`sources: ['foundation:<id>']`) and is
  rebuildable.
- **Never blocks, never breaks.** Every read and write is best-effort with
  a catch → `[]` / non-fatal warn; the deferred pass never touches the
  delivered reply.
- **Only a human confirms** — the Absolute Override, reached via
  `POST /cognition/hypotheses/:id/confirm`.

## Core files

- `services/gaia-api/src/turn.js` — orchestration of both halves
- `services/gaia-api/src/memory.js` — gate wiring + rendering
- `services/gaia-api/src/memoryPolicy.js` — lexical gates
- `services/gaia-api/src/memoryWorthiness.js` — retain/discard
- `services/gaia-api/src/hindsightClient.js` — transport + cross-bank merge
- `services/gaia-api/src/reasoning/cognitionSync.js` — the derived mirror
- `services/gaia-api/src/reasoning/aion.js` — her own bank
- `docs/architecture.md` — the wider architecture this pipe lives in
