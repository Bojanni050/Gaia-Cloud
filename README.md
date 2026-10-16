# Gaia Cloud

A lifelong personal intelligence.

Gaia is a conversation-first personal intelligence built around identity, understanding and continuity rather than a single AI model.

This repository is **Gaia Cloud** — her identity, cognition and server-side services. Her clients live in their own repositories: [Gaia Web](https://github.com/Bojanni050/Gaia-Web) (browser) and [Gaia Desktop](https://github.com/Bojanni050/Gaia-Desktop) (native, Tauri).

## What lives here

- `docs/` — Gaia's constitution and architecture: `architecture.md` (Cloud architecture, start here), `evolution.md` (the history), `principles.md`, `desktop-capability.md` (the confirmation flow for working on the person's own computer), `lexicon.md`, and `foundation ingestion capture-rs.md`. SOUL itself lives in `services/gaia-api/identity/soul.md`.
- `services/gaia-api/` — the uniform Gaia API: server-side turn orchestration (`POST conversation/turn`), server-side SOUL, Bearer auth, Logos (cognition + background reflection), the GaiaChat review surface (`/cognition/*`), Kairos (narrative episodes), Eleos (check-ins), research jobs, the file library, speech, and the desktop-action broker.
- `services/cognition/` — the derived-knowledge store and lifecycle owner (hypotheses, patterns, candidate models, open questions, relationships), Postgres-backed.
- `proxy/` — `gaia-hermes-proxy`: internal nginx fronting `hermes-agent`, injecting its auth token so clients never see it.

## Core Principles

- Identity is permanent.
- Understanding is earned.
- Conversation is home.
- Technology should disappear behind experience.

The fuller set, from which the rest is meant to be derived, is in `docs/principles.md`.

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

See `docs/evolution.md` for the full, honest history — what's built, what's deliberately not, and why. `services/gaia-api` is the single backend for both clients: Desktop and Web speak only to it, and Logos, Hindsight and Hermes run server-side. Optional behaviour (Kairos, Eleos, desktop actions, research reach) is switched by environment flags, listed in `docs/architecture.md` under *Switches*.
