---
title: Gaia — Repository Split Plan
document: split-plan
version: 1.2.0
status: Phase 0 and Phase 1's repo cut complete — VPS cutover still pending
last_updated: 2026-08-19
owner: Gaia Product Foundation
framing: "Gaia is a lifelong personal intelligence designed to grow through understanding."
---

# Gaia — Repository Split Plan

> **Desktop = presence, interface and local capabilities.**
> **Server = cognition, memory, reasoning and agency.**
> **This split moves code between repositories. It must not move any responsibility across that line.**

This document records the current monorepo boundaries and the plan for splitting them into three independent repositories — **Gaia-Cloud**, **Gaia-Web** and **Gaia-Desktop** — with two hard constraints:

1. **Gaia Web must remain fully functional** — including the live path on higaia.nl (real Hermes streams, recall and reflection in the same turn).
2. **Gaia Desktop must remain a first-class client of the same Gaia Cloud backend** — same contracts, same gateway, no forked API.

---

## 1. Current Inventory (what lives where today)

| Path | App | Role |
|---|---|---|
| `frontend/` | Web + Desktop | CRA/craco React app; the entire shared UI (conversation, presence, Logos, providers) |
| `foundation/` (root) | Web + Desktop | Build-time tool: reads `docs/` + `frontend/src/gaia/identity/`, writes `artifact.json` (the system prompt dictionary) |
| `docs/` | Web + Desktop (build input) + Cloud (constitution) | Gaia's foundation documents — the source of the foundation artifact |
| `Dockerfile` + `nginx.conf` | Cloud + Web | Builds the `gaia-web` image; nginx doubles as the *de facto* API gateway (same-origin proxies) |
| `services/cognition/` | Cloud | Express + Postgres: patterns & hypotheses (Tailscale-only, :8890) |
| `proxy/` | Cloud | `gaia-hermes-proxy` config (token injection + `Origin` strip toward hermes-agent) |
| `src-tauri/` | Desktop | Rust/Tauri shell: communication, capture, audio, notifications, settings, presence |
| `desktop/` | Desktop | *(superseded, see Milestone 8 addendum below)* Desktop's own Vite + React frontend — no longer wraps `frontend/`; the desktop-only modules formerly inside `frontend/src/gaia/{server,capture,settings}` now live here |
| `services/gaia-api/` | Cloud | *(superseded, see Milestone 9 addendum below)* Express service implementing the `conversation/turn` seam Desktop calls — server-side SOUL + Hermes orchestration, Bearer auth, Tailscale-bound; the first real piece of Phase 1, built inside the monorepo before the split |
| `memory/` | none | Documentation only (`PRD.md`) |
| root `package.json` | Web + Desktop | Orchestration: `dev:web` / `dev:desktop` / `build:web` / `build:desktop` |

**Key structural finding: there is no uniform Gaia Cloud API yet.** "Gaia Cloud" is today a deployment topology on the VPS (hermes-agent, gaia-hermes-proxy, Hindsight, gaia-cognition) that clients reach **directly** through three same-origin proxy paths. `nginx.conf` is the only shared API surface. The client orchestrates reasoning itself (Logos runs client-side — explicitly flagged as interim in `frontend/src/gaia/logos/index.js`).

## 2. Exact Coupling Points

1. **The frontend is 100% shared** — Desktop wraps the web build (`tauri.conf.json`: `frontendDist: "../frontend/build"`). Desktop-only code lives *inside* the web codebase, guarded by `isDesktop()`.
2. **Foundation chain** — `foundation/index.ts` resolves `docs/` and `frontend/src/gaia/identity/` via hard-coded repo-root-relative paths. Both web and desktop builds depend on `docs/` being present.
3. **Build orchestration** — the root `package.json` chains foundation → frontend → tauri (`build:desktop` = foundation + `tauri build`).
4. **Proxy configuration in two tools** — `frontend/craco.config.js` (dev server) and `nginx.conf` (production) duplicate the same routing knowledge toward Hindsight and cognition; Hermes differs per environment (direct localhost in dev, `gaia-hermes-proxy` in prod).
5. **Environment contract** — `REACT_APP_REASON_ENGINE_URL` (default `/api/hermes/v1`), `REACT_APP_HINDSIGHT_URL`, `REACT_APP_COGNITION_URL`, `REACT_APP_HINDSIGHT_BANK_ID`; baked at build time (CRA).
6. **Contracts** — `frontend/src/contracts/` (reasoning, hindsight, chronicles, mcp) is the intended shared API language, but lives client-side only.

