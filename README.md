# Gaia Cloud

A lifelong personal intelligence.

Gaia is a conversation-first personal intelligence built around identity, understanding and continuity rather than a single AI model.

This repository is **Gaia Cloud** — her identity and server-side services. Her clients live in their own repositories: [Gaia Web](https://github.com/Bojanni050/Gaia-Web) (browser) and [Gaia Desktop](https://github.com/Bojanni050/Gaia-Desktop) (native, Tauri). See `docs/split-plan.md` for how and why the split happened, and what's still interim (Web's Logos still runs client-side — a known, explicitly-flagged gap, not an oversight).

## What lives here

- `docs/` — Gaia's constitution and architecture: `soul.md`'s architectural overview, `architecture.md`, `principles.md`, `evolution.md` (the running history of every real milestone), `split-plan.md`.
- `services/gaia-api/` — the uniform Gaia API: server-side turn orchestration (`POST conversation/turn`), server-side SOUL (canonical `identity/soul.md`), Bearer auth. Desktop's only backend today; Web migrating onto it is later work.
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
        │  services/gaia-api (Desktop today; Web direct for now)
        ▼
   ┌─────────────────────────────┐
   │          GAIA CLOUD          │
   │   SOUL · direct generation    │
   │   proxy/ (hermes auth injection) │
   └─────────────────────────────┘
```

Clients depend only on contracts, never on a concrete provider — see `docs/architecture.md` for the full picture (Hermes, Hindsight, capabilities, Logos).

## Status

See `docs/evolution.md` for the full, honest history — what's built, what's deliberately not, and why. As of the Phase 1 repo split (2026-08-19): `services/gaia-api` is live and Desktop's only backend; Web still talks to Hermes/Hindsight directly and runs Logos (`intentIQ`/`reasonIQ`) client-side, both flagged as known interim states, not decided architecture.
