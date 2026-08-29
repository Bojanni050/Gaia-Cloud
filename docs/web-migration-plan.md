---
title: Gaia — Web Migration to Gaia Cloud
document: web-migration-plan
version: 1.0.0
status: scoped — not started
last_updated: 2026-08-19
owner: Gaia Product Foundation
framing: "Gaia is a lifelong personal intelligence designed to grow through understanding."
---

# Gaia — Web Migration to Gaia Cloud

> **Scope of this document: planning only.** No code changes accompany this
> version. It exists to turn "Web migrating onto `gaia-api`" — named as
> deferred work in `docs/split-plan.md` since the repo split, and again in
> `docs/evolution.md`'s Milestone 9 — into a concrete, sequenced plan before
> anyone starts moving code.

---

## 1. Why this is not a small follow-up

Desktop already talks only to `services/gaia-api` — no client-side Hermes
call, no client-side Hindsight call, no client-side SOUL. Web still does
all three directly. It looks like "just point Web at the same endpoint
Desktop uses," but Desktop's `conversation/turn` contract is
**deliberately smaller** than what Web's turn lifecycle actually does
today. Migrating Web means growing `gaia-api` to match Web's real
behavior first — not shrinking Web to match `gaia-api`'s current
contract, which would be a functional regression on a live product.

## 2. Current State — Exact Inventory

### 2.1 What Web does today (`gaia-web/src/gaia/state/useConversation.js`)

Per turn, `assembleTranscript()` does, in order:

1. **Context-aware document selection** — `deriveIntent(messages)` (a
   cheap local heuristic, not Logos) picks a `ConversationContext`
   (`technical` / `conversational` / etc.), and `FoundationEngine.getPrompt(context)`
   selects *which* foundation documents go into the system prompt
   (soul+principles+lexicon vs. +architecture vs. +evolution) — never all
   of them, to keep the context window lean.
2. **Memory recall, gated** — `recallRelevantContext(userText)`, but only
   if `memoryPolicy.shouldRecall(query)` says the turn shows a concrete
   signal that long-term memory (not just the current conversation) is
   relevant (see `memoryPolicy.js`'s two signal groups: past-reference
   phrases, durable-context keywords). Calls Hindsight directly
   (`HindsightProvider` → `/api/hindsight/...`, proxied same-origin by
   `nginx.conf`), 4s timeout, fails silently to `[]`.
3. **Streaming reasoning** — `HermesProvider.stream()` opens an SSE
   connection to `/api/hermes/v1/chat/completions` (`stream: true`),
   parsing `content` and `reasoning_content` deltas separately and
   feeding them to presence state (`thinking` → `speaking`) and the
   message view live, token by token.
4. **Reflection, gated, fire-and-forget** — after a successful stream,
   `reflectOnTurn()` calls `memoryPolicy.shouldReflect()` (skips only if
   *both* sides of the exchange are trivial) and, if it passes, retains
   the exchange into Hindsight asynchronously — never blocks or fails the
   turn.
5. **Dev-only Logos** — `interpretIntent()` (`intentIQ`) then
   `reasonAboutTurn()` (`reasonIQ`) run in parallel, `console.debug`-only,
   `NODE_ENV !== 'production'` gated. They do not affect routing, the
   system prompt, or the response today — see `docs/evolution.md`'s
   reasonIQ amendment: "the agency that decides what to do with their
   output is still unbuilt."

Errors at any stage map to calm, typed presence phrases
(`phraseReasoningError`) — never a raw HTTP status or provider name reaches
the UI. This behavior is the actual bar a migration has to clear, not just
"the API returns a reply."

### 2.2 What `services/gaia-api` does today (`services/gaia-api/src/turn.js`, `server.js`)

`POST /conversation/turn`: validate → `[{role:'system',content:SOUL}, ...messages]`
→ `hermes.chat()` (**non-streaming**) → `{ reply }`. No memory recall, no
reflection, no context-aware document selection (always the full SOUL,
nothing else), Bearer-token auth (`GAIA_API_TOKEN`, fail-closed), Tailscale-only
bind (`100.65.0.15:8891`).

### 2.3 The gap, stated plainly