## 3. API Contracts (current, exact)

| Backend | Endpoints | Notes |
|---|---|---|
| Hermes (via `gaia-hermes-proxy`) | OpenAI-compatible `POST /v1/chat/completions` (SSE), `GET /v1/models` | Token injected by the proxy; `Origin` header stripped (hermes-agent 403s any `Origin` otherwise) |
| Hindsight | `/v1/default/banks/gaia/memories` (retain), `.../recall`, history/curate, `/documents/{id}`, `/health` | Third-party image; **no CORS** — reachable only via same-origin proxy |
| Cognition | `/v1/banks/:bankId/hypotheses` (lifecycle `proposed → testing → confirmed/rejected`), `/v1/banks/:bankId/patterns`, `/health` | Own service, Postgres, Tailscale-only |
| Gaia API (`services/gaia-api`, new since v1.0.0 of this plan) | `GET /health`, `POST /conversation/turn` (Bearer auth; in `{messages}` → out `{reply}`, non-streaming) | Tailscale-bound `:8891`; server-side SOUL + Hermes orchestration; **this is the uniform Gaia API's first real endpoint** — Desktop is its only client so far, Web still bypasses it |
| Desktop `ServerLink` | Rust `reqwest` → `gaia-api`'s `conversation/turn`; `POST capture` (seam) | Conversation is live; **`capture` still has no server implementation** — forward-looking seam only |

## 4. Migration Plan — Three Repositories

### Phase 0 — Preparation inside the monorepo (no functional change)

1. Extract `frontend/src/contracts/` + provider contracts into a package namespace (e.g. `@gaia/contracts`) — still inside this repo, but importable as a unit.
2. Make `foundation/` path-independent (configurable input/output paths instead of hard-coded repo-root paths) so it can run in any repo context.
3. Move desktop-only modules (`gaia/server`, `gaia/capture`, `gaia/settings`, `ServerStatus.jsx`, the `@tauri-apps/api` dependency) into a clearly marked tree (e.g. `frontend/src/desktop/`) so they migrate in one move later.
4. Pin the cut-over: tag the monorepo (`monorepo-final`).

### Phase 1 — `Gaia-Cloud`

**Moves:** `services/cognition/`, `services/gaia-api/` (the first real piece of the uniform Gaia API — `conversation/turn`, server-side SOUL, token auth), `proxy/`, `nginx.conf` (API gateway config), deployment compose/docs, and `docs/` (the constitution — identity belongs to Gaia herself, not to a client).

**Recommended decision:** define the `/api/*` surface in `nginx.conf` explicitly as *the Gaia Cloud API gateway* and document its routes as the contract. Publish from CI:

- `@gaia/contracts` (npm package; source of truth = server side),
- `foundation-artifact.json` (built from `docs/`) for client builds.

This keeps current behavior 1:1 while creating the single place where the future uniform Gaia API (with auth, and the `capture` endpoint Desktop already offers toward) will land.

### Phase 2 — `Gaia-Web`

**Moves:** `frontend/` (without desktop modules), `foundation/`, `Dockerfile`.

- `foundation/` consumes the published `foundation-artifact.json` (or a pinned git subtree of `Gaia-Cloud/docs/` as a transition period — decision recorded below under risks).
- The `Dockerfile` keeps building the `gaia-web` image; deployed into the same VPS Docker network as `gaia-hermes-proxy`.
- **Acceptance gate:** live on higaia.nl — a real message gets a real streamed Hermes response, with recall and reflection firing in the same turn (the exact verification path from the proxy amendment in `evolution.md`).

