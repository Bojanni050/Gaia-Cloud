---
title: Gaia — Evolution
document: evolution
version: 1.0.0
status: active
last_updated: 2026-08-05
owner: Gaia Product Foundation
framing: "Gaia is a lifelong personal intelligence designed to grow through understanding."
---

# Gaia — Evolution

> **Gaia is a lifelong personal intelligence designed to grow through understanding.**
>
> Evolution is the story of how Gaia grows. Not a changelog — a record of intent, the trade-offs considered, and the path forward.

---

## Milestone 0 — The Foundation

**Goal.** Establish the durable boundaries that protect Gaia's identity for a lifetime.

**What was built.**

- `/docs` foundation: vision, architecture, personality, design language, UI principles, coding standards, roadmap, lexicon.
- The six-layer architecture: SOUL, Hindsight, Hermes, Chronicles, MCP, Gaia Desktop.
- A first Gaia Desktop skeleton: conversation-first shell, presence engine, composer, welcome moment.
- A Hermes **dev-stub** as a stand-in: a FastAPI service that streamed token deltas, persisted conversations in MongoDB, hosted minimal Hindsight, served uploads, and produced artifacts. It existed so the desktop had something to talk to while the real Hermes matured.

**Architectural reasoning.**

- Provider agnosticism was a hard rule from day one. The desktop must never know which model is answering.
- The dev-stub was deliberately a *stand-in*, not a *target*. Removing it later was always part of the plan.
- SOUL lived in the dev-stub. That was acceptable for a placeholder, but not for a lifelong product — identity belongs to Gaia, not to whoever happens to be running the inference.

**Lessons learned.**

- The desktop's vocabulary was right (presence, conversation, page), but the connection to reasoning was over-engineered. The dev-stub carried a lot — conversation CRUD, Hindsight, uploads, artifacts, tools — that should not have been the desktop's surface.
- "Hermes" was used to mean three different things at once: a local API, a backend service, and a brand. That ambiguity cost clarity.

**Future direction.**

- Connect to a real Hermes. Drop the dev-stub. Introduce a provider abstraction so the next provider switch is invisible.

---

## Milestone 2 — Gaia Speaks *(Phase 3)*

**Goal.** Gaia genuinely speaks for the first time. A typed message produces a real, streamed response from a local Hermes API. The mock dev-stub is gone. SOUL is canonical. Presence reflects the actual shape of the conversation.

**What was implemented.**

- **`ReasoningProvider`** — a thin abstract contract (`health`, `stream`, `chat`). Plain reasoning in, plain text out. No Gaia-flavored events, no presence state, no SOUL — those are desktop concerns, not provider concerns.
- **`HermesProvider`** — a concrete provider that talks to a local OpenAI-compatible `/v1/chat/completions` endpoint with SSE streaming and a `/v1/models` health check. URL, model, and API key are environment-driven.
- **Typed reasoning errors** (`ReasoningUnavailableError`, `ReasoningAbortedError`) translated into Gaia's own language at the presence layer. No HTTP status codes, no provider names, no stack traces ever reach the user.
- **Canonical Foundation Engine** at `foundation/`. The desktop invokes a Node.js build step before start/build to load Gaia's constitution (`soul.md`, `principles.md`, `lexicon.md`, `architecture.md`, `evolution.md`) into a single generated `artifact.json` dictionary. 
- **Foundation Selector** implemented in `frontend/src/gaia/foundation/selector.ts`. At runtime, Gaia evaluates the user's intent to derive a `ConversationContext` (e.g., technical, conversational). A deterministic rule engine selects only the relevant Foundation documents to compose the system prompt, ensuring the context window isn't bloated with unrelated information.
- `foundation/index.ts` in the frontend imports the artifact directly and dynamically builds the prompt via the selector. Identity lives in the repository (`docs/`), not in code, and not in the model.
- **Presence engine** with four states following Gaia's Lexicon: *quiet* (present, waiting), *listening* (paying attention to what the user is composing), *thinking* (composing a response), *speaking* (streaming tokens). The orb breathes; it never flashes.
- **Presence flow** wired end-to-end: a draft in the composer shifts the dock orb to *listening*; sending shifts it to *thinking*; the first delta shifts it to *speaking*; stream completion returns it to *quiet*. Aborts and unreachable errors are handled calmly.
- **`useConversation`** — owns conversations, streaming, provider health probing, and derives the simple heuristic for the `ConversationContext`. On mount, the provider's `health()` is called and the result is exposed as a calm status. If Hermes is unreachable, a quiet line — a *whisper*, not a banner — appears above the composer. If Hermes is ready, nothing is shown.
- **Desktop UI** simplified to the conversation: composer, presence, welcome, and a threads list. The Memory drawer and the Artifact canvas were removed — Hindsight and artifact tooling are explicit later-milestone concerns.
- The dev-stub backend, its MongoDB persistence, its tool implementations, and its Hindsight/artifact endpoints — all removed. No mock responses remain.
- Jest tests for `ReasoningProvider` and `HermesProvider`: health (ok, unreachable), streaming (delta assembly, `[DONE]`, malformed frames), error mapping, and abort.

**Why this architecture was chosen.**

The milestone asked for a `ReasoningProvider → HermesProvider → Hermes API` chain. The temptation was to put the abstraction at the boundary between the desktop and "the outside world", with a fat `HermesProvider` that already understood presence, personas, and error phrasing. We resisted that. The provider speaks only reasoning — messages in, text out, errors as typed exceptions. Gaia-flavored behavior is layered on at the desktop. This is the only way the next provider swap stays invisible.

Equally, we resisted adding a backend. A backend is the *easy* place to put conversation CRUD, persistence, and retries — and the milestone says no new backends are introduced without a proven need. Today the only proven need is "stream from Hermes." The desktop now owns that need directly. When persistence, memory, or knowledge bring a real proven need, the architecture will earn a backend then.

The canonical SOUL document is the same discipline applied to identity. The temptation was to keep the system prompt as a string in `identity/soul.js` — close to the code, easy to edit. We resisted that too. SOUL is a *constitution*, not a prompt; it is meant to evolve deliberately, to be reviewed like law, and to outlive every reasoning provider. A markdown file in the repository, loaded at build time, makes that review possible. The code does not own Gaia's voice; the repository does.

**Trade-offs considered.**

- *In-memory conversations.* A backend would have given us persistence for free. We chose not to add a backend; the trade is that closing the desktop loses threads. This is the right trade for this milestone: it keeps boundaries clean and trusts the user to be present with Gaia in the moment.
- *No tool calls, no artifacts, no uploads, no Hindsight.* The dev-stub offered all of these. Removing them was a deliberate narrowing. Each belongs to a later milestone, paired with its own trust guardrail.
- *OpenAI-compatibility assumption.* We assume Hermes is OpenAI-shaped. If it is not, only `HermesProvider` needs to change — the rest of Gaia does not.
- *No retry/edit on the desktop.* These features were tied to backend persistence. They are out of scope for "Gaia Speaks" and will return with memory.
- *Build-time SOUL loading.* The canonical document is imported at build time. Editing SOUL requires a rebuild. This is the right trade: identity should change deliberately, not at runtime. A future desktop build can revisit this with hot-reload, but for the web app today, build-time is the most Gaia-aligned choice.
- *Health whisper vs. status badge.* We could have shown a persistent "connected / disconnected" indicator. We chose instead to surface health only when it is wrong — a quiet line, not a status panel. Gaia does not advertise her connectivity; she either speaks or she explains why she cannot.

**Lessons learned.**

- The provider must not know Gaia. When the provider started speaking in presence states, Gaia was already being re-absorbed into a generic chat client.
- A typed error is a *promise*. By committing to `ReasoningUnavailableError` and `ReasoningAbortedError` (and nothing else), the desktop can phrase calm messages with full confidence the user will never see a 500.
- "Streaming naturally" is a small implementation effort and a large experience win. Once the desktop transitions to *speaking* on the first delta, Gaia stops feeling like a tool and starts feeling like a presence.
- *Quiet* and *listening* are not the same state. The default is *quiet* — present, waiting, not demanding attention. The moment the user begins to type, the orb shifts to *listening* — Gaia is paying attention. The difference is small in the code and large in the relationship.
- Loading SOUL from a canonical document changed how identity changes feel. A string in a `.js` file is a code change. A markdown document in `docs/` is a *constitutional* change. The friction of editing a `.md` file is itself a feature.

**Future integration points.**

- Hindsight (long-term memory) returns in a later milestone. When it does, it will reach reasoning through its own contract, not by coupling to the provider.
- Chronicles (structured knowledge) has the same shape: its own contract, its own time, its own trust gate.
- MCP (actions) sits behind intent + permission; the reasoning provider will receive an MCP-capable variant only when the action surface is real.
- A second reasoning provider (local model A, local model B, remote model) becomes a config change — the desktop never learns which one answered.

**Next milestone.**

The next milestone introduces the first reflective layer: Hindsight. Gaia will begin to remember what matters — not everything, not in a log, but as patterns the user can see, edit, and let go of. The trust guardrail is provenance-on-demand and full user control from day one.

---

## Milestone 3 — Gaia Arrives *(Phase 3.5)*

**Goal.** Give Gaia a permanent home on the desktop. The browser version continues to work unchanged; the desktop version wraps the same frontend in a native window. Nothing about Gaia's identity, reasoning, or presence changes — only where she lives.

**What was built.**

- **Tauri shell** at `src-tauri/`. Rust-backed, webview-fronted. The shell is intentionally thin: it opens a window, restores its last size and position, and loads the existing React frontend. It knows nothing about SOUL, Hermes, presence, or any of Gaia's layers.
- **Root `package.json`** with `dev:web` and `dev:desktop` scripts. The browser workflow (`yarn dev:web` → `cd frontend && yarn start`) is unchanged. The desktop workflow (`yarn dev:desktop` → `tauri dev`) is additive, not a replacement.
- **Window state persistence** via `tauri-plugin-window-state`. Gaia remembers her window size, position, and maximized state across launches — without a single line of frontend code.
- **Window constraints** chosen for Gaia's multi-panel interface: minimum 820×560 (sidebar 264px + comfortable conversation area), native title bar, resizable, maximizable, centered on first launch.
- **Capability surface** at `src-tauri/capabilities/default.json` limited to `core:default` and `window-state:default`. The shell can manage its own window; it cannot reach the filesystem, the network, or the OS beyond what the webview already does. The frontend's fetch to the local reason engine continues to work through the webview's normal network stack.
- **Icons** generated for the shell. A calm gold orb on Gaia's near-black, matching the in-app presence aesthetic. The icons are placeholders in the right shape — the visual identity can deepen later without touching the shell.
- **`.gitignore`** updated for Tauri build artifacts (`src-tauri/target/`, generated schemas).

**Why Tauri.**

Three options were on the table: Electron, Tauri, and a hand-rolled webview wrapper. We chose Tauri for three reasons.

1. *Footprint.* Tauri uses the system's webview (WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux) instead of bundling Chromium. Gaia's installer stays small, starts fast, and respects the user's machine. Electron would have added ~150MB of duplicated browser to every install.
2. *Boundary discipline.* Tauri's Rust backend and capabilities model make it natural to keep the shell thin. The default capability set is deliberately restrictive; opening it up to filesystem, tray, or global shortcuts is a deliberate, reviewable decision — not a default that quietly grew.
3. *Memory and reasoning live in the frontend.* The architecture already placed identity in SOUL, memory in Hindsight, and reasoning in Hermes — all behind the React app. Tauri does not compete with any of those layers. The shell is a window, nothing more.

**Architectural decisions.**

- *The frontend is unaware it is in Tauri.* No `tauri-apps/api` imports, no `window.__TAURI__` checks, no desktop-specific branches in React. The same `build/` directory that the browser would serve is what Tauri bundles. If Tauri were removed tomorrow, the browser version would be unchanged.
- *The shell is unaware of Gaia.* `src-tauri/src/lib.rs` does not mention identity, memory, reasoning, or presence. It registers the window-state plugin and launches. Any future native capability (tray, notifications, global shortcuts) enters through new Rust commands behind new capabilities — never by reaching into the frontend's concerns.
- *Dev workflow is additive.* `yarn dev:web` still works exactly as before. `yarn dev:desktop` is a new target. The two do not share state; the user picks one at a time.
- *Environment variables are unchanged.* `REACT_APP_REASON_ENGINE_URL`, `REACT_APP_REASON_ENGINE_MODEL`, and `REACT_APP_REASON_ENGINE_API_KEY` work identically in browser and desktop. The webview's origin in dev is `http://localhost:3000` (same as the browser), so the reason engine's CORS config that already allows the browser also allows the Tauri dev window.

**Trade-offs considered.**

- *CORS in production.* In a built Tauri app, the webview's origin is `tauri://localhost` (or a custom protocol), not `http://localhost:3000`. The reason engine's CORS config will need to allow this origin for production. In dev, the origin is the dev server URL, so the existing config suffices. This is a deployment consideration, not a code change.
- *No auto-updater yet.* Tauri supports one. Adding it later is a capability decision, not an architectural one.
- *No code signing.* The first desktop builds will trigger OS warnings (Windows SmartScreen, macOS Gatekeeper). This is acceptable for a personal-use first release; code signing is a deliberate later step.
- *Single window.* Gaia is one window today. Multi-window (e.g., a detached canvas) is a future capability, not a current need.