| Capability | Web today | `gaia-api` today |
|---|---|---|
| Streaming response | Yes (SSE, deltas drive presence) | No (single JSON reply) |
| Context-aware document selection | Yes (`deriveIntent` + `FoundationEngine`) | No (always full SOUL) |
| Memory recall | Yes, policy-gated | No |
| Memory reflection | Yes, policy-gated, async | No |
| Auth model | None (same-origin proxy, anonymous browser) | Bearer token per device |
| Network reachability from a public browser | Yes (same-origin nginx proxy) | **No — Tailscale-bound, unreachable from the public internet at all** |

The last row is not a detail — it is the actual blocker. Desktop reaches
`gaia-api` because Desktop runs on Bo's own Tailscale-joined machines.
`higaia.nl` is a public website; an arbitrary visitor's browser cannot
reach `100.65.0.15` under any circumstance. Nothing about "Web calls
`gaia-api` instead of Hermes/Hindsight directly" works until this is
solved — it is Step 1 of the plan below, not an afterthought.

## 3. Target State

Web's turn lifecycle produces **identical observed behavior** — same
streaming UX, same recall/reflection gating outcomes, same context-aware
document selection, same calm error phrasing — while the actual Hermes
call, Hindsight calls, and SOUL assembly move server-side into `gaia-api`.
Web's `HermesProvider`/`HindsightProvider` direct integrations are
replaced by calls to `gaia-api`'s (expanded) contract. This is a
**parity migration**, not a redesign — matching how the Desktop migration
in Milestone 8/9 was scoped: move responsibility to where architecture.md
always said it belonged, without changing what the client-visible
behavior is.

**Explicitly out of scope for this migration:** giving Logos real
authority (still dev-log-only after this), redesigning the recall/reflect
policy, adding conversation persistence, or any UX change. Those are
separate, already-named projects (`docs/evolution.md`'s "what remains
deliberately unimplemented" sections).

## 4. Phased Plan

### Phase A — Make `gaia-api` reachable from a public browser

- Add an `/api/gaia/` same-origin proxy location to `gaia-web/nginx.conf`,
  identical in shape to the existing `/api/hermes/`, `/api/hindsight/`,
  `/api/cognition/` blocks, `proxy_pass`-ing to `gaia-api`'s Tailscale
  address, with `proxy_buffering off` (streaming, once Phase B lands).
- Resolve the auth model (§5 below) — this has to be decided, not
  defaulted, before Phase A can actually ship.

**Acceptance:** `curl` a health check through `/api/gaia/health` from
outside the tailnet succeeds; nothing about Web's current behavior has
changed yet (this phase adds reachability, nothing calls it).

### Phase B — Grow `gaia-api` to match Web's current turn lifecycle

In `services/gaia-api`, add (each independently testable, matching the
existing `node --test` pattern):

1. **Streaming.** `POST /conversation/turn` gains a streaming mode (SSE,
   matching the `content`/`reasoning_content` delta shape
   `HermesProvider._readSse` already parses, so Web's client-side parsing
   code barely changes) — `hermesClient.js` needs a streaming variant
   alongside its current non-streaming `chat()`.
2. **Context-aware document selection**, server-side — port
   `deriveIntent`/`FoundationEngine.getPrompt(context)`'s logic (or
   replace it with real `intentIQ` if Phase C below is pulled forward;
   see §6). `gaia-api` needs its own copy of the foundation documents to
   select from — it already has `identity/soul.md`; the rest of
   `docs/`'s foundation subset (`principles.md`, `lexicon.md`,
   `architecture.md`, `evolution.md`) needs the same treatment (baked in
   at build/deploy time, same posture as SOUL).
3. **Recall, policy-gated.** `gaia-api` calls Hindsight directly (it's
   Tailscale-bound already, unlike Web) — port `memoryPolicy.shouldRecall`
   + `recallRelevantContext`'s rendering logic server-side.
4. **Reflection, policy-gated, async.** Same shape, server-side,
   fire-and-forget after a successful reply.
5. **Calm error mapping**, extended to the streaming path — the existing
   "no provider names, no status codes" discipline `turn.js` already has
   for the non-streaming case needs to hold for a stream that fails
   mid-flight too.