### Phase 3 — `Gaia-Desktop`

**Moves:** `src-tauri/` + the desktop frontend modules (prepared in Phase 0).

**Recommended structure:** the web frontend stays the *single source* of the shared UI; Desktop consumes it as a **git submodule / pinned tag** and overlays the desktop modules during the build:

```
Gaia-Desktop/
├── src-tauri/                     # Rust shell: communication, capture, audio, …
├── web/                           # submodule → Gaia-Web @ tag
├── overlay/frontend/src/desktop/  # server/, capture/, settings/, ServerStatus
└── build script: merge overlay into web/ → frontendDist
```

This prevents frontend duplication and keeps Web free of Tauri code. `tauri.conf.json` points at the merged build.

**Open point the migration *must* resolve — desktop production networking:** in a built Tauri app the webview origin is `tauri://localhost`, so relative `/api/*` calls and browser-fetches to higaia.nl are cross-origin — and the cloud gateway sends no CORS headers today. Two routes (combinable):

- (a) the gateway gains CORS support for the Tauri origin, or
- (b) the frontend, in desktop mode, routes server traffic through the Rust `ServerLink` layer (`server_request`), where CORS does not exist — exactly what that abstraction was built for.

Both are configuration-level choices via the settings module, not refactors. Decide before the first desktop release build.

### Phase 4 — Wrap-up

- The root repo becomes an archive/redirect; the VPS checkout (`/root/gaia`) splits into three checkouts; the shared Docker network stays.
- Logos (intentIQ/reasonIQ) remains client-side in Gaia-Web for now — moving it to Gaia-Cloud is a *later, functional* project (`logos/index.js` itself calls it "a relocation, not a rewrite"); the split must not force it.

## 5. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `docs/` drift between Cloud and clients | Single source (Cloud repo) + published artifact; clients never build against a loose docs copy again |
| `artifact.json` going stale | CI publishes the artifact on every docs change; client builds pin a version |
| Web breaking during the split | Phase order: Cloud first (published package + unchanged gateway), Web second with the live acceptance gate, Desktop only after Web is green |
| CORS / desktop production | Resolve the choice above explicitly in Phase 3, before the first desktop release build |
| Duplicated proxy knowledge (craco + nginx) | Move to the Cloud repo as documented gateway config; the craco dev proxy in the Web repo points at the gateway |

## 6. Guardrails (what this split must never do)

- No cognitive logic moves into a client as part of the reorganization — the split moves *code between repositories*, not *responsibilities between layers*.
- No model-specific assumptions enter any client; provider swaps remain a config change.
- Web is not degraded to make Desktop easier, and Desktop is not a fork — both are clients of the same Gaia Cloud contracts.

---

## Addendum — Milestone 8 (2026-08-16): Desktop no longer wraps Gaia Web

Coupling point 1 below ("the frontend is 100% shared") is resolved. Gaia Desktop now has its own UI (`desktop/`, Vite + React) served by its own Tauri build; `tauri.conf.json` points at `desktop/dist`, and the desktop-only modules that had lived inside `frontend/src/gaia/` moved into the desktop tree. Desktop conversations go through the Rust `ServerLink` seam (`conversation/turn` envelope) — never through Gaia Web. Gaia Web is unchanged and independent. Phase 0, step 3 of this plan is thereby completed; the overlay strategy in Phase 3 is no longer needed — Desktop carries its own frontend outright. See evolution.md, Milestone 8.

## Addendum — Milestone 9 + plan re-audit (2026-08-18)

Re-checked this plan against the current repo state (last real edit here was Milestone 8, 2026-08-16). One phase has moved, one open risk is resolved, and one new coupling point was found that this plan didn't anticipate.

