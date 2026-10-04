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
never a fallback.

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
                            sources: ["chronicle:<id>"]              status + provenance
```

- **Notebook ≠ memory.** Conversation history (`conversationStore`) saves every
  turn verbatim; it is not Hindsight and not Cognition.
- **Provenance points back.** Every derived record carries the raw observation
  ids it was derived from.
- **Hindsight is derivable.** Sync is Cognition → Hindsight only; the mirror is
  rebuildable, and `npm run reconcile:hindsight` re-pushes it.

## Derived lifecycle

```
proposed ──▶ testing ──▶ corroborated (machine, C ≥ 0.80) ──▶ confirmed (HUMAN ONLY)
    │           │                    │
    └───────────┴────────────────────┴──▶ rejected  ({ verwerp_bron: 'mens' | 'consolidatie' })
```

- `corroborated` may inform retrieval/behaviour; it is never presented as settled.
- Supersession: confirming a newer statement rejects the older contradicting one
  with `verwerp_bron: 'consolidatie'` and a pointer to the winner.

## Clients

Clients reach Gaia only through the uniform Gaia API (`services/gaia-api`):
turns, the file library, chat history, speech, and the **GaiaChat review
surface** (`/cognition/*`) where the human confirms. `/admin/*` is operator-only
and never part of any client's contract.
