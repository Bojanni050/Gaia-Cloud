# Gaia — Product Foundation PRD

**Framing:** Gaia is a lifelong personal intelligence designed to grow through understanding.
**Last updated:** 2026-06-01

## Original Problem Statement
Create the foundational documentation set for Gaia — a desktop-first lifelong personal intelligence
built on a strict separation of layers: SOUL (identity), Hindsight (memory), Hermes (reasoning),
Chronicles (knowledge), MCP (actions), Gaia Desktop (experience). Deliver 7 foundation docs under `/docs`.

## Scope Decision (user choices)
- Scope: **Documentation only this pass** (app deferred).
- Open questions: **Take a clear stance + document recommended answers.**
- Tone: **Deep and comprehensive.**
- Format: **Markdown with front-matter metadata.**

## User Personas
- Primary anchor: **Bo** (first deeply personalized user).
- Near-term: thoughtful individuals wanting a private long-term AI companion.
- Long-term: people valuing continuity, calm, trustworthy intelligence over generic AI chat.

## Core Requirements (static)
- Persistent identity independent of reasoning provider (SOUL).
- Reflection/pattern-based long-term memory, not raw logging (Hindsight, storage-abstract).
- Desktop-native conversation-first experience (Gaia Desktop → Hermes streaming API).
- Clear memory vs. structured-knowledge distinction (Hindsight vs. Chronicles).
- Action layer under explicit permission (MCP), operational complexity hidden.
- Model agnosticism; no backend beyond Hermes unless a proven need arises.

## What's Been Implemented (2026-06-01)
- `/docs/vision.md` — what/why/who, philosophy, values, success criteria, anti-goals, differentiation.
- `/docs/architecture.md` — layer boundaries, flows, streaming lifecycle, storage abstraction, model agnosticism, backend-justification stance, offline stance, provenance stance.
- `/docs/design-language.md` — daily feel, visual/spatial/motion/communication philosophy, anti-patterns.
- `/docs/personality.md` — Gaia as presence; style, initiative, boundaries, trust, consistency, growth support.
- `/docs/roadmap.md` — V1(small)→V2→V3→Long-term, MoSCoW, maturity path, trust-gated milestones.
- `/docs/coding-standards.md` — structure, naming, contracts, state, testing, dependency governance, maintainability.
- `/docs/ui-principles.md` — conversation-first, calm, silence, notification philosophy, motion-as-meaning, legible growth.
- `/docs/README.md` — foundation index + resolved open-question summary.

## Resolved Open Questions (stances)
1. Offline-first → network-dependent initially, offline-graceful shell (arch §11).
2. Memory provenance → available on demand, invisible by default (arch §8, ui §9).
3. Proactivity → earned/tiered/reversible, ceiling "never noisy" (personality §2, roadmap §8).
4. Personality variability → stable core, subtle contextual expression (personality §10).
5. Separate backend → only on proven need Hermes can't own (arch §9).

## Backlog / Next Tasks
- P1: Gaia Desktop starter shell (conversation-first React skeleton).
- P1: `/contracts` typed interface stubs for Hermes/Hindsight/Chronicles/MCP.
- P2: Presence-state motion prototype (listening/thinking/speaking/resting).
- P2: Calm opt-in memory/provenance view mock.

## Notes
- This pass is documentation only. No code, services, or integrations were built. Nothing mocked.

## Update — 2026-06-01 (Iteration 2: Gaia Desktop app + refinements)
- Built Gaia Desktop (React) as a Hermes dev-stub client: streaming conversation, markdown, code blocks, image display, file uploads (object storage), retry, edit-and-resend, real tool cards (calculate, get_current_time), thinking/presence indicator, and artifacts in a dynamic companion canvas.
- Backend server.py = Hermes dev-stub: SSE streaming via emergentintegrations LlmChat -> gpt-5.6-terra (reasoning_effort=none for tool support), model-agnostic to the frontend. Object storage wired for uploads. Conversations/messages persisted in Mongo.
- System contracts added under src/contracts (hermes live; hindsight/chronicles/mcp typed boundaries).
- Testing agent iteration_1: backend 12/12 pass, frontend 100%, no bugs, model-agnosticism confirmed.
- Refinements: evolving personal greeting (first-arrival vs returning, time-aware, name=Bo); meditative Presence Engine (4 states, slow sinusoidal breathing, dual halo); renamed "New conversation" -> "New page" (book-like), default thread title -> "Untitled".

## Deferred / Backlog
- Memory View (Hindsight provenance/edit/forget UI) — not yet, per user.
- Gaia's own language for more UI terms (evolve over time).
- Interactive artifact editing (collaborative canvas) — future.

