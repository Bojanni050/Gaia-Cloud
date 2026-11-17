# Deployment — the VPS side

Everything here is about a **machine**, not about the code: the host, the containers, the public
surface, the environment files, the switches as they stand in production, and the numbers that
were measured. `docs/architecture.md` is code truth and points here for the rest.

> **Nothing in this document can be checked by the repository.** That is the point of the split:
> a claim about a VPS in a document that a CI job verifies is a claim that can never be wrong out
> loud. Each section says how to re-verify it, and the numbers carry the date they were read.
>
> **Last measured 2026-11-17** — host, containers, ports, the public surface and the environment
> names below were read on the box that day, with the commands given inline.
>
> **This repository is public.** The file therefore carries addresses, container names and host
> paths, and never a secret *value*: the environment files live untracked on the host, and the
> things that would be dangerous here (tokens, keys, the TLS/basic-auth material, DNS access)
> are deliberately absent. Do not paste a value into this file to "make it complete".

## The host

| | |
| --- | --- |
| Provider / hostname | Contabo VPS, `vmi3541047` |
| Public address | `217.154.78.212` (HTTPS only — see the public surface below) |
| Tailnet address | `100.65.0.15` — every service port is bound to this, not to `0.0.0.0` |
| Access | `ssh contabo`; public SSH is **closed**, so access is over Tailscale |
| Cores / memory / disk | 6 cores · 11.7 GB RAM (7.7 GB available) · 193 GB disk, 24% used |
| Uptime / load at the measurement | 29 days · 0.16 / 0.11 / 0.20 |

Re-verify: `ssh contabo 'nproc; free -m | head -2; df -h / | tail -1; uptime'`.

## What runs there

Ten containers, seven of them under a compose project (`docker compose ls`). The two that are not
compose-managed carry no project label; `gaia-web` is one of them.

| container | image | bound to | what it is | its compose file |
| --- | --- | --- | --- | --- |
| `gaia-api` | `gaia-api-gaia-api` | `100.65.0.15:8891` | this repository's API, the one backend | `/root/gaia/services/gaia-api/docker-compose.yml` |
| `gaia-cognition` | (built from the repo) | `100.65.0.15:8890` | the derived store, Postgres client | `/root/gaia/services/cognition/docker-compose.yml` |
| `gaia-cognition-db` | `postgres:16-alpine` | internal `5432` | its Postgres, project `cognition` | same file |
| `hindsight` | `ghcr.io/vectorize-io/hindsight:latest` | `100.65.0.15:8888`, `:9999` | recall, reflect, the memory banks | `/opt/hindsight/docker-compose.yml` |
| `chronicle-db` | `pgvector/pgvector:pg16` | `100.65.0.15:5434` | Foundation's store (project `db`) | `/opt/Foundation/db/docker-compose.yml` |
| `hermes` | (Hermes Agent image) | `127.0.0.1:8642`, `:9119` | research runs and the agent API | `/root/hermes-agent/docker-compose.yml` |
| `gaia-hermes-proxy` | `nginx:1.27-alpine` | `127.0.0.1:8643` | the repo's `proxy/`: injects the Hermes token so no client holds it | `/opt/gaia-proxy/docker-compose.yml` |
| `gaia-public-proxy` | `caddy:2-alpine` | `0.0.0.0:80`, `:443` | the only public entry point, see below | `/opt/gaia-proxy/docker-compose.yml` |
| `gaia-web` | `gaia-web:latest` | `127.0.0.1:8090` | the web client | started outside compose |
| `gaia-control-center` | `gaia-control-center-gaia-control-center` | `0.0.0.0:8899` (uvicorn) | the operator/ops panel (its own repo) | `/opt/gaia-control-center/docker-compose.yml` |

Re-verify: `ssh contabo 'docker ps --format "{{.Names}} | {{.Image}} | {{.Ports}}"; docker compose ls'`.

## The public surface — and why "tailnet-only" needs a caveat

`AGENTS.md` says everything is tailnet-only by design. That is true of **the API**, which binds
the tailnet address (`${GAIA_API_HOST:-100.65.0.15}:8891` in `services/gaia-api/docker-compose.yml`),
and it is *not* the whole story:

- **`higaia.nl` is public over HTTPS.** Caddy (`gaia-public-proxy`) terminates TLS on 80/443,
  puts HTTP basic auth in front of it, and reverse-proxies to `gaia-web:80`. So the web client is
  reachable from the internet with one password; measured 2026-11-17: `https://higaia.nl/`
  answers `401` without credentials.
- **The control center binds `0.0.0.0:8899`** (uvicorn) rather than the tailnet address. It is
  **not** reachable from outside — measured from an external machine: connection filtered — so
  what protects it is the host firewall, not its bind address. Worth knowing: that is a different
  kind of safety than the API's, and a firewall change would expose it.
- Everything else (`cognition`, `hindsight`, `chronicle-db`, `hermes`, the Hermes proxy) binds the
  tailnet or localhost.

Re-verify: `curl -sS -o /dev/null -w '%{http_code}\n' https://higaia.nl/` (expect 401), and from
outside the tailnet `curl -m 6 http://217.154.78.212:8899/` (expect no connection).

## Environment files

Names and locations only; the values are secrets and stay on the host (mode `600`).