**Phase 1 has actually started, still inside the monorepo.** `services/gaia-api` (Express, Node 22) now exists and is live on the VPS: `GET /health`, `POST /conversation/turn` (Bearer auth), server-side SOUL, server-side Hermes orchestration, Tailscale-bound (`100.65.0.15:8891`), deployed automatically on push to `main` via `.github/workflows/deploy.yml` (as of 2026-08-29, public SSH on the VPS is closed — the runner joins the tailnet via `tailscale/github-action` first, then SSHes to `100.65.0.15`; `git reset --hard origin/main` in `/root/gaia`, `docker compose up -d --build` in `services/gaia-api`). This is exactly the "first real piece of the uniform Gaia API" Phase 1 called for — it's just not in its own repo yet. Desktop already configures against it (Settings → Gaia Cloud: server URL + token, token stored in the OS keychain via `keyring` rather than in `settings.json`). See evolution.md, Milestone 9.

**Phase 3's CORS open point is effectively moot for Desktop, not resolved by choice (a) or (b) as written.** The plan framed this as "the gateway gains CORS support" vs. "route through the Rust `ServerLink` layer, where CORS does not exist." Desktop went straight to the second option and never touches a browser fetch for server traffic — `ServerLink` calls `gaia-api` over Rust `reqwest`, which has no CORS concept at all. The open point as written should be considered closed for Desktop. It resurfaces, unchanged, the day **Web** is migrated onto `gaia-api` (still not done — Web talks to Hermes/Hindsight/cognition directly through `nginx.conf`, per the "What this does not change" note in Milestone 9) — a browser *is* subject to CORS, so that migration still needs the gateway-side answer this plan deferred.