**Lessons learned.**

- *A desktop shell is a boundary, not a feature.* The temptation in a desktop milestone is to add native capabilities. We resisted. The success criterion was "Gaia launches as a native desktop application" — not "Gaia has a tray icon." Boundaries are load-bearing; the shell's job is to hold the window, nothing more.
- *The frontend should not know its host.* The moment React imports a Tauri API, Gaia becomes coupled to a shell. Keeping the frontend shell-agnostic means the browser version stays a first-class target, and future shells (a different webview, a kiosk mode, a CLI) are additive, not invasive.
- *Window state is a UX detail that compounds.* Remembering size and position is a small implementation — one plugin — and a large felt difference. Gaia feels like a permanent presence when she remembers where she was.

**Future native capabilities (prepared, not implemented).**

The capability system and Rust shell are ready to host:

- **System tray** — quiet presence when the window is closed.
- **Notifications** — for reflections, never for chatter.
- **Global shortcuts** — a way to summon Gaia from anywhere.
- **Local filesystem access** — for future Chronicles and Hindsight persistence, behind explicit intent and permission.
- **Multi-window** — for a detached canvas or a memory view.

Each will arrive as a new capability grant and a new Rust command, never as a frontend concern.

**Next milestone.**

The next milestone introduces the first reflective layer: Hindsight. Gaia will begin to remember what matters — not everything, not in a log, but as patterns the user can see, edit, and let go of. The trust guardrail is provenance-on-demand and full user control from day one.

**Prerequisites for desktop development.**