## Update — 2026-06-01 (Iteration 3: Lexicon, Arrival, Living Canvas, Quiet Memory)
- Gaia's Lexicon: centralized language (src/gaia/lib/lexicon.js) — "Begin a page", "What I understand", "Reconsider/Revise/Keep a copy", "Untitled page".
- Arrival Moment: shell fade-in on load + staggered welcome (presence -> greeting -> sub) so opening feels like arriving.
- Living Canvas: artifacts editable in the companion canvas; edits persist via PATCH /api/hermes/conversations/{cid}/messages/{mid}/artifact (replace_nth_artifact).
- Quiet Memory (real minimal Hindsight): POST /api/hindsight/reflect extracts durable understandings (domains: preferences/patterns/context/relationships) with provenance + dedup; GET list; DELETE forget. Opt-in MemoryDrawer ("What I understand"), grouped by domain, "Let go" to forget; auto-refreshes when open.
- Testing agent iteration_2: backend 18/18 pass, frontend 100%, model-agnosticism confirmed. No bugs.

## Update — 2026-08-05 (Milestone 2: Gaia Speaks)
- Real connection to the local Hermes API. The dev-stub backend (server.py, Mongo, emergentintegrations) is removed; no mock responses remain.
- ReasoningProvider abstraction (contracts/reasoning.js + gaia/integration/reasoning/ReasoningProvider.js) — Gaia depends on a contract, not on a provider or a model.
- HermesProvider (gaia/integration/reasoning/HermesProvider.js) — OpenAI-compatible /v1/chat/completions with SSE streaming; URL/model/apiKey from env (REACT_APP_HERMES_URL, REACT_APP_HERMES_MODEL, REACT_APP_HERMES_API_KEY). Defaults to http://localhost:11434/v1 (Ollama-shaped) with model "llama3" — overridable.
- SOUL moved to gaia/identity/soul.js (single source of truth for the system prompt; provider stays persona-agnostic).
- useConversation rewritten: in-memory conversations; provider translates raw deltas into Gaia presence transitions (thinking -> speaking -> resting); typed errors mapped to Gaia-language phrases via presence/errorPhrases.js.
- Desktop UI narrowed: threads, conversation, composer, presence, welcome. MemoryDrawer and ArtifactCanvas removed (Hindsight and artifacts are explicit later milestones).
- Tests: HermesProvider covered for health, streaming, abort, malformed frames (gaia/integration/reasoning/__tests__/).
- docs/evolution.md created — milestone story, architecture reasoning, trade-offs, next milestone.