**Correction to this addendum (found 2026-08-18, same day, while starting Phase 0):** the coupling point described in the previous paragraph as of first-draft ("gaia-api's Docker build reaches into the Web client's tree for identity") was already fixed by a commit this plan hadn't caught up to — `e200903 feat: centralize SOUL in Gaia Cloud — versioned identity owned by gaia-api`. Canonical `soul.md` now lives at `services/gaia-api/identity/soul.md`, not `frontend/src/gaia/identity/soul.md`; `foundation/loader.ts`'s `IDENTITY_OVERRIDES` already points there for the web build, and `services/gaia-api/Dockerfile` `COPY`s from the same path. The dependency direction is now correct (Web depends on Cloud's identity, not the reverse) — Phase 1's identity move is *smaller* than this plan previously said, since it's already living under `services/gaia-api/`. **Still stale and worth fixing separately:** `services/gaia-api/Dockerfile`'s own comment block and `services/gaia-api/README.md` still describe the old `frontend/src/gaia/identity/soul.md` path, and no evolution.md milestone documents the `e200903` change at all — low-risk doc drift, not a functional coupling problem, but worth a cleanup pass so the next person reading those files isn't misled the way this plan briefly was.

**Operational wrinkle for the eventual three-repo state:** only `gaia-api` has CI/CD today (`deploy.yml`). Gaia Web (`Dockerfile`/`nginx.conf`) and `services/cognition` are still deployed manually (`scp` + `docker compose up -d --build` per [[project-vps-deployments]] and [[project-gaia-cognition-service]]). `deploy.yml`'s script also hard-codes a single checkout path (`cd /root/gaia`) — once the split happens there will be three checkouts on the VPS, not one, so this script (and its pattern) needs to be forked per-repo rather than copied as-is.

**Unchanged, confirmed still accurate:** Logos (`intentIQ` + `reasonIQ`) remains 100% client-side inside Gaia Web (`frontend/src/gaia/logos/`), explicitly flagged in evolution.md's Milestone 9 entry as a known interim placement pending a Gaia Cloud home — Phase 4's guidance to leave this alone during the split still holds. `nginx.conf`'s three same-origin proxy routes (`/api/hermes`, `/api/hindsight`, `/api/cognition`) are untouched and still Web's only path to its backends.

**Net effect on the phase order:** Phase 0's remaining steps (extract `@gaia/contracts`, make `foundation/` path-independent, tag `monorepo-final`) are still not started and still block a clean Phase 1 repo cut. The identity coupling point above should be added to Phase 0 as a fourth prep step, not left for Phase 1 to discover.

## Addendum — Phase 0, steps 1–2 done (2026-08-18)

- **`@gaia/contracts` extracted.** `frontend/src/contracts/` moved to `packages/gaia-contracts/src/` (its own `package.json`, name `@gaia/contracts`). Not yet an installed npm dependency — `frontend/craco.config.js` aliases the bare specifier straight to the package's `src/` for both webpack and Jest, and extends CRA's `ModuleScopePlugin` allow-list so the production build resolves it without a symlink (a plain alias without that extension fails the build with "falls outside of the project src/ directory," since ModuleScopePlugin checks the resolved path regardless of how webpack got there). `frontend/jsconfig.json` got matching `paths` entries for editor tooling. The two runtime importers (`reasonIQ/schema.js`, `reasonIQ/prompt.js`, both importing `HYPOTHESIS_STATUSES`) and all JSDoc `import('...')` type references across the codebase now point at `@gaia/contracts` instead of relative paths. Verified: `yarn build` and `yarn test` both green (174/174) before and after. Becoming a real installed dependency (with the alias replaced) is Phase 1 work, once this package is published from `Gaia-Cloud`'s CI as the plan already specifies.
- **`foundation/` is path-independent.** Added `foundation/config.ts` (`resolveConfig()`): every path the engine touches — `docsDir`, `soulPath`, `artifactPath`, and the `root` they resolve against — is now a `FoundationConfig` value threaded through `loader.ts` → `cache.ts` → `builder.ts` → `index.ts`, resolvable via CLI flags (`--docs`, `--soul`, `--output`, `--root`) or environment variables (`FOUNDATION_DOCS_DIR`, `FOUNDATION_SOUL_PATH`, `FOUNDATION_ARTIFACT_PATH`, `FOUNDATION_ROOT`), CLI taking precedence, both falling back to today's exact monorepo-relative defaults. `cache.ts` and `builder.ts` no longer export/depend on a module-level singleton — `index.ts` constructs one `FoundationCache` from the resolved config. Verified byte-identical `artifact.json` output with no flags, and a second build pointed entirely at a directory outside the repo (relocated `docs/` + explicit `soul.md` + explicit output path) that also produced identical output — confirming the engine no longer assumes it's running from this repo's root. Root `package.json`'s `dev:foundation`/`build:foundation` scripts are unchanged and still work as-is.
- **Not done yet (deliberately, not an oversight):** desktop-only modules were already moved out in Milestone 8, so that original Phase 0 step 3 no longer applies. Tagging `monorepo-final` (Phase 0 step 4) is a repo-cut-time action, not implementation work — left for whenever Phase 1's actual repo split begins. The identity-path doc drift noted above (`gaia-api`'s README/Dockerfile comment, missing evolution.md entry for `e200903`) is still open and unrelated to this work.

## Addendum — Phase 1's repo cut is done: Gaia Web and Gaia Desktop are their own repos (2026-08-19)

This repo's GitHub remote was already named `Bojanni050/Gaia-Cloud` — confirmed with the user this was intentional, not a leftover name, which inverted Phase 1's direction from how it's written above: instead of creating a new Gaia-Cloud repo and moving `services/gaia-api`, `services/cognition`, `proxy/`, `docs/` into it, **this repo simply stopped being anything else.** `frontend/` was extracted into [`Gaia-Web`](https://github.com/Bojanni050/Gaia-Web) and `desktop/` + `src-tauri/` into [`Gaia-Desktop`](https://github.com/Bojanni050/Gaia-Desktop), both with commit history preserved via `git subtree split`. `services/gaia-api`, `services/cognition`, `proxy/`, `nginx.conf`(→ moved to `Gaia-Web`, see below), and `docs/` stayed here untouched — meaning the VPS's existing `/root/gaia` checkout and `gaia-api`'s auto-deploy CI (`.github/workflows/deploy.yml`) needed **zero path changes**.