**Acceptance:** a request built exactly like Web's current
`assembleTranscript()` output, sent to `gaia-api` instead of Hermes
directly, produces the same reply content for the same input (same SOUL
subset selected, same recall behavior for a memory-signal query, same
skip for a trivial one).

### Phase C — Cut Web over

- Replace `HermesProvider`'s direct Hermes calls with calls to
  `/api/gaia/conversation/turn` (streaming).
- Remove Web's direct `HindsightProvider` recall/reflect calls — `gaia-api`
  does this now.
- Remove Web's `deriveIntent`/`FoundationEngine` client-side selection —
  `gaia-api` does this now.
- `nginx.conf`'s `/api/hindsight/` and `/api/hermes/` routes can be
  retired once nothing in Web calls them directly anymore (`/api/cognition/`
  has no caller from Web today either — check before removing; it may
  already be dead).
- Logos's dev-only console logging either moves with the rest (still
  dev-log-only, now logged from `gaia-api` instead of the browser
  console — genuinely worse for local dev-loop visibility) or is dropped
  for this migration and revisited when Logos gets real authority
  (**recommended** — dev-console visibility of a debug-only feature isn't
  worth the complexity of piping it through a new transport).

**Acceptance:** this plan's version of the split's own gate — a real
message on `higaia.nl` gets a real streamed reply, with recall and
reflection firing in the same turn, verified live exactly as the repo
split's cutover was.

## 5. Open Question That Blocks Phase A — Auth Model

Desktop's auth (`GAIA_API_TOKEN`, one Bearer token per device, entered by
hand in Settings, stored in the OS keychain) has no equivalent for an
anonymous public-website visitor. Options, not decided here:

- **(a) No client-visible auth; rely on network position.** Web's request
  to `gaia-api` happens server-side inside the same-origin nginx proxy
  (browser → `higaia.nl` → nginx → `gaia-api`), so the browser itself
  never holds a token — same trust model Hermes/Hindsight/cognition
  already use today (no client-visible auth, reachability is the only
  gate). `gaia-api`'s existing Bearer requirement would need a carve-out
  or a fixed low-privilege server-side token nginx injects (mirroring
  exactly what `gaia-hermes-proxy` already does for `HERMES_AUTH_TOKEN`).
- **(b) Real per-visitor auth.** Would require Web to actually have an
  auth/login system, which does not exist and is a materially bigger
  project than this migration — **not recommended** as a prerequisite.

**(a) is the recommended direction** — it's the same trust model the rest
of Web's backend calls already use, adds no new user-facing surface, and
is a small, well-understood addition (nginx injecting a fixed token,
exactly like `gaia-hermes-proxy` does today) rather than a new subsystem.
Recorded here as a recommendation, not a decision — confirm before Phase A.

## 6. Relationship to Logos's Relocation

This plan deliberately does **not** give Logos real authority — `intentIQ`/
`reasonIQ` stay dev-log-only, wherever they end up running. Two
independent things happen to be adjacent, not the same project:

- **This plan** moves *transport and orchestration* (the Hermes/Hindsight
  calls themselves, and the crude heuristics currently standing in for
  real judgment) server-side.
- **Logos's relocation** (still separately deferred, per `evolution.md`)
  is about *replacing those heuristics with real reasoning* — `intentIQ`
  actually deciding document selection instead of `deriveIntent`,
  `reasonIQ` actually informing the response instead of being dev-logged.