## Deferred / Backlog (updated)
- Conversation persistence (currently in-memory only; lost on reload) — next milestone or later.
- Tool calling (calculate, get_current_time) — provider must support tools; revisit when a real use appears.
- Artifacts and the living canvas — revisit when a real delivery use case appears.
- Real MCP integration — behind explicit intent + permission.
- Local model alias discovery (auto-detect which models the user's Hermes serves) — nice-to-have.

## Update — 2026-08-15 (Gaia's own Hindsight connection)
- Real Hindsight instance identified on the Strato VPS (`217.154.78.212`): a `ghcr.io/vectorize-io/hindsight` container, separate from the pre-existing `hindsight-friend` tenant (which backs an unrelated MCP integration) and from the general-purpose "bojan" bank used by other tools. Created a dedicated **`gaia`** bank — Gaia's own memory, not shared with any other assistant — with a reflect/retain mission drawn from architecture.md §6 (reflection and pattern formation, not raw logging).
- **Found and fixed a real exposure**: the container was bound to `0.0.0.0:8888/9999` (reachable from the open internet, no auth — confirmed via `docker ps`, Docker's own iptables rules accepting `0.0.0.0/0`, and a successful unauthenticated curl from outside the tailnet), even though its own `docker-compose.yml` already specified a Tailscale-only binding that had just never been applied. Recreated the container (`docker compose up -d`) to apply it; confirmed the public IP now times out and the Tailscale IP (`100.65.0.15:8888`) still answers.
- `frontend/src/gaia/integration/memory/` — `MemoryProvider` (abstract contract, mirrors `ReasoningProvider`), `HindsightProvider` (concrete, talks to Hindsight's real HTTP API: async `retain` for storeReflection, `recall` for retrieveRelevantContext, `/history` for listProvenance, `PATCH` for editMemory, `PATCH state:invalidated` for forget), `errors.js` (`MemoryUnavailableError`, `MemoryNotFoundError`), `index.js` (`getMemoryProvider()`, mirrors the reasoning module). Default URL is the Tailscale address, not a public one — reachability requires being on the tailnet.
- `forget()` maps to Hindsight's per-item `invalidate` (soft-retire, reversible, excluded from recall immediately) — there is no per-item hard delete in the real API, only a bulk clear for an entire bank/type. Documented as an honest limitation in code, not silently glossed over.
- Verified end-to-end against the real server: retain → async operation → recall returned the stored content. Unit tests (`__tests__/HindsightProvider.test.js`, 19 tests, mock `fetch`, mirror `HermesProvider.test.js`'s structure) pass; full frontend suite (7 suites, 54 tests) passes.
- Nothing in the desktop UI reads from this yet — this is the connection only, not the memory view or automatic reflection-on-turn. That's the explicit next step.

## Update — 2026-08-15 (Patterns & hypotheses: `services/cognition`)
- `formPattern`/`queryPatterns` and the full hypothesis lifecycle (architecture.md §6.1) are now real, not stubs. Built as a new small service, `services/cognition` (Express + its own Postgres), because Hindsight's real API has nowhere to put either — confirmed it has no hypothesis/pattern objects, and its `PATCH /memories/{id}` can't even change tags, ruling out faking a status lifecycle on top of regular memory items.
- Hypothesis fields/lifecycle (`statement`, `confidence`, `status: proposed→testing→confirmed|rejected`, `verification_plan`, `evidence_memory_ids`) adapted from Stash's `internal/brain/hypothesis.go` design — concept only, no dependency on Stash's code or binary. Confirming a hypothesis retains it into Hindsight as a real memory (tagged `confirmed-hypothesis`) — Hindsight's `retain` never returns the created memory unit's ID (checked the OpenAPI schema directly), so we set our own `document_id` and store that as `confirmed_document_id` instead, independently queryable via Hindsight's `/documents/{id}` endpoint.
- Deployed to the VPS as `gaia-cognition` + `gaia-cognition-db`, Tailscale-bound from creation (learned from the M5 exposure finding — no drift window this time).
- `HindsightProvider` now talks to two backends behind one `MemoryProvider` seam: Hindsight directly for memories, and the cognition service (`cognitionUrl`, separate env var) for patterns/hypotheses. New `HypothesisTransitionError` for invalid-transition 409s.
- Deliberately not built: automatic hypothesis testing (Stash auto-confirms/rejects via an LLM comparing new facts against open hypotheses during consolidation) and pattern formation logic (clustering facts into an abstraction). Both are reasoning, which is Logos's job per the architecture boundaries — this service only stores lifecycle state, it doesn't reason about evidence.
- Verified end-to-end on the live services: propose → test → confirm landed a real, tagged document in Hindsight. 16 backend tests (`node --test`, fake pool, no live Postgres needed) + 12 new frontend tests (28 total in `HindsightProvider.test.js`, 63 across the whole frontend suite) all pass.

## Update — 2026-08-16 (Wired the desktop to reflect and recall)
- `frontend/src/gaia/state/memoryContext.js` (new): `recallRelevantContext(query)` — best-effort, never throws, times out at 4s (defensively: `AbortSignal.timeout` isn't available in CRA's jsdom test environment, so it's feature-detected rather than assumed); `renderMemoryContext(reflections)` — renders recalled reflections into a system-prompt block, `null` when there's nothing worth surfacing; `reflectOnTurn(...)` — fire-and-forget `storeReflection` call after a turn completes.
- `useConversation.js`: every `send`/`editMessage`/`regenerate`/`retry` now calls a shared `assembleTranscript()` that recalls context for the latest user turn and, if anything came back, injects it as an extra system message (identity prompt from `FoundationEngine` first, memory block second) before the conversation history. `runStream` now also takes the user's text and calls `reflectOnTurn` once a response completes successfully — not on failure or abort, matching the "reflection is asynchronous and never blocks/breaks a turn" architecture stance (§10).
- Manually verified in the browser preview: the app doesn't crash, and — since this sandboxed preview can't route to the Tailscale-only Hindsight/cognition backend (confirmed via a direct `fetch()` test: `Failed to fetch`, no route) — recall failed silently as designed and reflection correctly did *not* fire once the (also-unreachable, in this sandbox) Hermes call failed. Full live round-trip through the actual desktop UI against the real backend was not observed from this environment; the underlying HTTP contract (`HindsightProvider`) was already live-verified against the real Tailscale-bound services in the two prior updates.
- 6 new tests in `memoryContext.test.js`, 4 new tests in `useConversation.test.js` (recall injects a system message / no system message when recall is empty / reflects after success / does not reflect after failure). Full frontend suite: 8 suites, 76 tests, all pass.
- Added `.claude/launch.json` (`npm --prefix frontend start`) so the desktop app can be previewed going forward.

## Update — 2026-08-16 (Significance-based memory policy)
- `frontend/src/gaia/state/memoryPolicy.js` (new): `shouldRecall(query)` and `shouldReflect(userText, assistantText)`, gating the calls added in the previous update. Answers the user's question "can recall/retain be turned into a setting" — yes, and rather than a raw turn-counter (recall every N turns), went with significance-based gating per their preference: skip only when a message is a whole-message filler match (`ok`, `thanks`, `hi`, etc. — never a substring, so "ok, but why does X retry twice?" still counts) or below a configurable minimum length. `shouldReflect` skips only when **both** sides of the exchange are trivial — reflect if either side carries real content, since a thin/one-sided skip is a worse failure mode (a silently lost moment) than an extra network call.
- Thresholds (`REACT_APP_MEMORY_MIN_RECALL_LENGTH`, `REACT_APP_MEMORY_MIN_REFLECT_LENGTH`, default 12 chars each) are env-configurable, matching the existing `REACT_APP_HERMES_*`/`REACT_APP_HINDSIGHT_*` pattern — there's no in-app settings UI yet, so this is the "setting" for now.
- Explicitly named as a heuristic stand-in, not a reasoning judgment: real significance ("does this actually matter") is a Logos-level call per architecture.md §6.2, and there's no concrete Logos implementation in this codebase to delegate to yet (per Milestone 7's own closing note). Length/filler-pattern matching is what's available now without adding a second LLM round-trip per turn, which would defeat the point of gating for cost/latency in the first place.
- `memoryContext.js`'s `recallRelevantContext`/`reflectOnTurn` now check the policy before doing anything else. 12 new tests (`memoryPolicy.test.js`) + 3 more in `memoryContext.test.js`/`useConversation.test.js` covering the wiring (trivial query skips the provider call entirely; trivial exchange skips storeReflection). Fixed a few existing tests that were unintentionally using trivial-length fixture text (e.g. `'anything'`, `'What theme?'`) which would have made them pass for the wrong reason once the gate landed. Full frontend suite: 9 suites, 90 tests, all pass. Verified in the browser preview that the app still loads and behaves cleanly (no new console errors) with the new module in the bundle.

## Update — 2026-08-16 (intentIQ: a real local intent classifier)
- `frontend/src/gaia/state/intentIQ.js` (new): `deriveIntent(messages, windowSize=3)`, replacing `useConversation.js`'s old inline `deriveContext()`. Same output shape (`{ type: 'technical'|'gaia'|'conversation' }`), consumed the same way by `FoundationEngine`/`foundation/rules.js` to pick which foundation docs accompany a turn — this is a quality upgrade of the existing seam, not a new concept.
- Real bugs fixed in the old heuristic: (1) it scanned the **entire joined conversation history** every time, so one early mention of "code" made every later turn "technical" forever, even after the topic moved on — now scoped to a small recent window (default 3 user turns) so a topic shift is picked up quickly; (2) it used `.includes()` substring matching, so words like "decoded"/"barcode" false-positived on "code" — now word-boundary regex; (3) it was **English-only**, despite the desktop having an NL/EN toggle — added Dutch equivalents for both categories (technical: `implementeer`, `architectuur`, `refactoren`, …; self-reflective: `wat zijn je principes`, `hoe denk je`, `evolutie`).
- Chose local/heuristic over an LLM-backed classifier per explicit preference (scored a third option too — pure turn-count throttling — before landing on significance/pattern-based, matching the same reasoning as memoryPolicy.js). Documented in its own docstring as a heuristic stand-in for what should eventually be Logos's real `intentIQ` faculty (architecture.md §4.2) — orchestrator.md's actual reasoning-profile vocabulary (Calm/Creative/Technical/Analytical/Playful) isn't introduced here since nothing in the codebase would consume it yet.
- 10 new tests (`intentIQ.test.js`) covering both languages, the substring false-positive fix, the windowing fix, and tie-breaking. Verified live in the browser preview: a Dutch technical message ("Kun je deze architectuur implementeren?") correctly logged `Conversation Type: technical` and pulled in `architecture.md`. Full frontend suite: 10 suites, 100 tests.
- **Found a real bug while verifying live, unrelated to intentIQ**: recall (from the previous milestone) failed in the browser with a CORS error, not the network-routing failure seen in earlier sessions — Hindsight sends no CORS headers at all (confirmed: `OPTIONS` preflight → `405`), so any browser-based cross-origin call to it was always going to be silently blocked. Investigating that surfaced a second, older, unrelated gap: **`/api/hermes/` was never actually proxied in production either** — `gaia-web`'s own `nginx.conf` has no rule for it, so `https://higaia.nl/api/hermes/v1/...` was returning the SPA's `index.html` (a `200`, but the wrong body) instead of reaching Hermes. Both addressed in the same pass as a follow-up update below, per direction to fix all three properly rather than patch CORS in isolation.