**`nginx.conf` and the root `Dockerfile` moved to `Gaia-Web`, not staying in Cloud** — a deliberate deviation from Phase 1's original text (which wanted `nginx.conf` in Cloud as "the API gateway config"). In practice `nginx.conf` is baked directly into the `gaia-web` Docker image (serves the static build *and* same-origin-proxies to Hermes/Hindsight/cognition) — it's Web's deployment concern, not a standalone gateway service. Redesigning that into a real separate gateway component is a bigger, later project; this cut preserves current behavior exactly.

**Two real bugs found and fixed during extraction, not by the plan itself:**
1. The root `Dockerfile` never `COPY`'d `services/gaia-api/identity/` into the build image, even though `foundation/`'s default `soulPath` had pointed there since `e200903`. Any `gaia-web` image rebuild between that commit and this one would have failed at the `build:foundation` step. Caught before it shipped, fixed in `Gaia-Web`'s Dockerfile (see that repo's own history for the fix commit).
2. `foundation/`'s default `artifactPath` (`frontend/src/gaia/foundation/artifact.json`) assumed the old nested-`frontend/` layout. In `Gaia-Web`'s flattened structure (`git subtree split --prefix=frontend` makes `frontend/` the new repo's root — its `package.json`, `src/`, etc. are no longer nested), building without an explicit `--output` silently wrote to a stray `frontend/` subdirectory and left the real `src/gaia/foundation/artifact.json` untouched. `Gaia-Web`'s `package.json` scripts now pass `--output=src/gaia/foundation/artifact.json` and `--soul=identity/soul.md` explicitly. Verified content is byte-identical (after normalizing a pre-existing CRLF/LF discrepancy from git checkout) to what the correct build should have produced.

**Gaia-Web vendors `docs/` and a `soul.md` snapshot rather than reading Cloud's filesystem** — Web's Logos and Hermes prompts still run client-side (still the known interim state this plan's Phase 4 always flagged), so Web's build genuinely needs SOUL's *content*, not just Cloud owning it. Building the real "Cloud CI publishes `foundation-artifact.json`, clients pull it" pipeline this plan describes is separate, larger work. For this cut, `Gaia-Web/docs/` and `Gaia-Web/identity/soul.md` are plain copies (`soul.md` as of `Gaia-Cloud@e200903`), with a README note flagging them as the interim duplication to remove once that pipeline exists — re-sync manually until then, don't let it drift silently.

**`packages/gaia-contracts` (Phase 0) moved into `Gaia-Web` wholesale**, not published as a standalone Cloud package yet — it currently has exactly one consumer (`frontend/`'s `reasonIQ`), so it travels with that consumer rather than staying behind for a publish step nothing yet needs. Becoming a real Cloud-published dependency is still future work, unblocked whenever `services/gaia-api` needs to enforce or consume these same contracts itself.

**Verified before any push:** `Gaia-Web`'s `yarn build` and `yarn test` (174/174, matching Cloud's pre-split baseline) both green standalone; `Gaia-Desktop`'s `desktop/`'s `npm test` (vitest, 9/9) green standalone. Not verified: a full Rust/Tauri build (`cargo build`) — `src-tauri`'s `Cargo.toml` has no local path dependencies, so nothing about the extraction should affect it, but this wasn't run end-to-end as part of this pass.

**What's explicitly still open, not silently dropped:**
- **The live VPS cutover** — `gaia-web`'s actual deployed build/run path on the VPS still needs to move from the old monorepo checkout to the new `Gaia-Web` repo, and Desktop's release build pipeline doesn't exist yet. This was deliberately scoped out of the repo-cut work and belongs in its own follow-up, done live against `higaia.nl` with this plan's original acceptance gate re-verified (a real message gets a real streamed Hermes response, with recall and reflection firing in the same turn) before the old path is decommissioned.
- Building the real `foundation-artifact.json` CI-publish pipeline, which would let `Gaia-Web` stop vendoring `docs/`/`soul.md` copies.
- Any change to Logos's client-side location, or Web migrating onto `services/gaia-api` — both still exactly as deferred as they were before this cut.
- The `gaia-api` README/Dockerfile comment drift and missing `evolution.md` entry for `e200903`, noted in the previous addendum — still open, still unrelated to this work.

This repo's root `package.json` (the `dev:web`/`dev:desktop`/`build:web`/`build:desktop` orchestrator) was removed along with `frontend/`, `foundation/`, `packages/`, `desktop/`, `src-tauri/`, `Dockerfile`, and `nginx.conf` — nothing left at this repo's root needs a JS build orchestrator; `services/gaia-api` and `services/cognition` each already have their own. `README.md` was rewritten to describe this repo as Gaia Cloud specifically, no longer "the dev version of Gaia Cloud that also contains her frontend."

## Addendum — the `gaia-web` VPS cutover is done (2026-08-19, same day)

The item flagged above as "explicitly still open" is resolved. `gaia-web`'s build/run path on the VPS now comes from `Gaia-Web` (`/root/gaia-web`, `git clone https://github.com/Bojanni050/Gaia-Web.git`), not the old monorepo checkout — which had, in fact, already lost the ability to build `gaia-web` at all: pushing the Phase 1 commit to `Gaia-Cloud`'s `main` triggered `gaia-api`'s existing CI (`.github/workflows/deploy.yml`, which resets `/root/gaia` to `origin/main` on every push, not scoped to `services/gaia-api` alone), so `/root/gaia` had `frontend/`/`Dockerfile`/`nginx.conf` removed from it before the cutover even started. The running container was unaffected (old image, already built), but this made the cutover load-bearing rather than optional cleanup.

**How it was done:** built `gaia-web:cutover` from `/root/gaia-web`, sanity-tested it standalone on a spare port (`127.0.0.1:8091`) joined to `gaia_net` — confirmed `/`, `/api/hermes/v1/models`, `/api/hindsight/health`, `/api/cognition/health` all `200` — before touching the live container. Swapped with a fast rollback path: old image retagged `gaia-web:before-cutover`, old container renamed `gaia-web-old` (stopped, not removed) rather than deleted, new image promoted to `gaia-web:latest`, new container started under the original name/port/network/restart-policy. The rollback container/image were removed later the same day, once the new path had been live and stable — nothing to clean up as of this writing.

**Acceptance gate re-verified live**, exactly as this plan originally specified: opened `https://higaia.nl` in a real browser, sent a real message, got a real streamed reply that correctly referenced the user by name (Hindsight recall). Network trace confirmed all three calls fired in the one turn: `POST .../hindsight/.../recall` → `200`, `POST .../hermes/v1/chat/completions` → `200`, `POST .../hindsight/.../memories` (reflection) → `200`.

**What's still open:** no CI/CD was set up for `Gaia-Web` (deploy today is the same manual `git pull` + `docker build` + swap pattern used for this cutover, not automated like `gaia-api`'s). Desktop's release build pipeline still doesn't exist. Both remain deliberately out of scope, not silently dropped.

## Addendum — `gaia-api`'s deploy trigger scoped down (2026-08-19, same day)

The sharp edge flagged in the previous addendum — `.github/workflows/deploy.yml` resetting `/root/gaia` on *every* push to `main`, unscoped — is fixed. The `push` trigger now carries `paths: [services/gaia-api/**, .github/workflows/deploy.yml]`, so a `docs/`/`proxy/`/`services/cognition`-only push no longer resets the VPS checkout or rebuilds `gaia-api` for nothing. `workflow_dispatch` is untouched (manual runs still work regardless of what changed). The workflow file itself stays in the path list so an edit to the workflow still runs and can be verified.

## Addendum — CI/CD added to `Gaia-Web` (2026-08-19, same day)

One of the two items the cutover addendum left open is done: `Gaia-Web/.github/workflows/deploy.yml` now auto-deploys on push to `main`, mirroring `gaia-api`'s test-then-deploy pattern but adapted for a static build + container swap rather than `docker compose`. Test job: `yarn build:web` + `yarn test`. Deploy job (SSH, same VPS/key as `gaia-api`'s workflow): `git reset --hard origin/main` in `/root/gaia-web`, `docker build`, tag the outgoing image `gaia-web:previous` before overwriting `:latest`, swap the container, then a post-swap health check (`curl -sf http://127.0.0.1:8090/`) that auto-rolls back to `gaia-web:previous` on failure — the same rollback shape used by hand during the original cutover, now automated.

