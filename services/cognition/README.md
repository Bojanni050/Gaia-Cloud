# Gaia Cognition Service

Cognition owns the **derived** epistemic content in Gaia Cloud: hypotheses,
patterns, and candidate mental models / relationships — the things that are
*derived from* raw reality rather than being raw reality itself.

It is a small Postgres-backed sidecar, not a fork of Hindsight. The split:

- **Foundation** (external) holds raw, immutable observations (`observation`),
  its ingestion gateway, and MCP. It never stores a derived statement.
- **Cognition** (this service) owns the derived lifecycle: what Logos formed,
  its confidence, its evidence and its status.
- **Hindsight** is the derived knowledge store that Cognition's records are
  *mirrored into* — see the sync note below.
- **Logos** reasons. **This service only ever persists.**

Runs in Gaia Cloud, next to Hindsight — never client-side.

## Lifecycle (V3)

```
proposed ──▶ testing ──▶ corroborated (machine, C >= 0.80) ──▶ confirmed (HUMAN ONLY)
    │           │                    │
    └───────────┴────────────────────┴──▶ rejected  ({ verwerp_bron: 'mens' | 'consolidatie' })
```

- **`corroborated`** is a machine soft-promotion tier: a high-confidence
  micro-hypothesis that may inform retrieval/behavior, but is never presented
  as settled.
- **`confirmed` is human-only** (Absolute Override). No automated step — not
  model confidence, not corroboration — reaches it.
- **`verwerp_bron`** records *why* a statement was rejected: `mens` (a human)
  or `consolidatie` (a newer statement superseded it).
- **Supersession**: a newer confirmed statement can supersede an older one;
  the older one becomes `rejected` with `verwerp_bron: 'consolidatie'` and a
  `superseded_by_id` pointer to the winner. This is the one deliberate
  exception to the transition table (it may move even a `confirmed` record).

The state-machine concept is adapted from
[Stash](https://github.com/alash3al/stash)'s `internal/brain` package — the
*concept*, not the code or the binary. This service does not depend on Stash.

## Derived records

- `kind` discriminates a record: `hypothesis` (default), `mental_model`, or
  `relationship`. All share one lifecycle and one table.
- `counter_hypothesis` is the mandatory anti-lexicographic opposing reading of
  the same source (V3). It is quarantined: surfaced only for human review,
  never presented as a fact. `NULL` is honest absence, and a statement without
  one **cannot be confirmed** — the override is blocked, never faked.
- `scope` is `micro` | `macro` (V3 epistemic entrenchment). `micro` is
  low-impact and may soft-promote to `corroborated`; `macro` (the safe default)
  always needs the human. The API additionally requires a stated `rationale`
  to confirm a macro statement.
- `sources` is provenance back to the raw records the statement was derived
  from: `['chronicle:<observation-id>']`. Nothing derived may overwrite raw
  truth in Foundation.
- `evidence_memory_ids` links the Hindsight memories that support/contradict it.

## Not a Hindsight writer

Cognition does **not** write to Hindsight. Confirming a statement here does not
retain anything: the **Logos sync job** in `gaia-api` mirrors Cognition's records
into Hindsight as the derived knowledge store (`gaia:*` tags, status), and owns
contextual retrieval from it. Cognition stays a pure store so the sync has a
single owner and Hindsight remains rebuildable from Cognition.

## Running locally

```
cp .env.example .env      # set DATABASE_URL
npm install
npm run migrate
npm start                 # listens on PORT (default 8890)
```

## API

All routes are scoped to a `bank_id` (matches the Hindsight bank they are
conceptually attached to — Gaia's is `gaia`).

Patterns:
- `POST /v1/banks/:bank_id/patterns`
- `GET /v1/banks/:bank_id/patterns`
- `GET /v1/banks/:bank_id/patterns/:id`
- `PATCH /v1/banks/:bank_id/patterns/:id`
- `DELETE /v1/banks/:bank_id/patterns/:id` (soft delete)

Hypotheses / derived statements:
- `POST /v1/banks/:bank_id/hypotheses` (propose; body may carry `kind`, `sources`, `supersedes_id`)
- `GET /v1/banks/:bank_id/hypotheses` (`?status=` and `?kind=` filters)
- `GET /v1/banks/:bank_id/hypotheses/:id`
- `PATCH /v1/banks/:bank_id/hypotheses/:id` (statement/confidence/verification_plan/sources; resets to `proposed` from `testing`/`corroborated`, mirroring a refine)
- `POST /v1/banks/:bank_id/hypotheses/:id/test` (`→ testing`)
- `POST /v1/banks/:bank_id/hypotheses/:id/corroborate` (`testing → corroborated`; machine soft-promotion)
- `POST /v1/banks/:bank_id/hypotheses/:id/confirm` (`→ confirmed`; human Absolute Override only)
- `POST /v1/banks/:bank_id/hypotheses/:id/reject` (`→ rejected`; body: `{ reason, verwerp_bron? }`, default `mens`)
- `POST /v1/banks/:bank_id/hypotheses/:id/supersede` (`→ rejected` by consolidation; body: `{ superseded_by_id, reason? }`)
- `DELETE /v1/banks/:bank_id/hypotheses/:id` (soft delete)

## Explicitly not in this pass

- **Forming** hypotheses, patterns or models. This service stores what Logos
  derived; it never invents, weighs evidence, judges or refines on its own.
- **Sync to Hindsight.** That is the Logos job in `gaia-api`, per the boundary
  above.
- **Confirmation.** Only the human path (GaiaChat → Gaia API → here) confirms.