Doing Logos's relocation *during* Phase B (§4) instead of after is a real
option worth considering when Phase B is actually scoped in detail — it
would mean building the real thing once instead of porting a heuristic
now and replacing it later. Left as an open call for whoever picks up
Phase B, not decided here.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Extra network hop (browser → nginx → `gaia-api` → Hermes/Hindsight, vs. today's browser → nginx → Hermes/Hindsight) adds latency | `gaia-api` and Hermes/Hindsight are already on the same VPS — hop cost is intra-host, should be negligible; verify with real timing before/after, not assumed |
| Streaming failures mid-flight are harder to map calmly than a single failed request | Extend, don't rebuild, `turn.js`'s existing calm-error discipline; add explicit streaming-failure tests before Phase C, not after |
| `gaia-api` becomes a bigger, more complex service (SOUL + streaming + recall + reflection + auth) | Matches what it was always supposed to become per architecture.md; keep it decomposed into small, independently-tested modules the way `turn.js`/`soul.js`/`hermesClient.js` already are, not one growing file |
| Phase A's nginx/auth change ships but Phase B/C stall, leaving `gaia-api` reachable-but-unused from the public internet | Treat Phase A as unshippable without Phase B ready to follow immediately — don't widen the attack surface for a capability nothing uses yet |

## 8. Non-Goals (This Document)

No code changes ship with this version. No decision is final until the
open question in §5 is answered. This does not commit to a timeline —
it exists so that whenever this work is picked up, the shape of it is
already known rather than re-discovered.

## Addendum — Phases A and B shipped (2026-08-19, same day)

§5's open question is decided: **option (a)**. Web's browser never holds a
`gaia-api` token; `gaia-web/nginx.conf.template` injects a Web-specific
`GAIA_API_TOKEN` server-side (envsubst, mirroring how `gaia-hermes-proxy`
already injects `HERMES_AUTH_TOKEN`), exactly the same trust model the
existing Hermes/Hindsight/cognition proxies already use. Verified live:
`/api/gaia/conversation/turn` returns a real reply with zero auth headers
sent by the caller.

Phase B is built — a faithful parity port, confirmed with the user rather
than building real Logos judgment now (§6 stays exactly as deferred).
`services/gaia-api` gained `foundation.js` (context-aware document
selection, ported from `deriveIntent`+`FoundationSelector`), `memory.js`
+ `memoryPolicy.js` + `hindsightClient.js` (policy-gated recall/reflection
— simpler than Web's version since `gaia-api` is already Tailscale-bound
and calls Hindsight directly, no same-origin proxy trick needed), and
streaming (`hermesClient.js`'s new `stream()`, relaying the same
OpenAI-compatible SSE frame shape Web's `HermesProvider._readSse` already
parses). `POST /conversation/turn` now branches on `{ stream: true }` in
the request body; the existing non-streaming path (`performTurn`,
`assembleMessages`) was left **completely untouched** rather than
extended in place, specifically so Desktop's exact current behavior is
unaffected by construction, not just by intent. 39/39 tests pass (16
existing + 23 new). Verified against real infrastructure before pushing:
a live recall call against the production Hindsight bank from this
machine (already Tailscale-joined) returned real prior memories — Hermes
itself isn't reachable from outside the VPS, so that leg was verified via
the actual VPS deployment instead, the same way every other change this
session was verified.

**One gap opened by this phase, not present before it, flagged rather
than silently carried:** `gaia-api`'s Docker build now bakes in
`foundation-artifact.json` (materialized by a new deploy-time step
running `scripts/build-foundation-artifact.js`, reusing Cloud's existing
generator rather than widening `gaia-api`'s build context back to the
repo root). `.github/workflows/deploy.yml`'s trigger is intentionally
scoped to `services/gaia-api/**` only (the earlier fix in this same
document's history) — so a `docs/`-only change updates `Gaia-Web`
immediately (the cross-repo trigger) but does **not** redeploy `gaia-api`,
leaving its baked-in foundation content stale until the next unrelated
`gaia-api` deploy. This mirrors the gap already found and closed for
`Gaia-Web` — closing it here too (`publish-foundation.yml` also
triggering `gaia-api`'s own deploy) is a small, well-understood follow-up,
not done in this pass.

**Nothing in Web calls any of this yet** — Phase C (cutting
`HermesProvider`/`HindsightProvider` over, retiring the direct
`/api/hermes/`/`/api/hindsight/` routes) remains fully unstarted, exactly
per this plan's own phasing.

**Live-verified after deploy, through the full public chain
(`https://higaia.nl/api/gaia/...`, Phase A's route):** the non-streaming
path replied identically to before (Desktop regression check); the
streaming path returned real SSE frames ending in `[DONE]`; and a
technical/deployment-signal query's reply visibly drew on
`architecture.md` content ("Hindsight strictly persists and retrieves...
Logos performs all cognitive reasoning") — direct proof the context-aware
document selection correctly routed that query to include `architecture.md`,
not just that the code runs without error.