**Blocked on the user:** this needs `DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_SSH_KEY` repo secrets added to `Gaia-Web` on GitHub — Actions secrets don't carry over between repos, so `gaia-api`'s existing secrets in `Gaia-Cloud` don't apply here. No `gh` CLI or GitHub API access was available to set these directly; the first CI run will fail at the deploy step (test job passes regardless) until they're added.

Desktop's release build pipeline is still the one remaining item from that list — still not done.

## Addendum — the foundation-artifact.json publish pipeline (2026-08-19, same day)

The plan's original Phase 1 recommendation — "Publish from CI: `foundation-artifact.json` (built from `docs/`) for client builds" — is done. `Gaia-Cloud` publishes it (`scripts/build-foundation-artifact.js` + `.github/workflows/publish-foundation.yml`, a moving `foundation-latest` GitHub Release, both repos being public means no new auth is needed for a client to pull it); `Gaia-Web` now fetches it (`scripts/fetch-foundation-artifact.js`) instead of vendoring its own copies of `docs/` and `identity/soul.md` — removed `foundation/`, `docs/`, and `identity/` from that repo entirely. Concretely proved the point of doing this before it even shipped: `Gaia-Web`'s vendored `evolution.md` copy had already drifted stale (missing a same-day amendment) within a day of the split.

