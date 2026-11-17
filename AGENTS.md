# Gaia Cloud — notes for an agent

Gaia's server side. The clients (Desktop, Web) are separate repositories and speak only to
`services/gaia-api`; the API contract must stay additive, and no reply may leak a provider or
model name.

`docs/architecture.md` is the authority on *what is wired how*; `docs/CONVENTIONS.md` is the
authority on *how a change is made here*. Both are enforced (see below). Read them before
proposing a structure.

## Layout

- `services/gaia-api/` — the one backend: turn orchestration, SOUL (`identity/soul.md`),
  Logos, Kairos, Eleos, speech, library, `/admin` provider store. `README.md` in that
  directory documents the routes per surface — read it before touching a route. Its
  `scripts/README.md` lists the operational scripts and what each one touches.
- `services/cognition/` — derived-knowledge store (Postgres), owns the lifecycle and the SQL
  migrations.
- `proxy/` — nginx that injects the Hermes token.
- `docs/`, `scripts/` — docs, the architecture guard and the foundation bundler.
- `walkthrough.md` / `walkthrough2.md` — the dated log, in the **root**, not under `docs/`.

No root manifest: each service has its own `package.json` and `package-lock.json`, and there is
no build, lint, formatter or typecheck step. Verification is the two test suites.

## Commands

```bash
cd services/gaia-api && npm test                 # ~1800 tests, ~10 s, pure (no DB, no network)
cd services/cognition && npm test                # ~82 tests, pure (fake pools)
cd services/gaia-api && node --test test/speech/mistralTts.test.js   # one file
node scripts/verify-architecture.js              # after touching docs, routes, flags, capabilities
node scripts/build-foundation-artifact.js        # after editing a runtime document
```

CI uses Node 22; the suites are hermetic, so run them freely and quote the real count in the
walkthrough entry.

## Merging is deploying

| workflow | triggers on push to main touching | does |
| --- | --- | --- |
| `deploy.yml` | `services/gaia-api/**`, `services/cognition/**` | `git reset --hard origin/main` in `/root/gaia`, rebuilds **both** containers, runs migrations |
| `publish-foundation.yml` | `docs/**`, `identity/soul.md` | publishes `foundation-artifact.json`, triggers a Gaia-Web rebuild |
| `verify-architecture.yml` | `docs/**`, `services/**`, `scripts/**` | the docs-drift guard |

On a pull request these run tests only and skip the deploy job — green on the PR does not prove
the deploy. A change that touches only the root (e.g. `walkthrough2.md`) triggers nothing at all.

## Rules that bite

- **Flags.** Every boolean flag goes through `services/gaia-api/src/flags.js`
  (`flag(env, name, { default })`); never `env.GAIA_X === 'true'`. Defaults and read sites are
  the *Switches* table in `docs/architecture.md`.
- **Migrations are immutable.** `schema_migrations` keys on the filename, so renaming an
  applied migration re-runs it on a live Postgres. New files take the next free number; the two
  historical `010_` files stay as they are (`test/migrations.test.js` guards both halves).
- **Docs are runtime content.** `soul.md`, `principles.md`, `lexicon.md`, `architecture.md`,
  `evolution.md`, `identity.md` are bundled and shipped to clients; `DOCUMENTS` in
  `scripts/build-foundation-artifact.js` is the list. Editing them changes what Gaia reads about
  herself.
- **The architecture document is machine-checked.** A claim the repo cannot verify must be
  marked *(external)* or *(deployment)* on its line, and the
  `Verified against code: commit <sha>` header is updated when claims are re-read.
- **The log.** After a significant change, append one entry to the running `walkthrough*.md` in
  the root: `## <date> (<title>)` with `Findings:` / `Conclusions:` / `Actions:` (every file,
  ending in `Validated:` with real counts) / `Deployment:`, plus `Open punt:` when something
  genuinely remains. At ~1000 lines start `walkthrough3.md`. `walkthrough.md` is closed.

## Live system

The short version, for an agent working in this repo; the measured version with the containers,
ports, environment files and re-verify commands is `docs/deployment.md`.

- VPS: `ssh contabo` (100.65.0.15, Tailscale; public SSH is closed). Deploy directory
  `/root/gaia` — **the deploy does `reset --hard`, so a hand edit there disappears on the next
  merge**; change it in the repo.
- `/admin` config wins over the environment: saved providers, keys, models and voices live in
  `services/gaia-api/data/provider-config.json` (mounted at `/app/data`, gitignored). Editing
  `GAIA_TTS_*`, `GAIA_NATIVE_*` and friends in `.env` changes nothing while the store has a
  value. `get /speech/info` and `/speech/stt-info` tell you which provider is actually live.
- Auth is the bearer token from `GAIA_API_TOKEN` (503 when unset, so a misconfigured container
  looks like an outage), and `/admin` has its own `GAIA_ADMIN_TOKEN` — a client token does not
  open the operator page, and no admin token means those routes answer 503. Everything is
  tailnet-only by design.
- `.env` files are gitignored and survive the deploy; `.env.example` per service documents every
  variable. Never commit real values or read them into the conversation.

## Language

Docs, walkthroughs and replies to Bo in Dutch; code comments and commit bodies in English. A
Dutch commit subject with an English body is normal.

## Two local traps

- `.gitignore` contains a template `agents.md` entry, which on a case-insensitive checkout also
  hides this file. Keep the `!AGENTS.md` exception below it.
- The checkout is on Windows with `core.autocrlf`; git warns "LF will be replaced by CRLF" on
  every text edit. Harmless, but do not let it turn into a whitespace-only diff.

## Where the rest lives

`docs/CONVENTIONS.md` is the maintained home for how a change here is made: the log entry, the
audit bookkeeping, languages, the runtime documents, the drift guard, flags, migrations, what a
merge deploys, and the working style. This file is the entry point — the layout, the commands,
the rules that bite, and the live system.
