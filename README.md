# Gaia Cloud

A lifelong personal intelligence.

Gaia is a conversation-first personal intelligence built around identity, understanding and continuity rather than a single AI model.

This repository is **Gaia Cloud** — her identity, cognition and server-side services. Her clients live in their own repositories: [Gaia Web](https://github.com/Bojanni050/Gaia-Web) (browser) and [Gaia Desktop](https://github.com/Bojanni050/Gaia-Desktop) (native, Tauri).

## What lives here

- `docs/` — Gaia's constitution and architecture: `architecture.md` (Cloud architecture), `soul.md`'s overview, `evolution.md`, `split-plan.md`, and `foundation ingestion capture-rs.md`.
- `services/gaia-api/` — the uniform Gaia API: server-side turn orchestration (`POST conversation/turn`), server-side SOUL (canonical `identity/soul.md`), Bearer auth, Logos (cognition + background reflection), and the GaiaChat review surface (`/cognition/*`).
- `services/cognition/` — the derived-knowledge store and lifecycle owner (hypotheses, patterns, candidate models, open questions, relationships), Postgres-backed.
- `proxy/` — `gaia-hermes-proxy`: internal nginx fronting `hermes-agent`, injecting its auth token so clients never see it.

## Core Principles

- Identity is permanent.
- Understanding is earned.
- Conversation is home.
- Technology should disappear behind experience.

## Architecture

```
Gaia Desktop / Gaia Web
        │
        │  services/gaia-api (the uniform Gaia API)
        ▼
   ┌──────────────────────────────────────────┐
   │                GAIA CLOUD                 │
   │   SOUL · Logos (cognition) · GaiaChat      │
   │   services/cognition (derived lifecycle)   │
   │   proxy/ (hermes auth injection)           │
   └──────────────────────────────────────────┘
        │                         │
   Foundation (raw)         Hindsight (derived store)
   observations · ingest    long-term memory (gaia:*)
```

Clients depend only on contracts, never on a concrete provider — see `docs/architecture.md` for the full picture (Logos, Cognition, Hindsight, Foundation, capabilities).

## Status

See `docs/evolution.md` for the full, honest history — what's built, what's deliberately not, and why. As of the Phase 1 repo split (2026-08-19): `services/gaia-api` is live and Desktop's only backend; Web still talks to Hermes/Hindsight directly and runs Logos (`intentIQ`/`reasonIQ`) client-side, both flagged as known interim states, not decided architecture.