Two correctness details worth recording: Docker's build cache can't see a moving release target change, so `Gaia-Web`'s `Dockerfile` needed a `CACHEBUST` build-arg (wired through its `deploy.yml`) to force the fetch to always re-run rather than silently serving a stale cached pull. And the default `github.token` a workflow gets can't trigger a workflow in a *different* repo — closing the last gap (a `Gaia-Cloud` docs change didn't rebuild `Gaia-Web` until its own next unrelated deploy) needed a `CROSS_REPO_TOKEN` secret in `Gaia-Cloud` (the user's own `gh` CLI OAuth token, already scoped `repo`+`workflow` — reused rather than minted a new fine-grained PAT, a deliberate scope-vs-effort call made with the user, not a default) so `publish-foundation.yml` can call `gh workflow run deploy.yml --repo Bojanni050/Gaia-Web` after publishing.

Verified end-to-end in production, not just locally: pushed a real `docs/`-touching commit to `Gaia-Cloud`, watched `publish-foundation` publish and then trigger `Gaia-Web`'s `deploy` workflow, which rebuilt (fetching the fresh artifact, confirmed via its content) and redeployed `gaia-web` on the VPS, health-checked, live on `higaia.nl`.

## Addendum — Web-to-`gaia-api` migration scoped, not started (2026-08-19, same day)

Every remaining item this plan flagged as "explicitly still open" is now done except one: "Any change to Logos's client-side location, or Web migrating onto `services/gaia-api`." That one is real architectural work, not a quick follow-up — `docs/web-migration-plan.md` scopes it out in full (current-state inventory, the gap between Web's actual turn lifecycle and `gaia-api`'s current contract, a real blocker found while scoping — `gaia-api` is Tailscale-bound and unreachable from a public browser at all, unlike Desktop which runs on Bo's own tailnet-joined machines — a phased plan, an open auth-model question, and how this relates to Logos's separately-deferred relocation). No code changed with that document; it exists so the work is ready to pick up, not so it's done.