| file | belongs to | notes |
| --- | --- | --- |
| `/root/gaia/services/gaia-api/.env` | `gaia-api` | **survives the deploy** — the workflow resets the checkout, not this file |
| `/root/gaia/services/cognition/.env` | the Cognition stack | same |
| `/opt/hindsight/.env` | `hindsight` | 2741 bytes, 17 variables, including the reranker chain below |
| `/opt/gaia-control-center/.env` | the control center | carries its own `GAIA_API_TOKEN` — it is a client of the API |
| `/opt/gaia-proxy/.env` | the two proxy services | the Hermes token the nginx front injects |

Each service's `.env.example` in this repository documents every variable it reads; that file is
the contract, these paths are where the values live.

## Switches as they stand in production

Measured 2026-11-17 from `/root/gaia/services/gaia-api/.env`. Only the ones that are set
explicitly are listed — everything else is at its documented default (`docs/architecture.md`,
*Switches*).

| variable | value on the VPS | meaning |
| --- | --- | --- |
| `GAIA_KAIROS_ENABLED` | `true` | the Kairos worker runs (it is off by default) |
| `GAIA_RESEARCH_REACH` | `on` | a turn may submit a Hermes research run |
| `GAIA_OPEN_QUESTION_REACH` | `on` | Gaia may open her own question — the one place she speaks first |
| `GAIA_DESKTOP` | `true` | the desktop capability is offered |
| `GAIA_LOGOS_SOCIAL_GATE` | `on` | the social filter is the default depth gate |
| `GAIA_ADMIN_TOKEN` | set | the operator token for `/admin`, separate from the client tokens (`docs/advice.md` C3) |
| `HINDSIGHT_TIMEOUT_MS` | `8000` | twice the client default of 4000 ms — the VPS answer is slower |

Not set, therefore at their defaults: `GAIA_ELEOS` (**off** — she does not speak first unless this
goes on), `GAIA_AION`, the three hypothesis scans, `GAIA_MEMORY_TOOL`, `GAIA_HYPOTHESIS_FORMATION`.

**The live answer beats this table.** `GET /admin/api/scans` (operator token) reports per
background pass whether it is enabled, why not, when it last ran, what it last found and its last
error — the flag list above can only say what is written down, that endpoint says what the process
actually did.

## The reranker chain

Hindsight's ranking is configured on the host, in `/opt/hindsight/.env`, and is **not** in git:

| variable | measured value (2026-11-17) |
| --- | --- |
| `HINDSIGHT_API_RERANKER_PROVIDER` | `cohere` |
| `HINDSIGHT_API_RERANKER_COHERE_MODEL` | `jina-reranker-v3.5` (served over the Cohere-compatible endpoint) |
| `HINDSIGHT_API_EMBEDDINGS_PROVIDER` | `local` |
| `HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL` | `BAAI/bge-small-en-v1.5` |
| `HINDSIGHT_API_MCP_ENABLED` | `true` |
| `HINDSIGHT_API_WORKER_ID` | `hindsight-prod` |
| `HINDSIGHT_API_LOG_LEVEL` | `info` |

What the code side knows (`hindsightClient.js`, `docs/architecture.md` *Memory*): the
`HINDSIGHT_TIMEOUT_MS` cap is a safety cap rather than a latency target, and a reranker or
timeout failure degrades the recall instead of failing the bank — a failed call logs one
content-free `hindsight.call_failed` line (bank, op, reason, ms). Changing the provider or model
means editing that file on the host and restarting `hindsight`; it never passes through a deploy.

## Handover: what a merge actually does on that host

`deploy.yml` (paths `services/gaia-api/**`, `services/cognition/**`) resets `/root/gaia` to
`origin/main`, rebuilds the **Cognition** stack first — gaia-api joins its external network, so it
has to exist — applies the Cognition migrations, then rebuilds **gaia-api** last. `publish-foundation.yml`
(`docs/**`, `identity/soul.md`) publishes `foundation-artifact.json` and triggers a Gaia-Web
rebuild; `verify-architecture.yml` runs the drift guard and touches no host.

Consequences that have bitten, or would:

- **A hand edit in `/root/gaia` disappears on the next merge** (`reset --hard`). Fix it in the repo.
- **`.env` files and data directories survive the deploy** — that is why the operator token can be
  set once (`docs/advice.md` C3) and why the Postgres data dir must never be committed
  (`docs/advice.md` C1).
- **A container reads `.env` at start**, so a variable added after a deploy needs
  `docker compose up -d <service>` in that directory to take effect.
- **`/opt` is not under the deploy**: `hindsight`, the Foundation db, the control center and both
  proxies are updated by hand, which is why their settings live in this document rather than in a
  workflow.

## Measuring a turn, rather than guessing

This document deliberately carries no latency or cost numbers: they move, and the repository
already has the tools that measure them on real traffic.

- `node services/gaia-api/scripts/summarize-turn-timing.js <logfile>` — per-stage latency
  (count / mean / p50 / p95 / max) from the `turn.done` lines.
- `npm run why:logos-gate` in `services/gaia-api` — how often the depth gate went `deep`, per hour
  and per reason: the cost question.
- `GET /admin/api/scans` — what the background passes actually did.
- `services/gaia-api/scripts/README.md` — the rest of the operational toolbox, and which of those
  scripts touch a live store.