- [Rust](https://rustup.rs/) (stable toolchain).
- [Tauri CLI](https://tauri.app/start/prerequisites/) — install with `cargo install tauri-cli` or use the npm version included as a dev dependency at the repo root.
- Run `yarn install` at the repo root, then `yarn dev:desktop` to launch the desktop window.

## Milestone 4 — Complete Core Chat Experience

**Goal.** Elevate Gaia's conversational interface to a production-ready, highly interactive personal chat environment. Build complete media attachment flows, advanced markdown formatting (including tables, LaTeX equations, and Mermaid diagrams), and full control over the conversational flow (message editing, deletion, response regeneration, and retrying).

**What was built.**
- **LaTeX Math support**: Integrated `remark-math` and `rehype-katex` with global KaTeX styles. In-line and display equations render natively in responses.
- **Mermaid Diagrams**: Created a modular `<MermaidBlock>` component rendering block code with language `mermaid` into interactive SVG diagrams styled in Gaia's dark theme.
- **Rich Input Attachments**: Added multi-file picker, image/file previews, and delete-before-sending capabilities inside `<Composer>`.
- **Drag & Drop and Paste Integration**: Added HTML5 drop zone and clipboard paste listeners. Files dragged over the composer or images pasted (Ctrl+V) instantly attach with previews. Fully compatible with native Tauri and desktop environments.
- **Message Operations**: Implemented editing for user messages, deletion for any message in a thread, response regeneration, and retrying of failed streaming responses.
- **Auto-scroll with Manual Lock**: Added scroll position checking. Auto-scroll stays active when the user is at the bottom, but locks immediately if the user scrolls up to read past messages, avoiding jarring jump-backs.
- **Failing State Resilience**: Handled failed streams cleanly, providing visual indicator of unreachability, saving error states on the message level, and offering a robust "Retry" action.

**Architectural reasoning.**
- Attachments are stored as light-weight client-side structures containing local `blob:` URLs. Text translation for the Hermes API remains text-only, separating the user history aesthetic from the reasoning provider's format.
- Keeping LaTeX and Mermaid parsing purely frontend-centric follows our framework-agnostic goal.
- State-altering operations (edit, regenerate, retry) truncate the conversation thread synchronously in memory, ensuring that subsequent assistant tokens are generated contextually and without old-state pollution.

**Lessons learned.**
- Preventing unwanted auto-scroll when a user reads history during streaming is key to a calm UX. A simple scroll threshold (80px) is highly effective.
- Disabling strict SSL check in Yarn (`yarn config set strict-ssl false`) resolved local environment certification errors during package installations.

---

## Milestone 5 — Gaia's Own Hindsight Connection

**Goal.** Give Gaia her first real connection to Hindsight — mirroring the `ReasoningProvider`/`HermesProvider` seam that already exists for reasoning, but for memory. Not the memory view, not automatic reflection-on-turn — just the seam itself, proven against a real Hindsight deployment.

**What was built.**
- `frontend/src/gaia/integration/memory/`: `MemoryProvider` (abstract contract), `HindsightProvider` (concrete — talks to Hindsight's real HTTP API), `errors.js` (`MemoryUnavailableError`, `MemoryNotFoundError`), `index.js` (`getMemoryProvider()`).
- A dedicated **`gaia`** bank was created on the existing Hindsight deployment on the Strato VPS — Gaia's own memory, not the general-purpose "bojan" bank other tools already write to, and not the separate `hindsight-friend` tenant behind an unrelated MCP integration. Mission text seeded from architecture.md §6 (reflection and pattern formation, not raw logging).
- `storeReflection` retains asynchronously (Hindsight's extraction step is LLM-backed and can take 10-20s+; a conversational turn must never block on it — consistent with the asynchronous REFLECT step in the streaming lifecycle, architecture.md §10). `retrieveRelevantContext` maps Hindsight's `recall` results into the `Reflection` shape the contract already declared. `listProvenance`, `editMemory`, and `forget` are wired against Hindsight's history/curate endpoints.
- Verified end-to-end against the live server (retain → async operation → recall returned the stored content), plus 19 unit tests mirroring `HermesProvider.test.js`'s structure.

**What was found and fixed along the way.** The Hindsight container was reachable from the open internet with no authentication — bound to `0.0.0.0`, confirmed via a successful unauthenticated request from outside the tailnet, even though its own `docker-compose.yml` already specified a Tailscale-only binding that had simply never been applied. This is exactly the kind of infrastructure drift that's easy to miss and dangerous to leave in place for a service holding a person's long-term reflections. Fixed by recreating the container with the config that was already on disk; Gaia now reaches Hindsight only over Tailscale, matching how the Hermes proxy is already kept internal-only.

**Architectural reasoning.**
- `formPattern`/`queryPatterns` remain unimplemented — Hindsight's nearest equivalent ("mental models") is a later milestone, not this one. Hypotheses (architecture.md §6.1) are also not yet wired; Hindsight has no native hypothesis object, so that needs to be built on top of its existing primitives deliberately, not bolted on here.
- `forget()` maps to Hindsight's per-item `invalidate` (soft-retire, reversible, excluded from recall immediately) rather than a hard delete — Hindsight only exposes a hard delete at the whole-bank/type level, not per item. Documented as an honest gap against the "forget honored fully and immediately" contract language, not silently glossed over.
- The default `HindsightProvider` URL points at Hindsight's Tailscale address, never a public one — reachability requires the desktop to be on the tailnet, which is the correct failure mode for a service that should never be open to the internet.

**Lessons learned.** A "let's connect X" request is a good moment to actually check what's running before writing client code against an assumption — the exposure here would not have surfaced from reading docs or code alone.

**Next.** Nothing in the desktop UI reads from this yet. The next step is wiring an actual reflect-on-turn and recall-on-turn path through `useConversation`, and eventually the opt-in memory view (architecture.md §8).

---

## Milestone 6 — Patterns & Hypotheses (`services/cognition`)

**Goal.** Fill in the two Hindsight content types Milestone 5 left unimplemented: patterns and hypotheses (architecture.md §6.1). Build them ourselves, adapting the relevant design ideas from [Stash](https://github.com/alash3al/stash) — not depending on it, embedding it, or running it.

**Why not just wire more of Hindsight's API.** Checked first, before writing anything: Hindsight's real API has no hypothesis or pattern objects, and — the more decisive finding — its `PATCH /memories/{id}` can't even change tags, only `text`/`state`/`entities`. That rules out faking a status lifecycle (`proposed → testing → confirmed/rejected`) on top of regular memory items; there'd be no way to move a hypothesis between states without deleting and re-retaining it, which is worse than just building the real thing.

**What was built.**
- `services/cognition` — a small new Express + Postgres service, Hindsight-adjacent but structurally separate (own database, own container). Two resources, both bank-scoped like Hindsight: **patterns** (`content`, `confidence`, `coherence_score`, `source_memory_ids` — plain CRUD, no lifecycle) and **hypotheses** (`statement`, `confidence`, `status`, `verification_plan`, `evidence_memory_ids`, full `proposed → testing → confirmed | rejected` lifecycle with transition validation, adapted from Stash's `internal/brain/hypothesis.go` state machine).
- **Confirming a hypothesis retains it into Hindsight** as a real memory, tagged `confirmed-hypothesis` — the "promotes into a fact" step from architecture.md §6.1. Found along the way that Hindsight's `retain` endpoint never returns the created memory unit's ID, sync or async — confirmed against its own OpenAPI schema. Worked around it by setting our own `document_id` on the retain call and storing that (`confirmed_document_id`) instead of a memory ID we were never going to get; it's independently queryable via Hindsight's `/documents/{document_id}` endpoint. Verified end-to-end on the live services: propose → test → confirm landed a real, tagged document in Hindsight, `memory_unit_count: 1`.
- `frontend/src/gaia/integration/memory/HindsightProvider.js` — `formPattern`/`queryPatterns` and the full hypothesis lifecycle (`proposeHypothesis`, `listHypotheses`, `updateHypothesis`, `testHypothesis`, `confirmHypothesis`, `rejectHypothesis`) now call the cognition service over a second base URL (`cognitionUrl`, defaulting to its Tailscale address), while everything else on the same provider still talks to Hindsight directly. One `MemoryProvider` seam, two backends behind it — the desktop still only knows about one contract. New `HypothesisTransitionError` surfaces the service's 409 on an invalid transition (e.g. trying to reject a confirmed hypothesis) without leaking HTTP status codes upward. `contracts/hindsight.js` gained the `Pattern`/`Hypothesis` typedefs and the full capability list.
- Deployed to the VPS as `gaia-cognition` + `gaia-cognition-db`, both Tailscale-bound only from creation — no exposure-drift repeat of Milestone 5's finding.
- 16 backend tests (`node --test`, no live Postgres — a hand-rolled fake pool asserting on the actual SQL text) plus 12 new frontend provider tests (28 total in `HindsightProvider.test.js`; 63 across the whole frontend suite).

**What deliberately did not get built.** Stash's hypothesis system includes an LLM-driven consolidation stage that automatically compares new facts against every open hypothesis and auto-confirms/rejects past a confidence threshold. That's a real design decision about *who reasons about evidence* — Logos's job, per architecture.md's boundary rules, not something to bolt into a storage sidecar. This service exposes the lifecycle endpoints; nothing calls `test`/`confirm`/`reject` automatically. Pattern *formation* (clustering facts into an abstraction) is the same story — this service persists whatever pattern content it's handed, it doesn't synthesize it.

**What this does not change.** Hindsight remains the canonical store for memories and facts; this service only tracks confidence and lifecycle state that references Hindsight content (`source_memory_ids`, `evidence_memory_ids`) without duplicating it. `forget()`'s existing gap (soft-invalidate, not a hard delete) is unrelated and unchanged by this milestone.

---

## Amendment — Hindsight Persists, Logos Reasons (§6.2)

**Context.** Milestone 6's "what deliberately did not get built" paragraph drew the right line by instinct — automatic hypothesis testing and pattern formation are reasoning, so they don't belong in a storage sidecar — but architecture.md itself only said this once, in passing, inside §6.1 ("Logos performs the reasoning that proposes a hypothesis or later reasons about one"). §6 still described patterns as something "Hindsight forms," which quietly contradicted it. The instruction that triggered this amendment named the risk precisely: don't let the hypothesis lifecycle read as *intelligence living inside Hindsight* — Hindsight remembers, Logos concludes, and that split needed to be a named, enforceable rule, not an implication.

**What changed.**
- `docs/architecture.md` (now v2.3.0) — added **§6.2, "Division of Labor: Hindsight Persists, Logos Reasons"**, with an explicit table (Hindsight: stores/persists vs. Logos: forms/judges/tests/confirms/rejects/refines/revises) and the observe → store evidence → notice pattern → form hypothesis → persist → new evidence → evaluate → confirm/reject/refine → persist feedback loop. §6's pattern description was corrected — Logos forms patterns, Hindsight persists them, not the reverse. §4.2 (Logos) and §4.4 (Hindsight) "Owns"/"Never"/"Boundary rule" lines were updated to state the same split at the responsibility-table level. §14 gained an enforcement rule naming this explicitly, including for "any Hindsight-adjacent storage sidecar." §1 gained a numbered principle. The opening framing quote now carries the line verbatim: *"Hindsight is persistent memory and accumulated knowledge, not a second brain. Logos is where evidence becomes understanding."*
- `services/cognition/README.md` — added an explicit statement that this service only ever persists, citing §6.2 by name, and fixed a stale reference to a `confirmed_memory_id` field that was already renamed to `confirmed_document_id` in the actual code during Milestone 6 but not caught in the README at the time.

**Why this matters.** Naming this now, while `services/cognition` is small and its boundary is still easy to see, is what keeps it from drifting later — a future contributor adding "just a small heuristic" for auto-confirming high-confidence hypotheses inside the storage service would be reintroducing exactly the boundary collapse §14 exists to prevent, and now there's a specific rule to point at instead of re-deriving the argument. It also closes a real inconsistency: §6's own text said Hindsight forms patterns, which nothing in the actual implementation (or in Milestone 6's own reasoning) agreed with.

**What this does not change.** No code changed. `services/cognition` and `HindsightProvider` already behaved this way — this amendment makes architecture.md say clearly what the implementation had already gotten right.

---

## Milestone 7 — Desktop Wired to Reflect and Recall

**Goal.** Close the gap every prior Hindsight milestone left open on purpose: nothing in the desktop actually used the connection. Wire real recall (before a turn) and real reflection (after one) into `useConversation`.

**What was built.**
- `frontend/src/gaia/state/memoryContext.js` — `recallRelevantContext(query)`, `renderMemoryContext(reflections)`, `reflectOnTurn(...)`. Recall is best-effort and time-boxed (4s); a slow or unreachable Hindsight degrades to "no context," never to a broken or delayed turn. Reflection is fire-and-forget, fired only after a turn actually succeeds.
- `useConversation.js` — `send`/`editMessage`/`regenerate`/`retry` now share `assembleTranscript()`: recall on the latest user turn, and — only if something relevant came back — an extra system message carrying it, appended after the identity prompt. `runStream` reflects on the completed exchange, but only on success; an aborted or failed turn reflects nothing (matches architecture.md §10's REFLECT step, which only follows COMPLETE).
- 10 new tests (`memoryContext.test.js` + additions to `useConversation.test.js`) covering: recall injecting a system message, no system message when recall is empty, reflection firing after success, reflection *not* firing after a failed stream. Full frontend suite: 8 suites, 76 tests.

**What verification actually covered, and what it didn't.** Manually exercised in a browser preview: the app didn't crash, and Gaia degraded exactly as designed when both Hermes and Hindsight were unreachable. But this preview sandbox turned out unable to route to the Tailscale-only Hindsight/cognition backend at all — confirmed directly (`fetch('http://100.65.0.15:8888/health')` → `Failed to fetch`, no network-request entry logged, unlike a same-host connection-refused which *does* get logged) — so a full live round-trip through the actual desktop UI, with real recalled content showing up in a real Hermes call, was not observed this session. The HTTP contract underneath (`HindsightProvider` itself) was already live-verified against the real backend in Milestones 5 and 6; this milestone only adds thin, now-unit-tested glue on top of it, and that glue's failure path is what got to be observed live.

**Architectural reasoning.** Recall runs before the reasoning call, not in parallel with it — architecture.md §5.1 lists context retrieval as a step the capability takes before executing, and Hermes should be able to see recalled context in its system prompt from the first token, not receive it as an afterthought. Reflection runs after, asynchronously, matching the same section's REFLECT step. Neither call is allowed to be user-visible as a distinct action ("Invisible Implementation," principles.md) — recall failures are silent by design; only reflection failures log a `console.warn`, since a silently-dropped memory write is a worse failure mode than a silently-skipped recall.

**What this does not change.** No hypothesis or pattern reasoning is wired to conversation turns yet — that's Logos's job (§6.2), and Logos itself doesn't have a concrete implementation in this codebase yet (today "Logos" is a naming convention for logic living inside `useConversation`/the system prompt, not a standalone service). The memory view (§8) still doesn't exist.

---

## Milestone 7a — Significance-Based Memory Policy

**Goal.** Milestone 7 recalled and reflected on every single turn. The instruction that triggered this one asked whether that cadence could be made configurable — turn-count throttling ("every N messages") or something smarter. Went with smarter: gate both calls on whether the turn is actually worth them, per architecture.md §6's own language — "memory policies are explicit contracts... governed by declared policies, not by ad-hoc model behavior."

**What was built.**
- `frontend/src/gaia/state/memoryPolicy.js` — `shouldRecall(query)` and `shouldReflect(userText, assistantText)`. A message is trivial if it's empty, whole-message filler (`ok`, `thanks`, `hi`, …, matched only against the *entire* trimmed message, never as a substring), or under a length threshold. `shouldReflect` skips only when **both** sides of the exchange are trivial — asymmetric on purpose: a wrongly-skipped reflection silently loses a moment, a wrongly-kept one just costs a network call, so the policy leans toward keeping.
- Thresholds are env-configurable (`REACT_APP_MEMORY_MIN_RECALL_LENGTH`, `REACT_APP_MEMORY_MIN_REFLECT_LENGTH`, default 12 chars), matching how every other provider setting in this codebase is exposed. There's no in-app settings UI yet, so this is literally what "a setting" means right now.
- `memoryContext.js`'s `recallRelevantContext`/`reflectOnTurn` check the policy first. 15 new tests total; fixed a handful of existing tests that happened to use trivial-length fixture text (`'anything'`, `'What theme?'`) and would otherwise have started passing for the wrong reason (the gate skipping the provider call entirely, rather than the mocked success/failure path actually being exercised). Full frontend suite: 9 suites, 90 tests.

**Why this is explicitly a stand-in, not a judgment.** "Is this significant" is, honestly, a Logos-level question — the same kind of call architecture.md §6.2 already assigns to Logos for hypotheses and patterns (judging relevance, deciding something matters). But there is no concrete Logos implementation to hand this to yet. Asking a model to judge significance would mean a second reasoning call per turn, which defeats the actual point of gating (saving latency and cost on trivial turns). So this is length/pattern matching — cheap, fast, and honestly labeled in its own docstring as a placeholder for a real judgment call that belongs elsewhere once Logos exists as more than a naming convention.

**What this does not change.** Recall and reflection's own failure/timeout behavior (Milestone 7) is untouched — the policy is a gate in front of them, not a replacement for anything. Hindsight's own retain step still does its own (real) extraction judgment on whatever content passes the gate; this policy only decides whether to bother calling it at all.

---

## Milestone 7b — intentIQ: A Real Local Intent Classifier

**Goal.** `useConversation.js` had a small inline `deriveContext()` from before any of this session's Hindsight/Logos work — a handful of `.includes()` checks deciding whether to hand Hermes `soul.md` alone, or with `architecture.md`, or with `evolution.md`. Functionally, this was already `intentIQ` — Logos's faculty for reading a turn and deciding what it needs (architecture.md §4.2) — just never named or treated as such, and carrying real bugs from never having been revisited. Named it, moved it to its own module, and fixed what was actually broken.

**What was built.**
- `frontend/src/gaia/state/intentIQ.js` — `deriveIntent(messages, windowSize=3)`, same `{ type }` output the foundation-doc selector already consumed, so nothing downstream had to change.
- Three real bugs fixed: **(1) stuck classification** — the old code scanned the *entire* conversation history every call, so one early "code" mention made every later turn "technical" forever; now scoped to the last few user turns, so a topic shift is caught within a turn or two. **(2) substring false positives** — `.includes('code')` matched "decoded", "barcode", "codecs"; now word-boundary regex. **(3) English-only** — despite the desktop having a working NL/EN toggle, the keyword list had no Dutch at all; added Dutch equivalents for both categories.
- Chose local/heuristic explicitly over an LLM-backed classifier — the instruction asked for significance-based judgment, matching Milestone 7a's memoryPolicy.js reasoning: a model call to decide what kind of thinking a turn needs would add a second round-trip before the real reasoning call even starts, which is a worse tradeoff than a cheap local heuristic gets wrong occasionally.
- 10 new tests. Verified live: a Dutch technical message ("Kun je deze architectuur implementeren?") correctly logged `Conversation Type: technical` in the Foundation Selector and pulled in `architecture.md`. Full frontend suite: 10 suites, 100 tests.

**Why this is explicitly a stand-in, not a judgment.** Same caveat as memoryPolicy.js, stated once so it isn't re-litigated per module: real intent understanding is a Logos-level call, and there is no concrete Logos implementation yet — today "Logos" names a place in the codebase, not a reasoning process. This is pattern matching wearing intentIQ's name until something real can wear it instead. Also deliberately narrow: orchestrator.md's real reasoning-profile vocabulary (Calm/Creative/Technical/Analytical/Playful) is not introduced here, because nothing in the codebase would consume it — a single-capability app with one Hermes call per turn has no model-routing decision to feed a profile into yet. Adding it now would be unused surface.

**An unrelated discovery while verifying this live.** Testing intentIQ in the browser preview turned up something else entirely: recall (Milestone 7) failed with a CORS error this time, not the routing failure seen in earlier sessions. Hindsight sends no CORS headers at all — confirmed directly (`OPTIONS` preflight against it returns `405`) — so a browser calling it cross-origin was always going to be blocked; this had gone unnoticed because every prior verification used Node's `fetch`, which doesn't enforce CORS. See the next amendment for the fix.

---

## Amendment — Same-Origin Proxying for Hermes, Hindsight, and Cognition

**Context.** Milestone 7b's live verification found Hindsight has zero CORS support, so `recallRelevantContext`/`reflectOnTurn` were silently non-functional from any real browser session — the failure was invisible by design (recall degrades to "no context" on any error), which is exactly why it took this long to notice. Fixing it properly meant finding out how Hermes — which *does* work in local dev — actually reaches the browser, to reuse the same pattern rather than inventing a new one. That investigation found a second, unrelated, pre-existing gap: **`/api/hermes/` was never actually wired in production.** `gaia-web`'s own `nginx.conf` (baked into its image) has no proxy rule for it at all — `https://higaia.nl/api/hermes/v1/models` returned `200`, but the body was the SPA's `index.html`, not a real API response, because the request just fell through nginx's `try_files` SPA fallback. A `gaia-hermes-proxy` container exists on the VPS and correctly proxies to Hermes with the auth token injected — but it was never connected to what the browser actually reaches. Traced this to commit `985dcf9` ("route Gaia reasoning through internal Hermes proxy"), which set the frontend's build-time default to `/api/hermes/v1` but only touched the `Dockerfile` — the `nginx.conf` side of that bridge was never built, and the proxy config that *was* built (`/root/gaia/proxy/default.conf`) was created directly on the VPS and never committed to git at all (`git status` on the VPS's checkout showed `?? proxy/`). The VPS's checkout was also found to be 9 commits behind `main` at the time.

**What changed.**
- `nginx.conf` (repo root, baked into the `gaia-web` image) — added `/api/hermes/`, `/api/hindsight/`, `/api/cognition/` proxy locations alongside the existing SPA `location /`. `/api/hermes/` proxies to the `gaia-hermes-proxy` container by name (requires it and `gaia-web` to share a Docker network); `/api/hindsight/` and `/api/cognition/` proxy directly to their Tailscale addresses, since any container on the VPS can already route there.
- `frontend/src/gaia/integration/memory/HindsightProvider.js` — default `baseUrl`/`cognitionUrl` changed from the direct Tailscale addresses to relative paths (`/api/hindsight`, `/api/cognition`), mirroring how Hermes's production default was already relative (`/api/hermes/v1`). Same-origin proxying isn't a style preference here — it's the only way a browser can reach either service at all, given neither sends CORS headers.
- `frontend/craco.config.js` — added `devServer.proxy` entries for `/api/hindsight` and `/api/cognition`, proxying to the real Tailscale addresses in local dev too (`Hermes` dev default stays direct to `localhost:11434`, unaffected — that path already worked, since local Ollama-shaped servers are commonly CORS-permissive). Verified live: after this change, the same recall call that previously failed with a CORS error returned `200 OK` via `POST http://localhost:3000/api/hindsight/v1/default/banks/gaia/memories/recall`.
- `proxy/templates/default.conf.template` + `proxy/README.md` + `proxy/.env.example` (new, committed) — the `gaia-hermes-proxy` config, finally brought into git. The version that had been living only on the VPS had a live Hermes API token hardcoded directly in the file; that could not be committed as-is. Rewritten to use nginx's built-in envsubst-on-templates support (`${HERMES_AUTH_TOKEN}`, substituted from the container's real environment at startup, never from nginx's own `$host`-style runtime variables, which aren't environment variables and are therefore left untouched) — the real token lives only in an untracked `.env` on the VPS, same pattern as `services/cognition/.env`.
- `Dockerfile` — added `REACT_APP_HINDSIGHT_URL`/`REACT_APP_COGNITION_URL` build args (defaulting to the same relative paths, redundant with the JS defaults but self-documenting alongside the existing Hermes ARG), and updated its header comment, which had said "no Hermes service" — no longer accurate once this image is proxying to three of them.

**Why this matters.** Two invisible-by-design failure modes (recall's silent degrade-to-nothing, and a `200` response that isn't the real endpoint) had been quietly masking each other's absence — recall never worked and nothing said so; Hermes's production path never worked either and a `200` status made it look fine at a glance. Neither would have surfaced without deliberately checking, which is the same lesson as Milestone 5's exposure finding: a "let's connect X" or "let's fix X" request is worth actually checking what's running before writing code against an assumption.

**What this does not change.** `services/cognition`'s own behavior, Hindsight's lack of CORS support itself (unfixable — it's a third-party image), and the "no auth on Hindsight/cognition, Tailscale is the only access control" posture from Milestone 6 are all unchanged. This only changes *how the browser reaches* all three services, not what any of them do once reached.

**Correction, stated plainly because it was stated wrongly before.** An earlier session's memory record claimed `nousresearch/hermes-agent` was "a separate, unrelated project" and that the Gaia repo's own never-built `hermes/` folder was "the real Hermes service." That was wrong — asserted without checking, and repeated confidently enough to shape this session's initial framing of the production Hermes gap. The user corrected it directly: `hermes-agent`, reached through its API, is Gaia's actual, intended Hermes. There is no other one. The persistent memory carrying the wrong claim has been corrected; this note exists so the same mistake isn't quietly reintroduced by a future session reading only the code and not this history.

**A second, real problem this surfaced.** Fixing the proxy routing wasn't the end of it: `hermes-agent` itself rejects any HTTP request carrying an `Origin` header with a bare `403` — confirmed by testing directly against its own port (`127.0.0.1:8642`, bypassing every proxy layer), and confirmed the rejection isn't a mismatch against its own declared CORS allowlist (`localhost`/`127.0.0.1`): those exact origin values got `403` too. It's a blunter guard — any `Origin` header at all is treated as "this is a browser talking to me directly," which `/v1/chat/completions` isn't meant to allow. Since every real browser sends `Origin`, chat could never have worked from `higaia.nl` no matter how correctly the proxy routing was fixed.

**Fix:** `proxy/templates/default.conf.template` now sets `proxy_set_header Origin "";` before forwarding to `hermes:8642` — nginx's idiom for suppressing a header entirely rather than forwarding it. This isn't weakening hermes-agent's protection; the request hermes-agent actually receives now correctly reflects its real origin (`gaia-hermes-proxy`, a trusted local caller), instead of misrepresenting a browser's `Origin` as if the browser were calling hermes-agent directly. Verified end-to-end live on `https://higaia.nl`: a real message got a real streamed response from Hermes, with recall (`/api/hindsight/.../recall`) and reflection (`/api/hindsight/.../memories`) both firing successfully in the same turn.

---

## Amendment — Identity: Attunement vs. Mimicry

**Context.** Gaia was built and refined for a single user first. As the long-term intent to make Gaia available beyond that first relationship became explicit, a latent risk in the personality model surfaced: `personality.md` described Gaia's voice as adaptive — "her phrasing, framing, and register shift toward theirs." For one user, that reads as attentiveness. Generalized to many users, it is the exact mechanism by which Gaia would start to sound like whoever she's talking to, and lose the one thing SOUL exists to guarantee — that she is recognizably herself to everyone, always.

**What changed.**

- `frontend/src/gaia/identity/soul.md` — the canonical constitution, loaded as the system prompt — now explicitly instructs Gaia not to adopt a person's slang, vocabulary, or speech patterns to sound familiar. She may adjust warmth, length, and timing; never her manner of speaking.
- `docs/personality.md` §1 — "Adaptive over time" was rewritten to "Attuned, never mirrored," making the same distinction at the architectural-description level.
- `docs/personality.md` §10 — added an explicit "What May Adapt vs. What Never Does" list, splitting personalization into what's per-user tunable (length, timing, initiative, warmth within her own register) versus what is fixed for every user (vocabulary, values, willingness to disagree, core character).

**Why this matters.**

Attunement and mimicry look identical in the short term — both make an assistant feel more natural to talk to. They diverge completely over a lifetime of many relationships: attunement compounds trust because the person always knows who they're talking to; mimicry erodes identity because Gaia becomes a reflection of each user rather than a constant presence. Vision's promise — "the person and Gaia who understand each other so well" — depends on there being one Gaia to understand, not a version of her that reshapes itself around whoever is present.

**The test going forward.** Understanding shows up in *what* Gaia says — relevance, timing, restraint. It must never show up in *how* she sounds. Any future personalization feature should be checked against this line before it ships.

---

## Amendment — Foundation Engine Was Loading the Wrong SOUL

**Context.** While tracing whether the mimicry-vs-attunement fix above actually reached the model, we found that `foundation/loader.ts` resolved every foundation document — including `soul.md` — from `docs/`. That meant the artifact's `soul.md` entry, and therefore the real system prompt sent to Hermes on every turn (via `FoundationEngine.getPrompt()` in `useConversation.js`), was `docs/soul.md`: the architectural *overview* of SOUL, not the constitution.

The actual constitution — the "You are Gaia…" document with her character, communication rules, and boundaries — lives at `frontend/src/gaia/identity/soul.md` and is exported as `SOUL_SYSTEM` from `identity/soul.js`. That export was never imported anywhere except its own test. It had no effect on runtime behavior.

**What changed.**

- `foundation/loader.ts` now resolves `soul.md` from `frontend/src/gaia/identity/soul.md` specifically, while every other foundation document continues to load from `docs/`.
- `foundation/index.ts`'s watch mode now watches the identity directory in addition to `docs/`, so identity edits rebuild the artifact automatically during `dev:web` / `dev:desktop`.
- `docs/soul.md` is unchanged and keeps its intended role as the human-facing architectural overview — it's just no longer mistaken for the prompt itself.

**Open question.** `docs/soul.md`'s exact intended relationship to the canonical file — how much duplication between the two is intentional versus accidental drift — needs a pass to confirm against the original design intent before we treat this as fully settled.

**Why this matters.** This bug meant SOUL edits — including the attunement-vs-mimicry fix directly above — silently had zero effect on what Gaia actually said, while every document and test suggested otherwise. A constitution that isn't wired to the thing it's supposed to govern is worse than no constitution: it creates false confidence that identity is locked down when it isn't.

---

## Amendment — IntentIQ & OrchestratorIQ

**Context.** The Reasoning Pipeline in `architecture.md` (`Intent → Source Resolver → Reasoning Profile → Model Router → Reasoning Model → Gaia Personality Filter → Response`) already named the stages, but not the judgment structure inside them. As multi-provider routing became concrete — Gaia choosing between Hermes, GPT, Venice, DeepSeek, and future models per turn — a design risk surfaced: without a named split between "what does the user want" and "which model answers, and does the result still sound like Gaia," the two decisions tend to collapse into one, and the answer to "should this response have been said" silently becomes "which model happened to generate it." That is the exact failure `Character Before Model` (`principles.md`) exists to prevent.

**What changed.**

- `docs/orchestrator.md` — new document naming the two judgment layers inside the reasoning pipeline:
  - **IntentIQ** owns Intent, Source Resolver, and Reasoning Profile selection. It reads what the user actually wants (humor, creative writing, technical explanation, etc.) and hands off a named reasoning profile. It never talks to a provider and never filters output.
  - **OrchestratorIQ** owns Model Router, provider execution, and the Gaia Personality Filter. It routes to whichever provider best suits the reasoning profile, then passes every result — regardless of which provider produced it — through SOUL before it can reach the user.
- `docs/README.md` — added as document 8 in the foundation index.
- A companion principle was recorded alongside `Character Before Model`: **Intent Determines Reasoning** — Gaia selects the reasoning profile that matches the user's intent (humor treated as humor, technical discussion treated as technical discussion) rather than applying one flattened style, or one blanket restriction, to every conversation.

**Why this matters.** This closes off "uncensored mode" as a concept before it could ever be built as one. There is no user-facing toggle that turns Gaia's judgment off, and no provider gets its own bespoke Gaia-shaping logic — every provider's raw output passes through exactly one Personality Filter, in one place, regardless of which model produced it. It also keeps provider changes invisible where they belong: swapping or adding a provider is a change to OrchestratorIQ's routing table only, never to IntentIQ's understanding of the user or to what SOUL considers "in character." If Gaia ever says something that doesn't sound like her, the question "did IntentIQ misread the moment, or did OrchestratorIQ let something through" now has exactly one place to look.

**Relationship to the six layers.** IntentIQ and OrchestratorIQ are not new architectural layers alongside SOUL, Hindsight, Hermes, Chronicles, MCP, and Gaia Desktop. They are the internal judgment mechanism of the reasoning pipeline that already runs inside Hermes — how Hermes stays model-agnostic while remaining governed by SOUL, turn by turn.

---

## Amendment — The Intent Engine (Hermes Becomes a Tool, Not the Entry Point)

**Context.** Since Milestone 2, every turn from Gaia Desktop went straight to Hermes — architecture.md said so explicitly ("Gaia Desktop knows only Hermes"; "Hermes Agent is the orchestration entry point"). That was the right call for "Gaia Speaks": there was exactly one capability, so there was nothing to route between. It stopped being right the moment Gaia was meant to have more than one capability. With only Hermes wired up, "send everything to Hermes" and "understand intent, then decide" are indistinguishable — the seam was never built because it was never exercised. Left alone, every future capability (a direct Hindsight lookup, a direct MCP action) would have been bolted onto Hermes from the inside, because Hermes was the only door in. That is precisely how Gaia ends up as "just a shell around Hermes" instead of an intelligence that happens to use Hermes for reasoning.

**What changed.**

- `docs/architecture.md` — added a new layer, the **Intent Engine** (§4.2), sitting between Gaia Desktop and every capability. Gaia Desktop now depends on the Intent Engine only; the Intent Engine depends on SOUL and routes to Hermes, Hindsight, Chronicles, and MCP. The system diagram (§2), the interaction flow (§5), the streaming lifecycle (§10), and the extensibility rules (§13) were updated to route through it. §9 (backend justification) was amended to clarify the Intent Engine is a client-side routing layer, not a new backend — it does not trigger the "no speculative backends" stance.
- `docs/orchestrator.md` — added a scope note distinguishing the new, Gaia-level **Intent Engine** (decides *whether* Hermes is needed at all) from the existing, Hermes-internal **IntentIQ** (decides, once Hermes has already been chosen, *what kind of reasoning* it should do). The "Relationship to the Six Layers" section became "Seven Layers."
- `docs/vision.md`, `docs/README.md`, `docs/coding-standards.md`, `docs/roadmap.md`, `docs/soul.md` — the "six layers" references updated to seven, with the Intent Engine's one-line responsibility (understanding & routing) stated consistently everywhere the other six are listed.
- `docs/roadmap.md` — added an Intent Engine **routing skeleton** as a V1 Could Have: the seam is introduced now, with Hermes as its only routed capability. No new non-Hermes capability ships in V1; only the dispatch point that will let them ship later without re-architecting how Gaia Desktop talks to her capabilities.

**Why this matters.** The instruction that triggered this amendment was blunt: *"Gaia is momenteel slechts een schil om Hermes heen. Dat is niet het doel."* — Gaia is currently just a shell around Hermes, and that is not the goal. Hermes was always meant to be one of Gaia's tools, chosen when reasoning is genuinely what a turn needs — not the default everything passes through because it happens to be the only thing wired up. Naming the Intent Engine now, while only one capability exists behind it, means the routing decision gets designed deliberately instead of discovered accidentally the first time a second capability shows up. It also keeps `Character Before Model` and `Intent Determines Reasoning` intact: those principles governed *how* Hermes reasons once selected; they said nothing about *whether* Hermes should be involved at all. That question needed its own owner, and now it has one.

**What this does not change.** SOUL still governs identity. Hindsight is still storage-abstract. Hermes still owns model-agnostic provider routing internally, and IntentIQ/OrchestratorIQ still run exactly where they always did — inside Hermes, after the Intent Engine has already handed it a turn. No provider ever surfaces to the user. The only thing that moved is *where the first decision is made*: at Gaia's level, not inside the one capability that used to be the only option.

**Open question.** V1 ships the Intent Engine as a skeleton with a single routed capability (Hermes), so its routing logic is trivially "always Hermes." The real test — does it route correctly once a second capability exists — is deferred until a concrete non-Hermes capability is chosen (see roadmap.md V2/V3). Until then, treat the Intent Engine's decision function as unproven, not as validated by V1 shipping.

---

## Amendment — Gaia the Agency, Logos the Cognitive Layer (Intent Engine Superseded)

**Context.** The Intent Engine amendment above got the direction right — Hermes had to stop being the default entry point — but named the fix as a *routing layer* sitting between Gaia Desktop and her capabilities. That framing didn't survive contact with the actual near-term capability set. Once Melodiq (music) and SongCompanion (song-related work) became concrete, "a layer that routes turns to capabilities" still implicitly treated *some* capability as the answer to every turn — it just moved the assumption from "always Hermes" to "always one of Hermes/Hindsight/Chronicles/MCP." It never named who was doing the routing, or why a turn might need no capability at all. `architecture.md` v2.0.0 fixes that by naming Gaia herself, not a routing layer, as the thing that decides.

**What changed.**

- `docs/architecture.md` (now v2.0.0) — replaced the Intent Engine with **Gaia** as the agency (acts, decides, maintains continuity) and **Logos** as her cognitive reasoning faculty (`intentIQ` + `reasonIQ` — interprets input, constructs meaning, but does not act or route on its own). **Capabilities** (Hermes, Melodiq, SongCompanion, MCP, and others) are named explicitly as optional instruments Gaia reaches for — never a default, never assumed. **Feedback** is named as a first-class input into Logos, not an implicit side effect of memory policies. §15 records the full "Key Distinctions from Previous Architecture" table (v1.0.0 → v2.0.0); §16 lists `orchestrator.md` as the first downstream document to recontextualize.
- `docs/orchestrator.md` — the scope note now distinguishes **Logos's `intentIQ`** (Gaia-level: decides whether a capability is needed at all, and which one) from **this document's IntentIQ** (Hermes-internal: once Hermes is chosen, decides what kind of reasoning it needs). "Relationship to the Seven Layers" became "Relationship to Gaia's Structure."
- `docs/vision.md`, `docs/README.md`, `docs/coding-standards.md`, `docs/roadmap.md`, `docs/soul.md` — "Intent Engine" and the seven/six-layer counting language replaced with the Gaia/SOUL/Logos/Hindsight/Capabilities/Desktop structure. **Hindsight is explicitly not folded into "capabilities"** in any of these rewrites — it stays a distinct, load-bearing layer, unlike Hermes/Melodiq/SongCompanion/MCP, which are genuinely optional.
- `docs/roadmap.md` — the V1 "Intent Engine routing skeleton" Could-Have became a **capability router skeleton** living inside Gaia's own orchestration (architecture.md §2, §9), same intent: Hermes is the only wired capability in V1, but the seam exists for V2/V3.
- The untracked scratch file `docs/architecturev2` — an intermediate draft matching the Intent Engine model above — was deleted; this log entry and the previous one now carry that history.

**Why this matters.** Naming Gaia as the agency, rather than naming a routing layer, closes the gap the Intent Engine amendment left open: a routing layer can still be designed as if some capability is always the right answer, just later and less visibly. An agency that *may* reach for a capability — or may not — cannot collapse back into a shell around any one of them, Hermes included. This also gives Melodiq and SongCompanion a home that doesn't require inventing a new routing concept per capability: they're instruments alongside Hermes, governed by the same rule (§14: "No capability is the default").

**What this does not change.** SOUL still governs identity, read-only to Logos and capabilities. Hindsight is still storage-abstract, and still not optional — Logos and Gaia depend on its memory contracts for continuity the same way they depend on SOUL for identity; nothing about naming Gaia as the agency makes memory something she can take or leave. IntentIQ/OrchestratorIQ still run exactly where they always did — inside Hermes, downstream of whatever decided Hermes was needed. No provider ever surfaces to the user. What moved, again, is *where the first decision is named as living*: not in a dedicated routing layer, but in Gaia herself, via Logos.

---

## Amendment — Gaia Cloud: Where Gaia Actually Runs

**Context.** The two amendments above fixed *what decides* (Gaia, via Logos) but left an unstated assumption in place: that Gaia — her agency, Logos, orchestration, and Hindsight — runs on the desktop client, the same assumption every version of this document had carried since Milestone 2 ("Gaia Desktop knows only Hermes/Gaia," §9's old stance of "Gaia remains a desktop client"). That assumption stops being tenable the moment a second client (mobile, in particular) is a real near-term goal. A desktop-hosted Gaia would mean a mobile app either talks to the desktop machine (impractical) or re-implements Logos, Hindsight access, orchestration, and identity itself — which re-creates a second Gaia, not a second interface to the same one. The instruction that triggered this amendment named the shape directly: reasoning and intelligence belong in the cloud; the desktop app is Gaia's interface, communicating with that cloud; Hindsight lives there too; the desktop app is presence, not brain.

**What changed.**

- `docs/architecture.md` (now v2.1.0) — added an explicit **Deployment Topology** section naming **Gaia Cloud** as where Gaia, Logos, her capabilities, and Hindsight run, and **Gaia Desktop** as a client reaching Gaia over a secure **Gaia API**. The Core Architectural Model and System Overview diagrams (§2) were redrawn with a Gaia Cloud boundary wrapping Gaia/Logos/Capabilities/Hindsight, and Gaia Desktop outside it as a client box. §3 (Gaia Desktop) was retitled "The Primary Client" and rewritten to state plainly that it does not host Logos, memory, or orchestration. §4.3, §4.4, and §4.9 were updated to name Gaia Cloud as where Gaia and Hindsight run and to name Gaia Desktop as a client. §5's flow and dependency directions now cross the Gaia API explicitly. §9 was rewritten from "avoid backends until proven" to "Gaia Cloud is the proven baseline, not speculative — only *additional* infrastructure beyond it stays speculative." §11, §12, §13, and §14 were each updated for the same distinction; §13 in particular now states the core principle plainly: **clients are representations of Gaia, not instances of Gaia.** §15 gained a v2.1.0 column; §16 was updated with next steps for propagation.
- `docs/README.md`, `docs/vision.md`, `docs/roadmap.md` — propagated the Gaia Cloud / client split: "Gaia Desktop" is now consistently described as a client, not an application that owns experience in isolation; "no speculative backend" language was corrected to "Gaia Cloud is the baseline, not speculative — only infrastructure beyond it is."
- A local **Codex Capture** capability (observing on-device activity and reporting it to Gaia Cloud as raw observations, never as pre-interpreted meaning) was discussed and **deliberately deferred** — explicitly named as out of scope in `architecture.md`'s Deployment Topology section, and not reflected in any diagram, so this version of the architecture stays uncluttered. It will be designed as a local capture capability when prioritized, without pre-deciding its shape now.

**Why this matters.** This is the change that makes "same Gaia on desktop and mobile" true by construction rather than by discipline. If Gaia's agency lived on a client, keeping her consistent across two clients would require active synchronization work and would always risk drifting into two Gaias. With Gaia in the cloud, a second client is, by default, talking to the same her — same state, same memory, same identity — because there is only one place any of that exists. It also resolves a tension the previous amendment left unaddressed: naming Gaia as "the agency" only fully means something once it's clear *where* that agency actually executes.

**What this does not change.** SOUL, Logos, Hindsight, and the capability boundaries established in the previous two amendments are unchanged in substance — only their deployment location is now explicit. Hindsight remains not-optional, and its cloud placement reinforces rather than changes that: it is load-bearing infrastructure shared by every client of the same Gaia, not a per-device cache. No provider ever surfaces to any client. Gaia Desktop's UX priorities (§1.1: designed first, deepest presence) are unchanged — "first client" is not "less important," it is a statement about where depth of *design* originates, not where Gaia *runs*.

---

## Amendment — Hypotheses: Holding Understanding Before It's Earned

**Context.** Hindsight, as specified through v2.1.0, recognized two kinds of durable content — reflections and patterns — and one binary: something was either not remembered, or remembered as settled. That binary doesn't match how understanding actually forms. Gaia might notice, after a handful of observations, that Bo tends to be more creatively productive late at night — a real signal, but not yet something she should treat with the same confidence as a confirmed fact or a repeatedly-verified pattern. Forcing that signal into "not remembered" throws away a genuine, useful observation; forcing it into "remembered as fact" overstates what Gaia actually knows and risks exactly the false-certainty SOUL already forbids ("she never pretends certainty"). The instruction that triggered this amendment named a concrete prior art for the missing middle: the `hypothesis` concept from the Stash memory-layer project, where a hypothesis is explicitly not-yet-fact — carrying `confidence`, `evidence`, an optional `verification_plan`, and a lifecycle (`proposed → testing → confirmed/rejected`), with a confirmed hypothesis able to graduate into a fact.

**What changed.**

- `docs/architecture.md` (now v2.2.0) — added **§6.1 Hypotheses**, specifying hypotheses as a fourth kind of content inside Hindsight (alongside memories, facts, and patterns), explicitly **not** a new layer, not a Logos responsibility, and not a reasoning engine. A hypothesis carries `statement`, `confidence`, `evidence` (with provenance), an optional `verification_plan`, and `status` across the `proposed → testing → confirmed | rejected` lifecycle; confirmed hypotheses promote into facts/patterns through the normal memory-policy path, and rejected ones are retained with their outcome rather than deleted. §4.4 (Hindsight) was updated to name hypotheses among what it holds. §7's Hindsight contract list gained `propose_hypothesis`, `update_hypothesis`, `resolve_hypothesis`, `query_hypotheses`. §8 (provenance & user control) was updated so the memory view always surfaces a hypothesis's confidence and status distinctly from confirmed content — never displayed indistinguishably from settled understanding. §14 gained an explicit enforcement rule: a hypothesis is never presented as a fact, anywhere — to Logos, in a response, or in the memory view. §15 records the v2.2.0 row.
- `docs/vision.md` — the Hindsight row of the layer-responsibility table now names hypotheses alongside reflection and pattern formation.
- `docs/roadmap.md` — added hypotheses to V2's Should Have, alongside pattern formation, since the two land at the same relationship phase (Middle — Gaia moving from remembering to understanding).

**Why this matters.** The credit for this idea belongs to a genuine architectural insight from Stash's design, not to adopting Stash itself — the instruction was explicit that Gaia should take the *concept* (a testable, confidence-bearing knowledge object with a lifecycle), not treat "Gaia implements Stash" as the goal, and nothing here creates a dependency on that project or its code. What hypotheses give Gaia is a way to hold uncertainty honestly instead of collapsing it prematurely in either direction — discarding a real signal because it isn't yet proof, or treating a plausible-looking pattern as settled fact before it has earned that status. Keeping hypotheses inside Hindsight, not inside Logos, matters for the same reason the last two amendments mattered: a hypothesis is memory content with a lifecycle, not a reasoning operation, so it stays inspectable, editable, and forgettable exactly like everything else Hindsight holds (§8) — it does not become a second, less-visible place where understanding about the user accumulates.

**What this does not change.** Facts, patterns, and reflections keep their existing meaning and contracts; hypotheses are additive, not a replacement for anything. Logos's boundary is unchanged — it still does not store anything; it reads what Hindsight gives it, now including confidence-tagged hypotheses alongside settled content, and reasons accordingly. SOUL's "never pretends certainty" was already a constraint on Gaia's language; this amendment gives Hindsight a structural way to help her honor it, rather than leaving it to reasoning-time discipline alone.

---

## Amendment — The First Real Logos intentIQ

**Context.** `architecture.md` had named `intentIQ` as one of Logos's two faculties since v2.0.0, but no concrete implementation existed. `frontend/src/gaia/state/intentIQ.js` — a synchronous keyword/phrase matcher over the last few user turns, returning only `{ type: 'technical' | 'gaia' | 'conversation' }` — filled the seam as a deliberate, explicitly-labeled stand-in, consumed solely by Foundation document selection. It never claimed to interpret intent; it was a local context hint. This amendment gives Logos's `intentIQ` its first real implementation: an LLM call, through the existing generic reasoning-provider abstraction, that returns a schema-validated `IntentDecision`.

**What changed.**

- Added `frontend/src/gaia/logos/` — Logos's first concrete home in the codebase, with a public entry point (`logos/index.js`) exporting `interpretIntent` (only `intentIQ` is implemented; `reasonIQ` is deliberately not started).
- Added `frontend/src/gaia/logos/intentIQ/registry.js` — a small, closed intent taxonomy (`chat.general`, `technical.explain/debug/design/implement`, `memory.recall/correct`, `creative.write/brainstorm`, `analysis.compare/plan`, `action.execute`, plus the honest non-intents `unknown` and `ambiguous`), each entry carrying a definition, positive examples, hard negatives, the capability it would genuinely require, and a reasoning profile. Every entry exists because it drives a real downstream distinction — topic and intent are kept explicitly separate (the "explain / implement / design the same React component" case named in the brief).
- Added `frontend/src/gaia/logos/intentIQ/schema.js` — a zod-validated `IntentDecision` contract (`intent`, `intentFamily`, `status`, `confidence`, `candidates`, `entities`, `sourceOfTruth`, `capability`, `reasoningProfile`, `needsClarification`). No provider or model identifier is, or may ever be, part of this contract. Malformed JSON, an invalid enum value, a missing field, or an out-of-range confidence all fail closed to a schema-valid `fallbackDecision()` (`status: 'unknown'`, `capability: 'none'`) — a bad classification never reaches Gaia's pipeline, and a failure here never breaks the conversation.
- Added `frontend/src/gaia/logos/intentIQ/prompt.js` — a dedicated IntentIQ prompt (not the SOUL/Foundation response prompt). It instructs the model never to answer or solve the user's task, to separate topic from intent, to abstain into `ambiguous`/`unknown` rather than force a label, and to return JSON only.
- Added `frontend/src/gaia/logos/intentIQ/intentIQ.js` — the orchestration facade. It calls the *generic* `ReasoningProvider.chat()` (`integration/reasoning`), the same seam the rest of Gaia Desktop already uses — never Hermes-specific code — so the implementation is conceptually `intentIQ → reasoning provider abstraction → current provider`, replaceable later without callers changing.
- Added `intentIQ.test.js` (contract/behavior tests against a mocked provider — accepted intents, topic/intent pairs, ambiguity, unknown, needsClarification, all four schema-failure shapes, provider failure, no provider/model leakage, never producing a user-facing answer) and `evaluationSet.js`/`evaluationSet.test.js` (a 45-example fixture of realistic Gaia turns, including hard negatives and boundary cases, for inspectability and regression prevention — not a live-LLM benchmark).
- Relabeled `frontend/src/gaia/state/intentIQ.js`'s header comment as an explicit **legacy local heuristic**, distinct from the new Logos-level semantic `intentIQ`. Its behavior, exports, and Foundation-selection role are unchanged.
- Wired `useConversation.js`'s `send` path to call the new `interpretIntent` fire-and-forget and `console.debug` the resulting `IntentDecision` in non-production builds only. This establishes the seam end to end — user message → IntentIQ → validated IntentDecision → existing Gaia response flow — without changing the response itself. Capability routing and Foundation selection are **not** wired to the new decision yet; `deriveIntent()` still drives Foundation selection.
- `docs/orchestrator.md` (now v1.1.0) gained a short implementation note distinguishing its Hermes-internal IntentIQ/OrchestratorIQ pipeline (unchanged) from Logos's now-implemented `intentIQ`.

**Why this matters.** The architecture has said "Logos interprets what the user is trying to achieve" since v2.0.0; until now nothing in the codebase actually did that — the desktop only ever picked a Foundation-document bucket. This closes that gap the way the architecture requires it closed: `intentIQ` interprets and stops — it does not answer, does not execute a capability, does not choose a provider, does not touch SOUL or Gaia's personality, does not decide whether generated content is acceptable, and does not become the orchestrator. A valid decision may legitimately carry `capability: "none"`; nothing here hard-codes a capability as the default for every turn (architecture.md §14).

**What this does not change.** Gaia's response flow, capability routing, and Foundation selection are untouched — `deriveIntent()` (the legacy heuristic) still does that job, and `runStream` reaches Hermes exactly as before. Hindsight is unchanged; IntentIQ decisions are not written to memory anywhere. SOUL and Gaia's personality are unchanged and untouched by this faculty. `reasonIQ` remains unimplemented — this amendment is `intentIQ` only.

**What remains deliberately unimplemented.** Per the accompanying implementation brief and the Manus research report it was built alongside (`gaia_intentiq_report.docx`, 2026-08-16): no deterministic pre-check/safety-rule stage, no local embedding or supervised classifier stage, no calibrated per-intent confidence thresholds or top-two-candidate margin gate (the model is trusted, within the schema, to self-report `ambiguous`/`unknown`), no shadow-mode comparison against the legacy heuristic, no live benchmarking of the evaluation set against a running provider, and no capability-routing or Foundation-selection dependency on the new decision. The report's recommended target is a four-stage cascade (deterministic rules → local semantic classifier → calibrated ambiguity/OOD gate → selective LLM adjudication) with the LLM called only for uncertain or novel cases; this milestone instead does the single LLM call the brief asked for first, behind a contract shaped so that cascade — or any other classifier — can replace this module's internals later without any caller changing. IntentIQ has been validated against mocked provider responses only; it has not yet been run against a live reasoning provider, so it is not claimed to be production-ready.

**Next milestone.** Once this decision has been observed in practice (via the dev-only logging) across enough real turns, a deliberate follow-up change can wire `IntentDecision.capability`/`reasoningProfile` into actual routing and retire `deriveIntent()`'s Foundation-selection role in its favor — and, separately, begin `reasonIQ`.

---

## Amendment — Memory Recall Becomes an Explicit, Gated Capability

**Context.** `assembleTranscript()` in `useConversation.js` called `recallRelevantContext()` on every turn, gated only by `memoryPolicy.shouldRecall()` — a length/filler check that recalled for essentially any substantive message (≥12 characters, not on the filler list). In practice this meant Hindsight was consulted on nearly every real turn, not because the turn showed any sign of needing long-term memory, but because nothing stopped it. This is the automatic-injection pattern named in the instruction that triggered this amendment: memory should be something Gaia reaches for deliberately, not something dumped into every prompt by default.

**Investigation finding.** Hindsight itself has no daemon-side auto-injection to disable — confirmed by reading `HindsightProvider.js` and this repo's Hindsight-adjacent config (`services/cognition`, `proxy/.env.example`): it is a plain call-only HTTP API (`/memories/recall`, `/memories`, …) that only ever responds to a request Gaia's own code makes. There is no "tool-only mode" setting to find or flip, and Hindsight's own deployment isn't part of this repo. The automatic behavior was entirely Gaia's integration boundary being too permissive about when to call it — so the fix lives entirely there, per the instruction's own fallback: "Gaia remains in control of whether it is called."

**What changed.**

- `frontend/src/gaia/state/memoryPolicy.js` — `shouldRecall()` replaced its length-only gate with a small, bilingual (NL/EN), word/phrase-boundary signal check across two principled groups: explicit past-reference cues (`remember`, `remind`, `last time`, `weet je nog`, `je zei`, …) and durable cross-conversation nouns (`project`, `database`, `server`, `deployment`, `config`, `decision`, `preference`, …). No signal → no recall, even for a long, substantive message — the default flipped from "recall unless trivial" to "don't recall unless there's a reason to." This is the gate named in the turn lifecycle diagram (`USER TURN → does this turn require memory? → recall only on yes`) — a heuristic stand-in for that Logos-level judgment, in the same honest, explicitly-labeled spirit as `shouldReflect` and the legacy `intentIQ.js` heuristic. It deliberately does **not** call the new `interpretIntent` (Logos's real `intentIQ`, added in the amendment above) — that's a full LLM round-trip, and gating recall on it would add that latency to every turn before Hermes even starts, which is exactly the cost this gate exists to avoid.
- `frontend/src/gaia/state/memoryContext.js` — added `condenseMemoryContext()`, a normalization layer between a raw Hindsight recall response and the system-prompt block: it strips everything but the summary text, normalizes whitespace, deduplicates exact repeats, caps the block at 6 lines, and tags any reflection recalled with `confidence < 0.55` as `(uncertain)` rather than stating it as settled — never merging or resolving differing/conflicting summaries, so Logos still sees a disagreement as a disagreement. `renderMemoryContext()` now calls it internally; its exported signature is unchanged, so no caller needed to change.
- Tests updated/added in `memoryPolicy.test.js`, `memoryContext.test.js`, and `useConversation.test.js` for the new gate (trivial/no-signal → skip; past-reference/durable-context → recall), the condensation layer (compact output, no raw fields, dedup, cap, uncertainty tagging, conflicting memories kept distinct), and failure paths (provider throw/timeout → conversation continues).

**Why this matters.** Hindsight was already correctly scoped as call-only, storage-abstract memory (architecture.md §4.4) — nothing about *what* Hindsight does changed. What was missing was discipline at the one seam that decides *whether* to call it. A gate that fires on nearly every message isn't really a gate; this amendment makes the "is memory needed" question a real, testable, conservative decision, without adding a second reasoning pass or moving any judgment into Hindsight itself.

**What this does not change.** `useConversation.js`'s turn lifecycle is structurally identical — recall still happens (or doesn't) inside the same `assembleTranscript()` call, before Hermes; reflection after a successful turn is unchanged and remains independent of recall. Hindsight's own contract, responsibilities, and boundary are untouched. SOUL is untouched. `IntentDecision`/`interpretIntent` (the amendment above) are unaffected and still only dev-logged — this gate does not consume or depend on them.

**What remains deliberately unimplemented.** No LLM-based memory-need judgment (the heuristic gate is the whole decision layer for this milestone); no per-domain or per-user-tunable thresholds; no shadow-mode comparison against the old permissive gate to measure recall precision/recall tradeoffs; no UI surface for the new behavior (none was requested, and architecture.md §8 already scopes memory visibility to the opt-in memory view, unbuilt in V1). A real Logos-level "is memory needed" judgment, and wiring recall to `IntentDecision.capability === 'hindsight'`, are both named as future work in the amendment above and are not part of this change.

---

## Amendment — The First Real Logos reasonIQ

**Context.** `architecture.md` names `reasonIQ` as Logos's second faculty since v2.0.0 — "what does this mean, how should I reason about it, and what conclusions follow?" — but until now only `intentIQ` had a concrete implementation (the amendment above). `intentIQ` answers what the user is trying to achieve; nothing in the codebase constructed understanding from that intent and the available evidence. This amendment gives `reasonIQ` its first real implementation, consuming `intentIQ`'s `IntentDecision` and producing a schema-validated `ReasoningResult`.

**What changed.**

- Added `frontend/src/gaia/logos/reasonIQ/` alongside `intentIQ/`, with the same file shape (`schema.js`, `prompt.js`, `reasonIQ.js`, tests, an evaluation fixture).
- `schema.js` — a zod-validated `ReasoningResult` contract: `interpretation`, `evidence` (each item tagged exactly one of `fact` / `inference` / `hypothesis`, with a `source` drawn from the same `SOURCES_OF_TRUTH` enum `intentIQ` already uses — principles.md's Source First list — and its own `confidence`), `uncertainties`, `contradictions`, `missingInformation`, `conclusions`, `hypotheses` (reusing `HYPOTHESIS_STATUSES` from `contracts/hindsight.js` directly, so a hypothesis reasonIQ proposes or re-evaluates is shaped exactly like the one Hindsight would eventually persist — no parallel vocabulary), `capabilityImplication` (a single suggested capability + reason — a suggestion, never an instruction), `recommendedNextSteps`, `reasoningProfile` (reusing `intentIQ`'s enum), `clarificationRecommended`/`clarificationQuestion`, and overall `confidence`. "Uncertainty" and "recommendation" — two of the five epistemic categories named in the brief — are deliberately not evidence *kinds*; they're their own top-level fields, because they're gaps reasonIQ flags or actions it suggests, not things it asserts. As with `intentIQ`, malformed JSON, an invalid enum, or a schema violation all fail closed to a schema-valid `fallbackReasoningResult()` (`confidence: 0`, an honest uncertainty statement, no fabricated conclusions) — a broken reasoning pass never masquerades as a confident one.
- `prompt.js` — a dedicated reasonIQ prompt (not the SOUL/Foundation prompt, not `intentIQ`'s prompt). It hands the model the `IntentDecision` verbatim plus recent conversation, any explicitly-retrieved memory, any existing hypothesis to re-evaluate, and attachment references; instructs it never to answer the user, never to speak as Gaia, never to execute or reference a capability/tool/MCP action, never to treat its own background knowledge as sourced evidence, never to silently resolve a contradiction, never to state a hypothesis as fact, and never to expose chain-of-thought — JSON only.
- `reasonIQ.js` — the orchestration facade, `reasonAboutTurn(intentDecision, messages, context)`. Calls the same generic `ReasoningProvider.chat()` the rest of Gaia Desktop already uses (via `getReasoningProvider()`) — never Hermes-specific code. Does not retrieve memory itself: per this implementation's brief and the existing memory-gate amendment above, memory retrieval stays an explicit decision made *before* reasoning; `reasonAboutTurn` only ever reasons over whatever `context.recalledMemory` it's handed, and does not assume an empty context means nothing exists.
- Extracted `frontend/src/gaia/logos/shared/parseJsonResponse.js` — the code-fence-tolerant JSON parser both faculties need — out of `intentIQ.js`, now that a second real caller exists (coding-standards.md §9: add abstraction when a second caller exists, not before). `intentIQ.js` was refactored to use it; behavior unchanged.
- `logos/index.js` now exports `reasonAboutTurn`, `ReasoningResultSchema`, `fallbackReasoningResult`, and `validateReasoningResult` alongside the existing `intentIQ` exports.
- `useConversation.js`'s dev-only Logos logging (previously `logIntentDecisionForDev`, now `logLogosForDev`) chains `reasonAboutTurn` after `interpretIntent` resolves, dev-logging both the `IntentDecision` and the resulting `ReasoningResult`. This does not pass recalled memory into the dev-log path — doing so would require either a second Hindsight recall call or a larger refactor of the turn lifecycle than this milestone calls for; `reasonAboutTurn` fully supports consuming recalled memory and existing hypotheses, exercised directly in `reasonIQ.test.js`.
- Added `reasonIQ.test.js` (32 tests covering: straightforward reasoning, ambiguous/low-confidence intent, fact/inference/hypothesis distinction, existing-hypothesis re-evaluation, contradictions including memory-vs-current-evidence, missing information, memory availability both ways, capability suggestion without execution, all schema-failure/provider-failure fallback paths, no provider/model leakage, no user-facing answer, no chain-of-thought field, no Hindsight/capability/SOUL mutation) and `evaluationSet.js`/`evaluationSet.test.js` (10 realistic cases: straightforward, non-trivial reasoning, incomplete evidence, conflicting memory, a tempting-but-unconfirmed hypothesis, correct-conclusion-is-uncertainty, no capability needed, capability may be useful, feedback changing the interpretation, and reconsidering an earlier assumption given new evidence).
- `docs/orchestrator.md` (now v1.2.0) extended its existing intentIQ implementation note to cover reasonIQ.

**The resulting boundary.**
- **intentIQ → reasonIQ:** reasonIQ consumes the `IntentDecision` as given and reasons within it; it does not independently reinterpret intent unless the evidence reveals a genuine inconsistency, in which case that becomes an uncertainty or contradiction in the result, never a silent override. If intentIQ reported `ambiguous`/`unknown`/low confidence, reasonIQ's prompt requires that uncertainty to survive into the `ReasoningResult` rather than being reasoned away.
- **reasonIQ → Gaia:** reasonIQ never generates the user-facing response, never speaks as Gaia, and never decides personality. It hands back `capabilityImplication` as a *suggestion* — Gaia (not yet built as a real decision/orchestration layer in this codebase — see "What remains deliberately unimplemented" below) is who would decide whether to act on it.
- **reasonIQ → Hindsight:** reasonIQ never calls a Hindsight contract, never persists a hypothesis, and never treats recalled memory as automatically true — each recalled item's own confidence travels with it into the evidence/contradiction handling. Hindsight persists; reasonIQ reasons (architecture.md §6.2) — this implementation does not blur that line in either direction.
- **reasonIQ → capabilities:** reasonIQ never executes, calls, or simulates calling a capability or MCP action — `capabilityImplication.suggested` is data, not an invocation. No test in `reasonIQ.test.js` observes more than one `provider.chat` call per `reasonAboutTurn`, precisely to guard against a capability call sneaking in.
- **reasonIQ → SOUL:** reasonIQ never reads, references, or reasons about SOUL content in this implementation; it is governed by the same "never pretends certainty" discipline soul.md states for Gaia herself, expressed here as a structural rule (fact/inference/hypothesis stay distinct, confidence travels with every claim) rather than by reading SOUL's text.

**Known interim placement — read before treating this as "Logos is in Gaia Cloud."** Per this implementation's own instructions, authoritative `reasonIQ` (and `intentIQ`) should live in Gaia Cloud, not Gaia Desktop — but this repository contains no Gaia Cloud service to place it in; `frontend/src/gaia/logos` is the only place Logos exists in code, a precedent `intentIQ` already set. `reasonIQ` follows that same precedent rather than inventing a second, inconsistent location, and is built with no desktop-specific dependency (no DOM, no React, no client-only state; it only speaks through `logos/index.js`'s exports) specifically so that migrating it behind a future Gaia API is a relocation, not a rewrite. This is flagged explicitly, not silently accepted: Logos living in the desktop client today is a known gap against architecture.md §2/§9/§14, carried forward from the intentIQ amendment and not resolved by this one.

**What remains deliberately unimplemented.** No autonomous Gaia orchestration or decision/goal/plan layer consuming `ReasoningResult` — Gaia's own "decide what to do with this understanding" step named in the cognitive loop does not exist yet in this codebase; `reasonAboutTurn` is currently only dev-logged, exactly like `interpretIntent` before it. No autonomous capability execution triggered by `capabilityImplication`. No autonomous hypothesis lifecycle — a hypothesis or re-evaluation reasonIQ proposes is never written to Hindsight; wiring `hypotheses[]` entries to `MemoryProvider.proposeHypothesis`/`updateHypothesis`/`confirmHypothesis`/`rejectHypothesis` is future work. No pattern-formation pipeline beyond the reasoning contract itself. No feedback subsystem — `context` accepts no feedback-shaped input yet; §13 of this implementation's brief asked only for the contract boundary to be establishable later, not an engine now. No model routing, provider selection, or personality filtering — those remain OrchestratorIQ's job, unchanged, inside Hermes, downstream of whichever capability Gaia eventually chooses. reasonIQ has been validated against mocked provider responses only, not a live reasoning provider, so — like intentIQ before it — it is not claimed to be production-ready, and Logos is not claimed to be complete merely because both of its named faculties now exist: the agency that decides what to do with their output is still unbuilt.

---

## Milestone 8 — One Gaia, Multiple Clients: Desktop Gets Its Own Face

**Goal.** Gaia Desktop stopped being a browser wrapper. Until now the Tauri shell loaded Gaia Web's React app in a webview (`frontendDist: ../frontend/build`) — one web application packaged two ways. The requirement was blunt and correct: Desktop must be a genuine native client with its own Tauri/Rust shell, its own frontend, its own conversation interface and presence layer, talking to Gaia Cloud through the API/WebSocket seam — while Gaia Web continues to work, independently, as the web client. One Gaia, multiple clients.

**What was built.**

- **`desktop/`** — a new, independent frontend (Vite + React), the desktop's own UI: sidebar with threads, conversation view, composer, presence bar with a breathing orb, settings panel. Gaia's dark, serif-accented design language, written for this client rather than imported from the web app.
- **`src-tauri/tauri.conf.json`** repointed from `../frontend` to `../desktop`; `beforeDevCommand`/`beforeBuildCommand` now drive the desktop UI's own dev server and build. A CSP was set for production builds (dev CSP stays open for Vite HMR).
- **Conversation over the Gaia Cloud seam, and nowhere else.** The desktop UI sends a turn via the Rust `ServerLink` (`server_request` → `POST conversation/turn`) and renders the reply. It performs no reasoning, loads no SOUL, calls no Hermes, no Hindsight, no cognition service — identity, memory, intent and reasoning are server-side by contract. The request/response envelope lives in `desktop/src/state/contract.js` with tests; when the cloud endpoint grows streaming, only the transport beneath this seam changes.
- **Presence from the link, not from the web app** — `useServerStatus` listens to the Rust `server://status` events; quiet mode toggles through the Rust presence controller. Failure phrasing is calm and typed (`phrases.js`, tested): no HTTP codes, no provider names, ever.
- **Desktop-only modules removed from the web codebase.** `frontend/src/gaia/{server,capture,settings}` and `ServerStatus.jsx` (interim desktop touches inside Gaia Web) moved into the desktop UI; the `@tauri-apps/api` dependency left `frontend/package.json`. Web tests (177) and build pass unchanged.
- Root `dev:desktop`/`build:desktop` no longer run the foundation engine — the desktop has no client-side SOUL to build.

**Architectural reasoning.**

- The earlier Rust layer (communication/capture/audio/notifications/settings/presence) was already built client-agnostic; this milestone only gave it its own face. No cognitive logic crossed into the desktop to get there — the "conversation endpoint" the desktop calls is a declared contract, honestly unimplemented on the cloud side until the Gaia API milestone lands it.
- Until that endpoint exists, a desktop conversation without a configured server degrades calmly: presence shows *present*, the welcome line explains, and a turn returns a quiet phrase pointing at settings. That is the correct failure mode for a client whose intelligence lives elsewhere — not an error screen.
- Gaia Web's client-side orchestration (HermesProvider, Hindsight recall/reflect, Logos) is *not* mirrored into the desktop. Duplicating it there would create a second, diverging copy of Gaia's cognition — exactly what "one Gaia, multiple clients" forbids.

**Trade-offs.**

- *In-memory threads* — same trade as web Milestone 2; persistence arrives with the desktop settings/local-cache layer, not before it's earned.
- *Plain-text replies* — markdown/LaTeX/Mermaid rendering arrives with the streaming transport, not before.
- *Desktop can't talk to the de facto VPS topology directly* — by design. It speaks the future uniform Gaia API only.

**What this does not change.** Gaia Web's behavior, build, and deployment (higaia.nl, same Docker network, same proxies) are untouched. The Rust capability modules, the split plan (`docs/split-plan.md`), and the provider-agnostic boundaries all stand; the split plan's "frontend is 100% shared" coupling point is now resolved by this milestone (see its addendum).

---

## Milestone 9 — The Gaia API: Gaia Answers from the Server Side

**Goal.** Milestone 8 left Desktop with its own face but nobody to talk to — the `conversation/turn` contract had no server side. This milestone builds it: `services/gaia-api`, the first piece of the real Gaia Cloud, implementing exactly the seam Desktop declares. One Gaia, multiple clients, and now a server for them to share.

**What was built.**

- **`services/gaia-api`** (Express, Node 22) — `POST /conversation/turn` (auth required) and `GET /health`. In: `{ messages }`, out: `{ reply }`. Non-streaming this phase; the streaming variant grows behind the same path — the desktop's `ServerEvent` seam is already waiting.
- **Server-side identity.** SOUL is loaded at startup from the repository's canonical `frontend/src/gaia/identity/soul.md` (baked into the Docker image; `SOUL_PATH` overrides) and prepended to every Hermes call. Missing or empty SOUL is a hard startup failure — a Gaia without her constitution must not speak. This is the first time identity has lived server-side since the dev-stub; now it belongs to Gaia Cloud, where architecture.md always put it.
- **Hermes orchestration server-side.** The API is the only place Hermes' URL, model and token exist in this path; the desktop holds just its own Gaia API token. Error responses are calm sentences — no provider names, no upstream status codes (tested).
- **Bearer-token auth, fail closed.** Comma-separated `GAIA_API_TOKEN` (one per client/device is the intended pattern); no token configured = every authenticated route refuses (503), wrong token = 401.
- **Deployment** follows the Hindsight/cognition posture: Tailscale-only binding (`100.65.0.15:8891`), untracked `.env`, docker-compose with repo-root build context so the image bakes in the canonical soul.md.
- **Desktop secret storage.** The auth token moved from `settings.json` to the OS credential store (Windows Credential Manager / macOS Keychain / session keyring) via `keyring`. On first launch any in-file token migrates automatically; saves strip the token from the file, and a keyring failure falls back to the legacy in-file behaviour rather than breaking settings.
- 15 backend tests (`node --test`): turn assembly (SOUL prepended exactly once, client fields stripped), validation, calm error mapping (asserting no `hermes`/port leakage), auth fail-closed/401/pass, hermes client contract, SOUL loader.

**How Desktop uses it.** Settings → Gaia Cloud: Server URL `http://100.65.0.15:8891` (tailnet), Auth token one of the configured values. The Rust `ServerLink` does the rest — health loop flips presence to *available*, turns cross `server_request`. CORS never applies: the client is native, the transport is Rust `reqwest`.

**What this does not change.** Gaia Web still talks to the de facto topology directly (Hermes proxy, Hindsight, cognition) — routing Web through the Gaia API is a later, deliberate migration, not a side effect of this milestone. Logos is still client-side in Web; when it moves server-side, this service is where it lands. Capture remains unimplemented by explicit instruction (the architecture is ready).

**Open items carried forward.** Streaming turns; conversation persistence server-side (threads are still client-in-memory); Web migrating onto this API; Logos relocation.

---

## Amendment — SOUL Fully Owned by Gaia Cloud, and Versioned

**Context.** Milestone 9 above says SOUL is "loaded at startup from the repository's canonical `frontend/src/gaia/identity/soul.md`" — accurate when that milestone landed, superseded the same week by this change and left undocumented until now (caught as stale doc drift during the Phase 1 repo split, `docs/split-plan.md`).

**What changed (`e200903`).** The canonical constitution moved from `frontend/src/gaia/identity/` into `services/gaia-api/identity/` — out of the web client's tree entirely, into the service that actually owns identity per architecture.md. Concretely:

- `services/gaia-api/identity/soul.md` is now the single canonical file (bumped to `version: 1.1.0`); the old `frontend/src/gaia/identity/soul.md` and its dead `soul.js` bridge (never imported anywhere except its own test — see the earlier amendment on the mimicry-vs-attunement fix) were deleted.
- `foundation/loader.ts`'s `IDENTITY_OVERRIDES` for `soul.md` now points at the new path, so Gaia Web's build (which still vendors/loads SOUL client-side, per Milestone 9's "what this does not change") resolves the same canonical content, just from its new home.
- `services/gaia-api/src/soul.js` now parses SOUL's `version` front-matter field and `gaia-api` surfaces it: `GET /health` returns `{ ok, soulVersion }`, and a new `GET /soul` returns `{ version }` — unauthenticated, no prompt content — so any client can observe which identity it's talking to without holding a token.
- 16 backend tests green (up from 15 — the new version-parsing/exposure behavior is covered), 174 web tests green.

**Why this matters.** This is the last piece of "identity belongs to Gaia herself, not to a client" (split-plan.md's framing) actually landing in code — before this, the service that was supposed to own SOUL was reading it out of the web frontend's source tree, the reverse of the intended dependency direction. It also means `services/gaia-api`'s Docker build context could shrink from the repo root to just `services/gaia-api/` itself (done alongside this doc fix) — nothing outside that directory is needed to bake the image anymore.

**What this does not change.** The Milestone 9 boundary is untouched: Desktop still carries no identity, Web still loads its own copy rather than reading from Cloud's service, and routing Web through `gaia-api` remains later, deliberate migration work.

---

## Amendment — Hermes Severed from Logos: A Tool, Nothing More

**Context.** `orchestrator.md` described IntentIQ and OrchestratorIQ as a pipeline running "inside Hermes," then spent a full paragraph disambiguating that pipeline's `IntentIQ` from Logos's own `intentIQ` faculty — explaining that Logos's `intentIQ` decides *whether* Hermes is called, while Hermes's `IntentIQ` decides *how Hermes reasons* once it's called, and calling the two "downstream" of each other. `docs/README.md`'s index repeated the same framing verbatim ("both inside Hermes, downstream of Logos"). `architecture.md` §16 even carried a standing to-do to go further and merge IntentIQ/OrchestratorIQ *into* Logos. Read plainly, all of this describes a real architectural relationship between Logos and Hermes — a hand-off, a dependency, a shared judgment structure — when the rest of the architecture (§4.5, §5.2: "Logos → depends on → SOUL," full stop) already says Hermes is one interchangeable capability among several, no different in standing from Melodiq or MCP.

**What changed.**

- `docs/orchestrator.md` (now v1.3.0) — retitled to name what it actually documents: **Hermes's Internal Reasoning Pipeline**. The opening now states plainly that Hermes is a capability Gaia may call, nothing more, and that this document records Hermes's own internal shape for the record — not because Gaia's cognition depends on it. The former "note on scope" and "implementation note," which spent two paragraphs relating this pipeline to Logos's `intentIQ`/`reasonIQ`, are replaced by one paragraph stating there is no connection: the naming similarity between Hermes's internal `IntentIQ` and Logos's `intentIQ` is coincidental, not architectural. The closing "Relationship to Gaia's Structure" section now says outright: "Hermes is a tool Gaia can use — nothing more, ... If Hermes were replaced by a different reasoning capability tomorrow, this entire document would be replaced with it; nothing about Logos, SOUL, or any other part of Gaia would need to change."
- The OrchestratorIQ routing step's hardcoded provider list ("Hermes, GPT, Venice, DeepSeek") was removed — it was also self-referential (Hermes's own router listing "Hermes" as one of its routing targets) and reintroduced the hardcoded-model-brand problem earlier amendments removed elsewhere.
- `docs/README.md`'s document index no longer says "downstream of Logos"; it now says IntentIQ/OrchestratorIQ are "private to Hermes's own internals, unconnected to Logos."
- `architecture.md` §16's to-do to fold IntentIQ/OrchestratorIQ into Logos is marked done, decided the other way — kept Hermes-internal, explicitly, rather than merged.

**Why this matters.** Logos exists so Gaia's own cognition survives any single capability being replaced, retired, or having a bad day. A document that ties Logos's naming, judgment structure, or "downstream" position to Hermes's internals — even just rhetorically, even while insisting they're separate — undermines that by inviting exactly the reading it was trying to prevent. The fix isn't a clearer disambiguation paragraph; it's removing the thing being disambiguated. Hermes gets to have whatever internal reasoning shape it wants, same as any capability; none of it is Gaia's concern, and none of it should read as though it were.

---

## Amendment — Hermes as a Standalone Capability (IntentIQ/OrchestratorIQ Removed)

**Context.** The previous amendment ("Hermes Severed from Logos") corrected `orchestrator.md`'s framing so it no longer read as a hand-off or dependency between Logos and Hermes — but it kept the document itself, still naming a Hermes-internal **IntentIQ** (intent → reasoning profile) and **OrchestratorIQ** (model routing → provider execution → Gaia Personality Filter), disambiguated from Logos's own `intentIQ` by a "coincidental naming collision" note. `architecture.md` §16 recorded that as a deliberate decision: keep it Hermes-internal, don't fold it into Logos. On review, that decision didn't go far enough. `intentIQ` had come to mean two different things — Logos's faculty for understanding what the user wants, and a same-named Hermes-internal stage for deciding how Hermes should reason once called — and no amount of disambiguation prose removes the ambiguity a shared name creates. More fundamentally, documenting Hermes's internal pipeline in Gaia's own `docs/` at all — model routing, provider selection, a "Gaia Personality Filter" living inside Hermes — represented Hermes's internal implementation as if it were part of Gaia's architecture, which contradicts the standing rule that capabilities are instruments Gaia invokes, not systems whose internals Gaia's documentation owns.

**What changed.**
- `docs/orchestrator.md` — **deleted**. It existed to document a concept (Hermes-internal IntentIQ/OrchestratorIQ) that should not exist in Gaia's architecture, so the fix is removal, not a rename or a clearer boundary note. No replacement document was created — there is nothing about Hermes's internals for Gaia's documentation to say.
- `docs/architecture.md` (now v2.3.1) — §4.5's boundary rule for Hermes now states plainly that Hermes's internal shape (how it decides what kind of reasoning to do, which provider answers, how it shapes output) is entirely Hermes's concern and outside Gaia's architectural boundary; Gaia gives Hermes an explicit task, Hermes executes it and returns a result. §16's item 1 is corrected from "decided the other way" to record this reversal and point here.
- `docs/README.md` — the document index's entry for `orchestrator.md` (as document 8) is removed.

**Logos's `intentIQ` is unchanged and is now the only `intentIQ` in Gaia's architecture.** `frontend/src/gaia/logos/intentIQ/` (and `reasonIQ/`) — Logos's real, implemented faculties (see the "First Real Logos intentIQ" and "First Real Logos reasonIQ" amendments above) — are untouched by this change. They were never the ambiguous half of the naming collision; the Hermes-internal concept was.

**What this does not change.** No code changes were required — nothing in this codebase (`services/gaia-api/src/hermesClient.js` included) ever implemented Hermes-internal model routing, reasoning profiles, or a personality filter; `orchestrator.md` documented a design intent for Hermes's own maintainers, not shipped Gaia code, so removing it removes no behavior. Hermes itself — its actual implementation, wherever it lives — is untouched; this is a documentation boundary correction, not a redesign of Hermes. Logos, SOUL, Hindsight, and every other capability boundary are unchanged.

**Why this matters.** "Remove Hermes's internals from Gaia's documentation" is a stronger, simpler rule than "keep disambiguating a name that collides with Logos's own faculty," and it is the rule the rest of this architecture already implies: capabilities are instruments Gaia may employ; their internal implementation is outside her architectural boundary the same way a database's query planner is outside an application's architecture. Hermes can change its own internal reasoning shape freely, under any name it likes, without ever touching a Gaia document again.

---

## Amendment — Response Engine: The Universal Expression Boundary

**Context.** An audit against the invariant "the user always talks to Gaia, never to a capability" found a real violation, not a documentation gap: `performStreamingTurn` in `services/gaia-api/src/turn.js` wrote SSE frames directly onto the HTTP response from inside the per-token callback Hermes invokes, and `performTurn`'s catch block separately duplicated the same calm-error text. Hermes's output *was* the response — formatted ad hoc, in two places, with no named boundary between "what a capability returned" and "what the user receives." That is exactly the `Gaia → Hermes → streamed text → User` pattern architecture.md warns against, even though nothing about the user experience was actually broken — SOUL, error language, and the wire contract were already correct by convention, just not by structure.

**What changed.**
- `services/gaia-api/src/responseEngine.js` (new) — `formatReply(text)` for the non-streaming path and `createStreamEmitter(res)` for the streaming path. Both are capability-agnostic: neither knows Hermes exists. `turn.js` now hands Hermes's result (or its thrown error) to one of these instead of writing to `res` or shaping an error string itself.
- `services/gaia-api/src/turn.js` — `performTurn` and `performStreamingTurn` no longer touch `res.write`/`res.status().json()` for the reply itself; they call the Response Engine. No wire-format change: the same `{ reply }` JSON shape and the same `{ choices: [{ delta }] }` SSE frames go out as before — verified by the full existing test suite passing unmodified (261 tests, zero changes needed) plus 10 new boundary tests in `test/responseEngine.test.js` asserting the seam's properties directly (calm-error mapping never leaks the underlying error; a stream emitter genuinely doesn't care which "capability" called `delta()`; headers are lazy; failure before vs. after the first delta produces the right shape either way).
- `docs/architecture.md` (now v2.4.0) — added §4.10 naming the Response Engine as Gaia's expression boundary, updated the Cognitive Loop diagram, §5.1 step 7, and §10's streaming lifecycle to show every response — native or capability-produced — converging on it, and added an enforcement line to §14.

**What was deliberately not built.** The instruction that triggered this amendment described a considerably larger shape: a multi-step execution loop capable of invoking several capabilities/tools in sequence, a capability registry, an action-permission pause/resume state machine, and a typed `GaiaResponseEvent` contract distinct from today's wire format. None of that exists in this codebase today, and none of it has a real caller: there is exactly one capability in this turn path (Hermes), Hindsight is consulted directly by `turn.js`'s own orchestration rather than through anything resembling a capability router, and `logos/reasonIQ.js`'s own header comment states plainly that it "never calls Hermes, Hindsight, or MCP; never selects or executes a tool" — the decision layer that would drive a multi-capability loop doesn't exist yet. Building the loop, registry, and permission machinery now would be scaffolding around a single real call site, which is exactly what coding-standards.md §9 ("no speculative generality... add abstraction when a second real caller exists, not before") and architecture.md §9 ("speculative infrastructure beyond that baseline is prohibited") rule out. A commissioned external review of the request (`gaia_github_repository_beoordeling.pdf`, Manus AI, 2026-08-20) reached the same conclusion independently: inspect the actual runtime before adopting anything, and if the existing lifecycle is already reasonable for its current one-capability shape, build the small in-house seam rather than a framework or a generalized loop. Its own decision table's "already has a reasonable lifecycle" row is what this codebase is.
- Also not changed: MCP, Melodiq, and SongCompanion remain undocumented-as-code (no implementation exists to route through anything); no new dependency was added (`package.json` still lists only `express` and `multer`); the SSE wire shape was left exactly as-is rather than redesigned into a capability-agnostic event contract, since that is a client-facing (cross-repo, Gaia Desktop) decision, not something this correction's blast radius should include.

**Why this matters.** The gap here was structural, not experiential — nobody could see Hermes "speaking for itself" from outside, because the ad hoc formatting already produced calm, correct output. But structure is what makes an invariant durable rather than accidental: with the formatting logic duplicated inline in two capability-calling functions, the next capability added to this codebase would have had no obvious single place to plug into, and would likely have re-derived (or subtly diverged from) the same calm-error and streaming logic a third time. Naming the seam now, while there is only one capability, is what keeps the second one from arriving as a special case.

**What this does not change.** Logos (`intentIQ`/`reasonIQ`), Hindsight's recall/reflect contracts, SOUL loading, and the Desktop-facing wire contract are all byte-for-byte unchanged. This amendment only relocates *where* response formatting happens, not *what* it produces.

---

## Amendment — SOUL: No Tool-Call Syntax, Ever

**Context.** Live in production, shortly after the web tool (`src/tools/braveSearch.js`) shipped, a real turn leaked raw pseudo-function-calling syntax straight into the user-visible reply: `<tool_call> <function=webSearch> <parameter=query>best Dutch text-to-speech providers API 2026</parameter> </function> </tool_call>`. The decision log for that exact turn showed the cause plainly — IntentIQ resolved `sourceOfTruth: "unknown"` for the Dutch phrasing ("Je mag wel even kijken naar een Nederlandse text-to-speech aanbieder"), so the Decision Engine correctly fell through to `action: "native"`, not the web tool. The native generator's underlying model — independently of any prompt engineering on Gaia's side, since neither `gaiaGenerator.js` nor `hermesClient.js` ever sends a `tools`/`functions` schema in the request body — hallucinated tool-calling markup anyway, apparently primed by the user's preceding message mentioning that Gaia "now has a websearch capability."

**What changed.** `identity/soul.md` (now v1.1.1) — one new bullet under "How you communicate": Gaia has no tool-calling or function-calling mechanism of her own; whatever a turn needs is already decided and resolved before she ever generates a word (exactly true of this architecture — see this document's own Decision Engine/Orchestrator amendments), so she must never emit tool-call syntax, function tags, JSON action blocks, or similar machinery-shaped notation, only plain natural language.

**What was deliberately not built.** No server-side sanitization/stripping of leaked tool-call-shaped text was added to the Response Engine. The prompt-level fix addresses the actual cause (a model producing text it was never asked to produce); a regex-based strip would be a band-aid over that, with its own false-positive risk (e.g. a user genuinely asking Gaia to explain what tool-calling syntax looks like). If this recurs after the SOUL update, a defense-in-depth filter at the Response Engine boundary is the next lever — it was not needed on the first attempt at the root cause.

**Why this matters.** This is a second, different instance of the same underlying invariant Gaia's architecture already protects for providers, models, and transport details: nothing about the machinery beneath Gaia should ever reach the person she's talking to. A hallucinated tool-call tag is just as much a leak of "the machinery underneath" as a stack trace or a provider name would be — SOUL already forbade the latter; it needed to say so for the former too.

---

## How to Read This Document

Each milestone records:

- The **goal** — what we were trying to make possible.
- The **architecture** — the choices we made, and the ones we rejected.
- The **trade-offs** — what we gave up to keep Gaia calm and coherent.
- The **lessons** — what we want future-us (and future-contributors) to remember.
- The **next milestone** — what unlocks next, and what guardrail protects it.

If a future change contradicts something here, the change should be deliberate — and Evolution should be updated alongside it.
