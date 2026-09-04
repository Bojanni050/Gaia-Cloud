---
title: Gaia — Operations
document: operations
version: 1.0.0
status: active
last_updated: 2026-08-20
owner: Gaia Product Foundation
framing: "Gaia is a lifelong personal intelligence designed to grow through understanding."
---

# Gaia — Operations

> Where to actually go to look at, or change, how Gaia Cloud is running right now. Not architecture, not philosophy — just the practical "where is it" reference for operating this deployment.

---

## Admin Interface

`gaia-api` serves an operator-only admin page, separate from Gaia Desktop's own Settings panel.

**URL:** `http://100.65.0.15:8891/admin` (Tailscale-only — you must be on the tailnet to reach it)

**Auth:** same Bearer token as every other authenticated `gaia-api` route (one of the configured `GAIA_API_TOKEN` values).

**What's there** (`services/gaia-api/src/adminRoutes.js`, static page at `services/gaia-api/public/admin.html`):

- **Logos decision log** — `GET /admin/api/logos/decisions`: the durable, browsable log of every IntentIQ/ReasonIQ decision Logos has made (what it classified, what it concluded).
- **LLM call log** — every actual model call from IntentIQ, ReasonIQ, and Gaia's native voice generator is logged and viewable here — the place to look when something Gaia said or decided needs tracing back to the actual model call behind it.
- **ReasonIQ config** — `GET`/`PUT /admin/api/reasoniq/config`, `GET /admin/api/reasoniq/models` — reasoning-model provider, base URL, model, vision model.
- **Provider Settings** — `GET`/`PUT /admin/api/provider/config`, `.../roles`, `.../capabilities`, `.../models` — the unified model-provider config and per-role (generation/reasoning/vision) model selection.
- **TTS config** — `GET`/`PUT /admin/api/tts/config`, `GET /admin/api/tts/models`.

None of this is part of any client's contract (Desktop, Web) — it's Gaia Cloud operator tooling only.

---

## Deployment

- **Host:** VPS, reached over Tailscale only — no public SSH (closed as of 2026-08-29).
- **`gaia-api`:** `100.65.0.15:8891`, deployed automatically on push to `main` (`.github/workflows/deploy.yml`): the runner joins the tailnet via `tailscale/github-action`, SSHes to `100.65.0.15`, runs `git reset --hard origin/main` in `/root/gaia`, then `docker compose up -d --build` in `services/gaia-api`.
- **`services/cognition`:** Tailscale-only, `:8890` (Postgres-backed patterns & hypotheses).
- **`proxy/` (`gaia-hermes-proxy`):** internal nginx fronting `hermes-agent`, injecting its auth token so no client ever sees it.

See `docs/split-plan.md` for the full topology and what's still interim, and `docs/evolution.md` (Milestone 9 and later) for how `gaia-api` came to exist.

---

## How to Read This Document

This is a living reference, not a foundation document like `vision.md` or `architecture.md` — it records *where things currently run and how to reach them*, not why. Update it whenever a URL, port, or deployment mechanism actually changes; treat a stale entry here as a defect, same as any other doc.
