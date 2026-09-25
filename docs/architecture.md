---
title: Gaia — Architecture
document: architecture
version: 2.4.0
status: foundation
last_updated: 2026-08-20
owner: Gaia Product Foundation
framing: "Gaia is a lifelong personal intelligence designed to grow through understanding."
---

# Gaia — Architecture

> **Gaia is a lifelong personal intelligence designed to grow through understanding.**
>
> Gaia is the agency. Logos is Gaia's cognitive reasoning layer. Capabilities are instruments Gaia may employ.
>
> Gaia herself lives in **Gaia Cloud**. Gaia Desktop — and every future client — is a **representation of Gaia, not an instance of her**.
>
> Hindsight is persistent memory and accumulated knowledge, not a second brain. **Logos is where evidence becomes understanding.**
>
> The architecture exists to let that understanding deepen over a lifetime **without collapsing the boundaries** between the systems that make Gaia who she is.

---

# Core Architectural Model

```

    ┌───────────────────────────────────────────────────────────┐
    │                        GAIA CLOUD                          │
    │                                                             │
    │   ┌─────────────────────────────────────────────────────┐ │
    │   │                     GAIA — AGENCY                    │ │
    │   │                                                       │ │
    │   │   ┌───────────────────────────────────────────────┐ │ │
    │   │   │                    LOGOS                       │ │ │
    │   │   │           (cognitive reasoning layer)          │ │ │
    │   │   │                                                 │ │ │
    │   │   │     ┌───────────┐         ┌───────────┐        │ │ │
    │   │   │     │ intentIQ  │         │ reasonIQ  │        │ │ │
    │   │   │     │  what     │         │ what does │        │ │ │
    │   │   │     │  does the │         │ this mean │        │ │ │
    │   │   │     │  user     │         │ and what  │        │ │ │
    │   │   │     │  want?    │         │ follows?  │        │ │ │
    │   │   │     └───────────┘         └───────────┘        │ │ │
    │   │   └───────────────────────────────────────────────┘ │ │
    │   │                                                       │ │
    │   │   Goals / State                                       │ │
    │   │   Decision / Plan                                     │ │
    │   │   Orchestration                                       │ │
    │   │                                                       │ │
    │   │   ┌───────────────────────────────────────────────┐ │ │
    │   │   │                 CAPABILITIES                   │ │ │
    │   │   │             (optional instruments)             │ │ │
    │   │   │                                                 │ │ │
    │   │   │        Hermes · Melodiq · SongCompanion · ...  │ │ │
    │   │   └───────────────────────────────────────────────┘ │ │
    │   └─────────────────────────────────────────────────────┘ │
    │                                                             │
    │   Hindsight (long-term memory:                              │
    │     memories · facts · patterns · hypotheses)                │
    │   Chronicles (if/when it exists)  ·  other durable services  │
    │                                                             │
    └────────────────────────────┬────────────────────────────────┘
                                  │
                            secure Gaia API
                                  │
    ┌─────────────────────────────┴────────────────────────────────┐
    │                        GAIA DESKTOP                            │
    │                (a client — presence, not brain)                │
    │                                                                 │
    │        Conversation / voice interface · local UI state ·       │
    │        permissions & consent · presence, continuity render     │
    └─────────────────────────────────────────────────────────────┘
    ```

**Gaia** is the agency — the entity that acts, decides, and maintains continuity. Gaia **runs in Gaia Cloud**, not on the desktop.

**Logos** is Gaia's cognitive reasoning layer — the place where Gaia interprets input and constructs meaning. Logos consists of:

- **intentIQ** — within Logos: what is the user trying to achieve?
- **reasonIQ** — within Logos: what does this mean, how should I reason about it, and what conclusions follow?

**Capabilities** are instruments Gaia may employ — Hermes for reasoning, Melodiq for music, SongCompanion for song-related tasks, and others. No capability is necessary for Gaia's own cognition. Capabilities are tools Gaia reaches for when they serve her goals; they are not constituents of her identity.

**Hindsight** — Gaia's long-term memory — lives in Gaia Cloud alongside her, not on any single client. It is not an optional capability: Gaia's continuity depends on it the way it depends on SOUL.

**Feedback** is a first-class input in Gaia's cognitive loop — not an afterthought, not a side channel. Feedback flows into Logos, where it is interpreted and integrated into Gaia's ongoing understanding.

**Gaia Desktop** is a **client of Gaia Cloud** — the local presence and interface through which a person reaches Gaia. It is not where Gaia thinks, decides, or remembers; see §2a.

---

# Architecture Principles

Build against interfaces.

Not implementations.

Every subsystem has a single responsibility.

Prefer maintainability over cleverness.

Keep implementations replaceable.

---

# Cognitive Loop

```

USER INPUT
↓
LOGOS
├── intentIQ  (what does the user want?)
└── reasonIQ  (what does this mean? how to reason?)
↓
GAIA
├── Goals / State
├── Decision
└── Plan
↓
ORCHESTRATION
↓
CAPABILITY (optional)
├── Hermes
├── Melodiq
├── SongCompanion
└── ...
↓
RESULT
↓
GAIA (integrates the result)
↓
RESPONSE ENGINE (expresses it — see §4.10)
↓
USER
↓
LOGOS
├── Evaluate
└── Adapt
↓
FEEDBACK (first-class input)
↓
(next turn)

```

Logos is not Gaia herself. Logos thinks *for* Gaia, but Gaia ultimately decides what to do with those insights.

A capability-free turn takes the same path from a shorter start: Gaia decides no capability is required, and goes straight from Decision to the Response Engine. Whether or not a capability was used is invisible past that point — both paths converge on the same expression boundary before anything reaches the user (see §4.10).

---

# Platform Independence

Gaia is the application.

Desktop, browser and mobile are delivery platforms.

The platform should never define Gaia's identity.

**Gaia is platform-independent. Clients are representations of Gaia, not instances of Gaia.**

---

# Provider Independence

Reasoning providers are interchangeable.

Memory providers are interchangeable.

Action providers are interchangeable.

Gaia depends on capabilities.

Never on specific products.

---

# Deployment Topology: Gaia Cloud vs. Gaia Desktop

Gaia herself — the agency, Logos, her capabilities, and Hindsight — **runs in Gaia Cloud**. This is not a future migration target; it is how Gaia is architected from V1. There is exactly one Gaia, and she lives in the cloud.

**Gaia Desktop is a client.** It is the local presence and interface through which a person reaches Gaia — conversation surface, voice, local UI state, permissions, notifications. It talks to Gaia Cloud over a secure Gaia API. It does not host Logos, does not decide, does not hold canonical memory, and does not orchestrate capabilities. See §3 and §9.

This split is what makes multi-client support structural rather than aspirational: a future mobile or web client needs to be a good presence/interface for Gaia — it does not need to re-implement Logos, intentIQ/reasonIQ, Hindsight, orchestration, identity, or the capability ecosystem, because none of that exists per-client. Talking to Gaia from a phone five minutes after talking to her on desktop is talking to the *same* Gaia — same state, same memory, same identity — not to a separate "Gaia Mobile."

**Local observation/capture capabilities** (e.g. a future capability that observes local activity on a device) are explicitly **out of scope for this version of the architecture** and are not shown in the diagrams below. When such a capability is introduced, it is a local *capture* layer that reports observations to Gaia Cloud for Gaia to interpret — never a second, client-side intelligence that pre-interprets meaning on Gaia's behalf. That design question is deferred; nothing in this document should be read as deciding it.

---

## 1. Guiding Architectural Principles

1. **Gaia lives in the cloud; the desktop is her first client.** Gaia Cloud hosts Gaia's agency, Logos, capabilities, and Hindsight. Gaia Desktop is designed first among clients — depth and presence originate there — but it is a representation of Gaia, not where she runs.

2. **Gaia is the agency.** Gaia is not a shell around Hermes or any other capability. Gaia is the entity that acts, decides, and maintains continuity. Capabilities are instruments she may employ.

3. **Logos is Gaia's cognitive layer.** Logos — consisting of intentIQ and reasonIQ — is where Gaia interprets input and constructs meaning. Logos is not Gaia herself; it is her reasoning faculty.

4. **Capabilities are optional.** Hermes, Melodiq, SongCompanion, and other capabilities are instruments Gaia may reach for. No capability is necessary for Gaia's own cognition. A capability is selected when it serves Gaia's goals — never assumed to be the answer to every turn.

5. **Feedback is first-class.** Feedback is not a side channel or afterthought. It flows into Logos as a first-class input, where it is interpreted and integrated into Gaia's ongoing understanding.

6. **Storage is abstract.** Hindsight's persistence technology is an implementation detail. Gaia depends on Hindsight *capabilities and contracts*, never on its storage internals.

7. **Hindsight persists; Logos reasons (§6.2).** Hindsight is persistent memory and accumulated knowledge, not a second brain. Forming a hypothesis or pattern, judging evidence, testing, confirming, rejecting, refining, and revising confidence all happen in Logos. Hindsight never does any of this — not in its own service, and not in any Hindsight-adjacent storage built to hold this content.

8. **Absolute model agnosticism.** Capabilities may use one or many providers. Gaia's identity, tone, and continuity must never change when a provider changes.

9. **Separation of concerns is identity.** SOUL, Logos (intentIQ + reasonIQ), Hindsight, capabilities, and Gaia Desktop each own exactly one responsibility. No layer absorbs another's role, ever.

10. **Growth without boundary collapse.** Understanding deepens through defined interfaces (memory policies, reflection, knowledge contracts) — not by letting layers bleed into one another.

---

## 2. System Overview

```

                        ┌───────────────────────────────────┐
                        │           GAIA DESKTOP              │
                        │     (client — presence, not brain)  │
                        │                                     │
                        │   Conversation-first UX             │
                        │   Presence, continuity, calm        │
                        └──────────────┬──────────────────────┘
                                       │  every user turn, via
                                       │  the secure Gaia API
                                       ▼
    ┌──────────────────────────────────────────────────────────────┐
    │                          GAIA CLOUD                            │
    │                                                                 │
    │                        ┌───────────────────────────────────┐  │
    │                        │              GAIA                  │  │
    │                        │   (agency + orchestrator)          │  │
    │                        │                                     │  │
    │                        │   ┌─────────────────────────────┐  │  │
    │                        │   │          LOGOS               │  │  │
    │                        │   │  (cognitive reasoning layer) │  │  │
    │                        │   │  ┌─────────┐ ┌───────────┐  │  │  │
    │                        │   │  │intentIQ │ │ reasonIQ  │  │  │  │
    │                        │   │  └─────────┘ └───────────┘  │  │  │
    │                        │   └─────────────────────────────┘  │  │
    │                        │                                     │  │
    │                        │   Goals / State                     │  │
    │                        │   Decision / Plan                   │  │
    │                        │   Orchestration                     │  │
    │                        │                                     │  │
    │                        │   ┌─────────────────────────────┐  │  │
    │                        │   │       CAPABILITIES           │  │  │
    │                        │   │   (optional instruments)     │  │  │
    │                        │   └─────────────────────────────┘  │  │
    │                        └───────────────────────────────────┘  │
    │                                       │                        │
    │                                       │  when a capability is  │
    │                                       │  needed                │
    │                                       ▼                        │
    │                        ┌───────────────────────────────────┐  │
    │                        │        CAPABILITY ROUTER           │  │
    │                        │   decides which capability to call │  │
    │                        └───┬───────────┬───────────┬───────┘  │
    │                            │           │           │           │
    │                      reasoning     memory      actions         │
    │                            ▼           ▼           ▼           │
    │                   ┌────────────┐ ┌───────────┐ ┌────────┐     │
    │                   │   HERMES   │ │ HINDSIGHT │ │  MCP   │     │
    │                   │ reasoning  │ │ long-term │ │actions │     │
    │                   │ capability │ │ memory    │ │ layer  │     │
    │                   └────────────┘ └───────────┘ └────────┘     │
    │                            ▲            ▲           ▲          │
    │                            └────────────┴───────────┘          │
    │                                       │  governed by            │
    │                                 ┌──────────┐                    │
    │                                 │   SOUL   │                    │
    │                                 │ identity │                    │
    │                                 │ constit. │                    │
    │                                 └──────────┘                    │
    │                                                                 │
    │     Providers (interchangeable, never user-facing):             │
    │          [ Provider A ]  [ Provider B ]  [ Provider C ]         │
    │          ── internal to capabilities only, never cross          │
    │             the Gaia API                                        │
    └────────────────────────────────────────────────────────────────┘
    ```

The user interacts with **Gaia Desktop**, a client. Desktop hands every turn, over the secure Gaia API, to **Gaia** running in **Gaia Cloud**. Gaia processes the turn through **Logos** (intentIQ + reasonIQ) to interpret meaning and construct understanding. Gaia then decides whether a capability is needed — Hermes for reasoning, Hindsight for memory, MCP for actions, or another capability. All capabilities are governed by identity (SOUL). Providers live entirely inside capabilities and are never exposed — and, like everything else in Gaia Cloud, never cross the Gaia API to any client.

---

## 3. Gaia Desktop — The Primary Client

Gaia Desktop is the product the user lives in day to day — but it is a **client of Gaia Cloud**, not the seat of Gaia's intelligence. Its responsibilities:

- **Own the conversational experience.** The conversation space is central, immediate, and calm.
- **Present Gaia's continuity.** Voice, tone, presence, and relationship state are rendered here consistently across sessions — continuity that originates in Gaia Cloud, not on the device.
- **Manage local session and interaction state.** Draft input, streaming render, scroll/attention state, and ephemeral UI state.
- **Mediate permissions and intent.** When an action is needed, the desktop surfaces clear intent and explicit permission before MCP is invoked.
- **Expose legible controls for understanding.** Memory provenance, editing, and steering controls (see §8) live here, reading from Hindsight in Gaia Cloud.
- **Speak to Gaia Cloud over the Gaia API.** Every turn, every permission grant, and every rendered response crosses this one boundary.

Gaia Desktop **does not**: perform reasoning, decide what to remember, hold the canonical long-term memory, host Logos, orchestrate capabilities, or contain provider-specific logic. It is a client — a rich, careful one, and the first one built — not a brain. Being "primary" describes where depth and presence are designed first (§1.1), not where Gaia runs.

---

## 4. System Responsibilities & Boundaries

### 4.1 SOUL — Identity

- **Owns:** Gaia's constitution — who she is, her values, tone, boundaries, and continuity rules.
- **Provides:** A stable identity contract that governs all of Gaia's expression, independent of any provider or capability. The Foundation Engine compiles this identity at build-time from canonical Markdown files (`soul.md`, `principles.md`, `lexicon.md`).
- **Never:** Stores episodic memory, performs reasoning, or executes actions.
- **Boundary rule:** Identity is read as a governing constraint by Logos and by capabilities; it is not something a model generates or can overwrite.

### 4.2 Logos — Cognitive Reasoning Layer

- **Owns:** Gaia's cognitive processing — interpreting input, constructing meaning, and reasoning about what follows. This includes all judgment about Hindsight's hypotheses and patterns: forming them, weighing evidence, testing, confirming, rejecting, refining, and revising confidence (§6.2).
- **Provides:** Two integrated faculties:
  - **intentIQ** — interprets what the user is trying to achieve.
  - **reasonIQ** — determines what this means, how to reason about it, and what conclusions follow.
- **Never:** Executes actions, stores memory, or becomes a capability. Logos thinks *for* Gaia; it does not act on her behalf. Never persists its own conclusions — a formed hypothesis or pattern is handed to Hindsight to hold (§6.2); Logos does not become a second place where understanding accumulates.
- **Boundary rule:** Logos is Gaia's reasoning faculty, not Gaia herself. Gaia decides what to do with Logos's insights. Evidence becomes understanding in Logos; Hindsight only ever remembers what Logos concluded.

### 4.3 Gaia — Agency + Orchestrator

- **Owns:** Decision-making, goal management, state continuity, and orchestration of capabilities. Runs in **Gaia Cloud**.
- **Provides:** The central agency that receives input from Logos, decides on goals and plans, and orchestrates capabilities when they serve those goals. Exposes the secure **Gaia API** that every client (Gaia Desktop, and future clients) speaks to.
- **Never:** Delegates identity (SOUL), memory (Hindsight), or reasoning (Logos) to capabilities — or to a client. Gaia uses capabilities; she is not constituted by them. Gaia does not run partially on a client; a client never holds a shadow copy of her state.
- **Boundary rule:** Capabilities are instruments Gaia may employ — never assumed to be the answer to every turn. Clients are representations of Gaia, never instances of her (see "Deployment Topology" above).

### 4.4 Hindsight — Long-Term Memory

- **Owns:** Reflective, pattern-based long-term memory across defined memory domains. Runs in **Gaia Cloud**, alongside Gaia — not cached or duplicated on any client. Holds four kinds of content, each with a different epistemic status — **memories**, **facts**, **patterns**, and **hypotheses** (see §6.1) — never conflated with one another.
- **Provides:** Capability contracts for storing reflections, retrieving relevant context, and enforcing memory policies; contracts for persisting patterns and hypotheses (querying them, recording status/confidence changes) that Logos calls once *it* has formed, tested, or revised one (see §6.2). These contracts may be called by Gaia directly or by other capabilities when context is needed.
- **Never:** Reasons, decides identity, or exposes storage internals. Never forms a hypothesis or a pattern, decides one is plausible, judges which evidence is relevant, or moves a hypothesis through its lifecycle — that judgment is Logos's, always (§6.2). Never presents an unresolved hypothesis to Logos as if it were a confirmed fact. Never becomes a per-client cache of "what this device remembers" — there is one Hindsight, shared by every client of the same Gaia.
- **Boundary rule:** Gaia depends on Hindsight *contracts*, not its database. Storage is fully swappable (see §7). Hindsight is not an optional capability — it is as load-bearing for Gaia's continuity as SOUL is for her identity. Hindsight remembers what Gaia has learned; it does not determine what she can conclude from it.

### 4.5 Hermes — Reasoning Capability

- **Owns:** Reasoning and model-agnostic provider routing, when Gaia decides reasoning is needed.
- **Provides:** A streaming reasoning API; orchestration across Hindsight and MCP when reasoning itself requires them; model-agnostic provider selection.
- **Never:** Decides *whether* it should be invoked — that decision belongs to Gaia. Never becomes the home of identity or memory. Hermes uses SOUL and Hindsight; it does not become them.
- **Boundary rule:** Providers are internal to Hermes and never surfaced to Gaia Desktop or the user. Hermes is one capability among several — not a special-cased default. **Hermes's own internal shape — however it decides what kind of reasoning to do, which provider answers, or how it shapes its output — is entirely Hermes's concern and outside Gaia's architectural boundary.** Gaia gives Hermes an explicit task; Hermes executes it and returns a result. Gaia's documentation never describes Hermes's internals, and no Hermes-internal concept is named as if it were part of Gaia's cognition — including one that happens to share a name with a Logos faculty (see evolution.md, "Hermes as a Standalone Capability").

### 4.6 Melodiq — Music Capability

- **Owns:** Music composition, generation, and music-related reasoning.
- **Provides:** A capability for creating, analyzing, and manipulating music — callable by Gaia when music serves her goals.
- **Never:** Decides identity, stores memory, or performs general reasoning.
- **Boundary rule:** Melodiq is an instrument Gaia may employ — not a constituent of her cognition.

### 4.7 SongCompanion — Song-Related Capability

- **Owns:** Song-related tasks — lyrics, structure, metadata, and song-specific reasoning.
- **Provides:** A capability for working with songs — callable by Gaia when song-related work serves her goals.
- **Never:** Decides identity, stores memory, or performs general reasoning.
- **Boundary rule:** SongCompanion is an instrument Gaia may employ — not a constituent of her cognition.

### 4.8 MCP — Actions

- **Owns:** Execution of external capabilities/tools under explicit permission.
- **Provides:** A capability/action contract invoked through clear intent and user consent — by Gaia directly for a turn that is purely an action, or by another capability mid-task when an action surfaces.
- **Never:** Decides autonomously what matters, or acts without explicit permission and clear intent.
- **Boundary rule:** Operational complexity is hidden from the user; actions are surfaced as intent + permission, not as tool chains.

### 4.9 Gaia Desktop — Experience (Client)

- See §3. A client of Gaia Cloud, reached over the Gaia API. Owns experience and mediation; owns no canonical reasoning, memory, identity, or orchestration logic — none of that runs on the device. It defers every decision to Gaia, in the cloud.

### 4.10 Response Engine — Expression Boundary

> **Capabilities never speak to the user. Gaia does.** Every user-visible response passes through Gaia's Response Engine, regardless of which capability — if any — produced the underlying result.

- **Owns:** The final expression boundary between a capability result (or a direct Gaia decision requiring no capability at all) and the client. This is the seam the Cognitive Loop and §5.1 name as GAIA INTEGRATION → RESPONSE ENGINE.
- **Provides:** One convergence point for a native response and a capability-produced response — the client cannot tell, and must never be able to tell, which path a given turn took. It maps capability failure into Gaia's own calm language (never a provider name, model name, HTTP status, or stack trace), and it owns the wire lifecycle of a streamed response (open, progress, delta, complete, fail) so that lifecycle exists in exactly one place, not once per capability.
- **Never:** Reasons, forms hypotheses, judges evidence, or decides which capability to use — those are Logos's and Gaia's jobs (§4.2, §4.3). Never becomes a second reasoning engine. Never contains capability-specific branching that a future capability (Melodiq, SongCompanion, MCP) would need its own special case to pass through — the boundary is capability-agnostic by construction.
- **Boundary rule:** No capability may write to the client directly. A capability returns a result (or streams plain content/error deltas) to Gaia's orchestration; Gaia hands that to the Response Engine; the Response Engine is the only thing that produces what the client actually receives. This is what makes "Hermes speaking directly to the user" a defect rather than an implementation detail — see the worked example below.
- **Implementation today:** `services/gaia-api/src/responseEngine.js`. `services/gaia-api/src/turn.js` (Gaia's orchestration for a conversational turn) calls Hermes, then hands the result — success, empty, or thrown — to `formatReply` (non-streaming) or streams through `createStreamEmitter` (streaming), never touching the HTTP response itself. The wire contract this seam produces is `{ reply }` JSON on the non-streaming path and, on the streaming path, one `data:` frame family: content frames shaped `{ choices: [{ delta }] }` exactly as before, plus two additive extension frames — `{ choices: [{ delta: {} }], type: 'step', step: { id, index, total, type, status } }` (plan progress: which step of a multi-step plan is running, position and step type only) and `{ choices: [{ delta: {} }], type: 'error', error }` (the calm failure, needed once progress has already opened the stream). Both extension frames carry an EMPTY delta beside their type, so a client written against the original shape appends nothing and keeps working — that is the cross-repo wire-format decision docs/split-plan.md and the previous revision of this line reserved, now made explicitly and implemented on both sides: Gaia Desktop relays `step` frames (`src-tauri/src/communication/http.rs`) and renders them as "Step 2 of 3 - searching..." (`desktop/src/state/stepProgress.js`). Progress is still not content: no extension frame can be mistaken for something Gaia said, none of them names the capability behind a step (the client learns that Gaia searched, never what she searched with), and a failure still reaches the client only as `toCalmError()`'s wording.
- **What this does not yet cover:** The expression boundary itself now serves several real capabilities — `hermes`, `web` (when configured), `conversation_search`, `hindsight`, `foundation` (when `FOUNDATION_MEMORY_URL` is set), the native generator, and any injected `tools` — composed by the Decision Engine into either a single-action decision or a bounded multi-step plan (`decision/decisionEngine.js` → `buildPlan`, capped by `MAX_PLAN_STEPS`) and executed by `orchestration/orchestrator.js`'s `executePlan`. That loop is SEQUENTIAL and bound to the plan as written: no replanning, no step insertion, no parallelism — a required step's failure stops the plan with a structured failure, an optional step's failure is recorded and execution continues without its result, and neither outcome may quietly reroute the turn (that choice belongs to Gaia's decision, not to execution). What genuinely remains unbuilt is the *adaptive* form of the loop: the plan is composed once, before execution, so nothing re-decides mid-run whether another call is needed — and intentIQ/reasonIQ still select and invoke nothing (§4.2; `logos/reasonIQ.js`'s own header), so routing stays the Decision Engine's up-front judgment rather than a dynamic capability router dispatching during a turn. Still true as well: Hindsight recall/reflection is consulted directly by Gaia's orchestration (`memory.js`), not routed through a plan step, and no capability — under any name — may format its own failure or write to the client (boundary rule above). The reason all of the above could be wired in without touching this seam is the one property this section was protecting: the Response Engine's contract (`delta`/`step`/`finish`/`fail`, `formatReply`, `deliverReply`) stayed capability-agnostic, so every capability arrived through it unchanged.

**Worked example — the violation this corrects.** Before this correction, `performStreamingTurn` in `turn.js` wrote SSE frames onto the HTTP response from inside the callback Hermes invokes per token, and separately duplicated the same calm-error text in `performTurn`'s catch block. Functionally, Hermes's output *was* the response, formatted ad hoc, in two different places, with no named boundary between "what a capability returned" and "what the user receives." That is `Gaia → Hermes → streamed text → User` — the exact pattern this document's earlier draft (see evolution.md) flagged as wrong. The fix moved that formatting/emission logic into `responseEngine.js`, called uniformly from both of `turn.js`'s paths, with no change to the bytes a client already receives.

---

## 5. Data & Interaction Flow

### 5.1 Everyday conversational turn

```

1. User types/speaks in Gaia Desktop.
2. Desktop sends the turn + session context + granted permissions to Gaia, over the
secure Gaia API, into Gaia Cloud.
3. Gaia processes the turn through Logos:
a. intentIQ interprets what the user is trying to achieve.
b. reasonIQ does NOT run on this path. It is background cognition: it
analyzes the COMPLETED turn after the reply has been delivered, and what it
produces reaches future turns only through context recall — it never
reroutes the turn it analyzed (the Decision Engine receives reasoning: null
for every turn — see turn.js's runTurnCore and the ReasonIQ note in
decision/decisionEngine.js).
4. Gaia decides on goals and plans based on Logos's interpretation.
5. Gaia decides whether a capability is needed:
    - needs reasoning                 → Hermes
    - is a direct memory question      → Hindsight, directly
    - is a direct action                → MCP, directly (with permission)
    - needs music                       → Melodiq
    - needs song work                   → SongCompanion
    - no capability needed              → Gaia responds directly
6. If a capability is invoked:
a. The capability retrieves relevant context as needed:
- reflective/personal context  → Hindsight (via memory contracts)
b. The capability executes using an internal provider (choice invisible to Gaia/user).
c. If an external action is required mid-task:
- Capability signals intent → Desktop surfaces permission → user consents
- MCP executes the action → result returns to capability
d. Capability streams result back to Gaia.
7. Gaia integrates the capability's result (if any). Whether a capability was used or
Gaia is responding natively, the result now passes through Gaia's Response Engine
(§4.10) — the single boundary that formulates the final response, maps any failure
into Gaia's own calm language, and owns the streamed wire lifecycle (content deltas,
plan `step` progress frames, the calm `error` frame). No capability
writes to the client directly.
8. Desktop renders the response as Gaia's continuous voice, regardless of which
capability (if any) was involved (see principles.md — Invisible Implementation).
9. Asynchronously, significant patterns are reflected into Hindsight via memory policies
(NOT raw logging — see §6).
10. Feedback (from user or environment) flows back into Logos as a first-class input
for the next turn.
```

### 5.2 Direction of dependency

- Gaia Desktop (client, local) → depends on → Gaia (only), across the Gaia API, into Gaia Cloud.
- Gaia → depends on → SOUL (governing identity), Logos (reasoning), and routes to capabilities (Hindsight, Hermes, Melodiq, SongCompanion, MCP) via contracts. All of this lives in Gaia Cloud.
- Logos → depends on → SOUL (governing identity).
- Capabilities → depend on → SOUL, Hindsight (when context is needed), and other capabilities (when their task requires them).
- No adjacent leaf system depends on another leaf system directly; Gaia orchestrates, and capabilities orchestrate only what their own task needs.
- Providers are a private dependency of individual capabilities.
- **No dependency crosses the Gaia API except the client → Gaia turn/response traffic itself.** A client never depends on Logos, Hindsight, or a capability directly — only Gaia does, and only Gaia is reachable from outside Gaia Cloud.

---

## 6. Memory Formation — Growth Without Boundary Collapse

Growth in understanding is the product thesis, and it is realized here **without** merging systems.

- **Reflection, not logging.** Hindsight does not store the raw transcript as memory. It stores *reflections* and *patterns*, selected by memory policies according to significance.
- **Memory policies are explicit contracts.** What is eligible to be remembered, at what fidelity, with what retention, and with what user visibility is governed by declared policies — not by ad-hoc model behavior.
- **Patterns over facts.** Gaia's understanding of recurring patterns (how the user decides, communicates, works) is what Hindsight is *for* — but Logos is what *forms* a pattern (see §6.2); Hindsight persists it and makes it retrievable. Isolated facts belong in Chronicles (if/when that capability exists).
- **Provenance is preserved.** Every reflection retains where it came from, so the user can inspect, correct, or remove it (see §8).

Because reflection happens through Hindsight's contract and identity is governed by SOUL, understanding can deepen indefinitely while every boundary stays intact. Growth is a function of richer memory contracts — never of one layer swallowing another.

### 6.1 Hypotheses — Holding Understanding Before It's Earned

Not everything Hindsight notices deserves the confidence of a stored fact or a formed pattern. A **hypothesis** is Hindsight's explicit way of holding a *not-yet-earned* belief — something Gaia has started to notice but has not yet confirmed — without either discarding it or prematurely promoting it to something she treats as settled.

- **A hypothesis is a distinct epistemic status inside Hindsight**, alongside memories, facts, and patterns — not a new layer, not a reasoning engine, and not something Logos owns as content. Hindsight is where a hypothesis *lives*; see §6.2 for what Logos does with it.
- **Structure:** a hypothesis carries a `statement` (what Gaia thinks might be true), `confidence` (how sure she is, and only ever a degree — never treated as settled), `evidence` (the observations or reflections it's grounded in, each with provenance per §8), an optional `verification_plan` (what would raise or lower confidence), and a `status`.
- **Lifecycle:** `proposed → testing → confirmed | rejected`. A **confirmed** hypothesis may be promoted into a fact or pattern through the normal memory-policy path (§6); a **rejected** one is retained with its outcome, not silently deleted — the history of what turned out *not* to be true is itself part of honest understanding. `testing` means evidence is actively being sought that would move the needle in either direction.
- **Logos reasons over confidence, not just content.** When Logos draws on Hindsight, it receives each item's epistemic status alongside its content — a confirmed fact, a recognized pattern, and a hypothesis at `confidence: 0.72` are never presented to Logos as equivalent. This is what lets Gaia say, in effect, "I think this, based on what I've seen" rather than stating an unconfirmed guess as settled understanding — and it is enforced by SOUL (see soul.md — "She never pretends certainty").
- **Why this belongs in Hindsight, not Logos:** a hypothesis is a *kind of memory content* — something Gaia holds and revisits over time, with provenance and a lifecycle — not a *reasoning operation*. Hindsight is where it lives, persists, and accumulates evidence between turns; Logos is what forms it, tests it, and moves it through its lifecycle (§6.2). Keeping the boundary here means a hypothesis survives exactly like any other memory — inspectable, editable, forgettable (§8) — rather than existing only inside a single reasoning pass.
- **Rationale.** Treating every noticed pattern as either "not remembered" or "a permanent fact" forces a false binary onto genuinely uncertain understanding. Hypotheses let uncertainty persist honestly, be tested across future turns, and either earn its way into confirmed understanding or be honestly set aside — never let it collapse into unwarranted false confidence.

### 6.2 Division of Labor: Hindsight Persists, Logos Reasons

> **Hindsight is persistent memory and accumulated knowledge, not a second brain. Logos is where evidence becomes understanding.**

This is easy to blur once hypotheses and patterns both "live in Hindsight" (§6.1, §6) — it becomes tempting to read that as Hindsight *doing* something with them. It doesn't. Hindsight's role is unchanged from the rest of this document: store, persist, retrieve. Every act of judgment about a hypothesis or pattern — forming it, deciding it's plausible, weighing which evidence matters, testing it, revising its confidence, confirming, rejecting, or refining it — is Logos's, never Hindsight's.

| | **Hindsight** | **Logos** |
|---|---|---|
| Memories, facts | Stores them | Reads them |
| Hypotheses | Persists statement, confidence, evidence, status, lifecycle | Forms them; reasons about plausibility; decides which evidence is relevant; tests/verifies; confirms, rejects, or refines |
| Patterns | Persists content, confidence, source references | Forms them from recurring observations; decides they *are* a pattern, and what it means |
| Confidence | Stores the current value | Revises it, based on new evidence |

```

Observation
    ↓
HINDSIGHT   stores evidence
    ↓
LOGOS       notices a possible pattern, forms a hypothesis
    ↓
HINDSIGHT   persists the hypothesis (proposed)
    ↓
(next turn — new observation / user feedback)
    ↓
HINDSIGHT   stores the new evidence, surfaces it as relevant context
    ↓
LOGOS       evaluates the hypothesis against it
    ↓
LOGOS       confirms / rejects / refines
    ↓
HINDSIGHT   persists the new status

```

- **Boundary rule:** any code that forms a hypothesis, judges evidence relevance, tests a hypothesis, or synthesizes a pattern belongs in Logos (or a capability Logos directs) — never in Hindsight's own service, and never in a Hindsight-adjacent storage sidecar built to hold this content (see §7). A storage layer that starts making these judgments has quietly become a second reasoning engine, which is exactly the boundary collapse §14 exists to prevent.
- **What Hindsight is still allowed to do:** apply memory policies (§6) — significance filtering, retention, provenance — because those are storage-shaping decisions, not judgments about whether a hypothesis is *true*. The line is "what do I keep and how do I retrieve it" (Hindsight) versus "what do I conclude" (Logos).

---

## 7. Storage Abstraction for Hindsight

Storage is deliberately **not** specified at the foundation level.

- Gaia and capabilities address Hindsight through **capability contracts**: `store_reflection`, `retrieve_relevant_context`, `form_pattern`, `query_patterns`, `apply_memory_policy`, `list_provenance`, `edit_memory`, `forget`; and, for hypotheses (§6.1), `propose_hypothesis`, `update_hypothesis` (evidence, confidence, status), `resolve_hypothesis` (confirm → promote to fact/pattern, or reject → retain with outcome), `query_hypotheses`.
- The architecture specifies **memory domains, policies, and interfaces** — never a database choice.
- Any persistence technology (document store, vector store, graph, hybrid, or future technology) may back Hindsight, and may change over time, with **zero** impact on Gaia's identity or contracts.
- **Rule:** No component outside Hindsight may reference storage internals, schemas, or query dialects. Violating this couples Gaia to a persistence choice and breaks the abstraction.

---

## 8. Memory Provenance & User Control (Stance)

> **Open question resolved:** *How visible should memory provenance and editing controls be?*
> **Stance: Provenance is always available on demand, never in the user's face.**

- Every stored reflection carries provenance (source turn/date/context) retrievable through Hindsight's `list_provenance` contract.
- Gaia Desktop exposes a **calm, opt-in memory view**: the user can, at any time, see what Gaia has come to understand, inspect why, edit it, or forget it.
- **Hypotheses are visible as hypotheses, not as facts.** The memory view surfaces a hypothesis's `confidence`, `status`, and supporting evidence plainly — the user can see what Gaia merely suspects, correct it, accelerate or reject it, exactly as they can with a confirmed memory. A hypothesis is never displayed indistinguishably from settled understanding.
- This view is **not** part of the everyday conversational surface — it does not clutter the primary experience. It is discoverable and trustworthy, not omnipresent.
- **Rationale:** Legibility builds trust; omnipresence creates the surveillance feeling Gaia must avoid. Control on demand, invisibility by default. Uncertainty stays visible, too — hiding a hypothesis's tentativeness would be a subtler version of the same overreach.

---

## 9. Gaia Cloud Is the Runtime, Not a Speculative Backend (Stance)

> **Open question resolved (revised):** *At what point would synchronization or policy concerns justify a separate backend beyond a desktop client?*
> **Stance: Gaia Cloud is the proven need, not a speculative one. Gaia's agency, Logos, capabilities, and Hindsight run there from V1. What remains speculative — and stays deferred until proven — is any *additional* infrastructure beyond that single Gaia Cloud runtime.**

Earlier drafts of this document defaulted to "Gaia is a desktop client; avoid backends until proven necessary." That framing no longer holds, because the proof arrived immediately: Gaia's continuity, identity, and memory are only "sacred" (per vision.md) if they persist independent of any single device — and a purely client-side Gaia cannot do that. The moment a second client (mobile, web) is a real possibility, per-client orchestration would mean re-deriving Gaia's state per device, which is the boundary collapse this architecture exists to prevent. Gaia Cloud is therefore foundational, not a milestone to earn.

**What this does *not* license:** treating every future infrastructure idea as similarly self-justifying. Beyond the single Gaia Cloud runtime described in §2, additional backend infrastructure is justified **only** when a concern genuinely cannot be owned by that runtime:

1. **Regional/latency isolation** — serving Gaia Cloud from multiple regions where a single deployment cannot meet latency needs.
2. **Offline reconciliation** — merging divergent local changes made by a client while disconnected (see §11).
3. **Security isolation** — isolating secrets, keys, or sensitive policy enforcement into a dedicated boundary away from the reasoning path.
4. **Dedicated policy enforcement** outside the capability layer — where policy must be authoritative independent of capabilities.
5. **Independent scaling of a specific capability** — e.g. Hermes needing to scale separately from Melodiq under real load.

Until one of these is *proven* (not anticipated), Gaia Cloud remains a single coherent runtime as described in §2. **Speculative infrastructure beyond that baseline is prohibited.**

**Gaia's orchestration is Gaia Cloud's job, not a client's.** It is not "client-side" in any deployment — it runs in Gaia Cloud, reachable only through the Gaia API. A client (Gaia Desktop or otherwise) never hosts orchestration, even partially, even as a cache. This is the boundary that makes multi-client support (§13) structural rather than aspirational.

---

## 10. Streaming Conversation Lifecycle

```

OPEN     Desktop hands the turn to Gaia, over the Gaia API, into Gaia Cloud.
LOGOS    Gaia processes through Logos (intentIQ + reasonIQ).
DECIDE   Gaia decides on goals and plans.
ROUTE    Gaia decides whether a capability is needed. If not, Gaia responds directly.
CONTEXT  (capability path) Capability retrieves relevant context (e.g. Hindsight).
EXECUTE  (capability path) Capability executes via an internal provider; begins emitting tokens.
EXPRESS  Every delta — and, on the native path, the direct response — passes through Gaia's
         Response Engine (§4.10) before reaching Desktop. This is the one place the wire
         frame is produced; a capability never writes to Desktop's connection itself.
STREAM   Gaia's Response Engine streams to Desktop; Gaia's presence indicates listening/thinking/speaking.
ACT?     If an action is needed → intent surfaced → permission → MCP → result folded in,
         then re-enters EXPRESS the same way any other capability result does.
COMPLETE Response is finalized by the Response Engine; Desktop renders the turn.
REFLECT  Asynchronously, memory policies may reflect significant patterns into Hindsight.
FEEDBACK Feedback flows into Logos as a first-class input for the next turn.
CLOSE    Connection closes; session continuity is preserved for the next turn.

```

- **Interruptibility:** The user may interrupt a stream; Gaia stops gracefully. Silence and stopping are first-class.
- **Backpressure & failure:** If a provider fails mid-stream, the capability may re-route to another provider — invisibly, preserving Gaia's continuity.

---

## 11. Offline-First Behavior (Stance)

> **Open question resolved:** *Offline-first in early versions, or network-dependent initially?*
> **Stance: Network-dependent initially, with an offline-graceful desktop shell; true offline-first is deferred to a later version.**

- **V1:** Since Gaia herself runs in Gaia Cloud, every client requires connectivity to reach her — there is no local fallback intelligence. The desktop shell degrades gracefully offline — it remains open, calm, and readable, clearly indicating that Gaia is momentarily unreachable rather than breaking.
- **Later:** True offline-first (local buffering of a client's pending input + reconciliation on reconnect) is a candidate that would justify the offline-reconciliation infrastructure named in §9, item 2. It is intentionally out of scope early to keep V1 small and boundaries clean.
- **Rationale:** Offline-first prematurely forces sync/reconciliation complexity beyond the baseline Gaia Cloud runtime. We add it when the need is real, per §9.

---

## 12. Model-Agnostic Capability Design

- **Single surface:** Gaia Desktop knows only Gaia — reached over the Gaia API, in Gaia Cloud. It has no concept of "a model," and no concept of any capability as special — capabilities are simply instruments Gaia may reach for when they serve her goals.
- **Internal routing:** Capabilities select among one or more providers using their own routing logic (capability, cost, latency, availability). This is invisible upstream — invisible to Gaia and to the user alike.
- **Continuity contract:** Provider changes must not alter Gaia's identity, tone, or continuity. SOUL governs voice; Hindsight governs memory. Neither lives in the provider.
- **No provider leakage:** Provider names, model versions, tool chains, and provider-specific UX concepts must never appear in Gaia Desktop or in Gaia's language.
- **Failover:** A capability may transparently fail over between providers mid-task without the user perceiving a change in who they are talking to.

---

## 13. Extensibility to Future Interfaces Without Redesign

- **Gaia is the shared contract.** Web, mobile, voice, wearable, and ambient surfaces are additional **clients** of the same Gaia Cloud — not of individual capabilities directly, and not separate instances of Gaia.
- **Clients are representations of Gaia, not instances of Gaia.** Because Gaia, Logos, SOUL, Hindsight, and her capabilities all live in Gaia Cloud, a new client needs to be a good presence and interface — nothing more. It does not re-implement reasoning, memory, identity, or orchestration; there is nothing client-specific to re-derive.
- **Identity and memory are surface-independent.** Because SOUL, Logos, Hindsight, and Gaia's orchestration all live in Gaia Cloud behind every client, each surface inherits the same Gaia — same voice, same understanding, same state — mid-conversation, across devices, without handoff logic.
- **No architectural inversion.** New clients extend Gaia; they never pull identity, memory, orchestration, or reasoning down into themselves. The desktop client's depth defines the character; other clients adapt presentation only.
- **Rule:** If a new client would require moving identity, memory, orchestration, or canonical reasoning out of Gaia Cloud and into that client, the design is wrong.

---

## 14. Separation of Concerns & Policy Boundaries (Enforcement)

To prevent silent boundary collapse over time:

- **One responsibility per layer.** Any PR that gives a layer a second responsibility is rejected.
- **Contracts, not internals.** Layers integrate only through declared contracts. Reaching into another layer's internals is prohibited.
- **Memory vs. knowledge line.** Reflective/personal → Hindsight. Factual/structured → Chronicles (if/when that capability exists). Never store one in the other.
- **Identity is read-only to reasoning.** Logos and capabilities read SOUL; they cannot mutate identity.
- **Actions require intent + permission.** MCP never acts on inference alone.
- **Providers are private.** No provider concept escapes its capability.
- **No capability is the default.** Gaia must not hard-code any capability as the default path. Every turn is decided on its own merits; capabilities are reached for, not fallen back to.
- **Feedback is first-class.** Feedback is not a side channel. It flows into Logos as a primary input for ongoing understanding.
- **No client hosts Gaia.** Identity, cognition, memory, and orchestration run in Gaia Cloud only. A client (Gaia Desktop or any future one) that gains a local copy of any of these — even as a cache or a fallback — is a boundary violation, not an optimization.
- **A hypothesis is never presented as a fact.** Confidence and status travel with hypothesis content everywhere it goes — into Logos, into responses, into the memory view. Silently rounding an unconfirmed hypothesis up to stated certainty is a violation of both this rule and SOUL's "never pretends certainty."
- **Hindsight persists; Logos reasons (§6.2).** Forming a hypothesis, judging evidence relevance, testing, confirming, rejecting, refining, or revising confidence is Logos's job — never Hindsight's own service, and never a Hindsight-adjacent storage sidecar built to hold this content. A storage layer that starts making these judgments has become an unnamed second reasoning engine.
- **Capabilities never speak to the user; every response passes through the Response Engine (§4.10).** No capability writes to the client connection, formats the final reply, or decides how its own failure is phrased to the user — that is the Response Engine's job, and its only job. A capability that streams its result straight onto the HTTP response, or an orchestration path that special-cases how one capability's output reaches the client versus another's, is the same boundary collapse this section exists to prevent, applied to expression instead of memory.

These rules are the architectural expression of Gaia's promise: she can grow through understanding indefinitely because the systems that make her *her* never dissolve into one another.

---

## 15. Key Distinctions from Previous Architecture

This version (2.3.0) adds to version 2.2.0, which added to 2.1.0, which refined 2.0.0; 2.0.0 introduced fundamental shifts from version 1.0.0:

| Concept | v1.0.0 | v2.0.0 | v2.1.0 | v2.2.0 | v2.3.0 |
|---------|--------|--------|--------|--------|--------|
| **Central entity** | Intent Engine as routing layer | Gaia as agency + orchestrator | *(unchanged)* | *(unchanged)* | *(unchanged)* |
| **Reasoning layer** | Hermes as reasoning capability | Logos (intentIQ + reasonIQ) as Gaia's cognitive layer | *(unchanged)* | *(unchanged)* | *(unchanged)* |
| **Hermes** | Central reasoning capability | One capability among many (optional instrument) | *(unchanged)* | *(unchanged)* | *(unchanged)* |
| **New capabilities** | Not explicitly named | Melodiq, SongCompanion explicitly named as optional instruments | *(unchanged)* | *(unchanged)* | *(unchanged)* |
| **Feedback** | Implicit in memory policies | First-class input in Gaia's cognitive loop | *(unchanged)* | *(unchanged)* | *(unchanged)* |
| **Where Gaia runs** | Implied client-side ("Gaia remains a desktop client") | Implied client-side | **Explicit: Gaia Cloud.** Gaia, Logos, Hindsight, and capabilities are named as cloud-hosted; Gaia Desktop is explicitly a client | *(unchanged)* | *(unchanged)* |
| **Backend stance (§9)** | "No speculative backends"; client-side by default | Same stance carried forward | **Reversed:** Gaia Cloud is the proven baseline, not speculative; the "no speculative infrastructure" stance now applies only to infrastructure *beyond* that baseline | *(unchanged)* | *(unchanged)* |
| **Multi-client story** | Not addressed | Not addressed | Structural: clients are representations of Gaia, never instances of her (§13, Deployment Topology) | *(unchanged)* | *(unchanged)* |
| **Hindsight's memory model** | Reflections and patterns only | Same, restated under Gaia Cloud | Same | **Adds hypotheses (§6.1):** memories, facts, patterns, and hypotheses as distinct epistemic statuses; hypotheses carry confidence, evidence, a `verification_plan`, and a `proposed → testing → confirmed/rejected` lifecycle | *(unchanged)* |
| **Logos and uncertainty** | Not addressed | Not addressed | Not addressed | Logos reasons over confidence, not just content — a hypothesis is never handed to Logos, or surfaced to the user, indistinguishably from a confirmed fact | *(unchanged)* |
| **Who forms/tests hypotheses & patterns (§6.2)** | Not addressed | Not addressed | Not addressed | Implicit — §6.1 said Logos "performs the reasoning," in passing | **Explicit division of labor:** Hindsight only ever persists and retrieves; forming, judging evidence, testing, confirming, rejecting, refining, and revising confidence are named as Logos's alone — including inside any Hindsight-adjacent storage sidecar (§7) |

The core insight, extended: **Gaia is the agency. Logos is Gaia's cognitive reasoning layer. Capabilities are instruments Gaia may employ. Gaia herself lives in Gaia Cloud — every client, starting with Gaia Desktop, is a representation of her, not an instance of her. What Gaia remembers is not all held with the same confidence — Hindsight lets her think "I suspect this" as honestly as she can say "I know this." And Hindsight is persistent memory and accumulated knowledge, not a second brain: evidence becomes understanding in Logos, never in storage.**

---

## 16. Next Steps

This architecture.md is now the foundation. The following documents should be reviewed and updated in this order:

1. **orchestrator.md** — **Superseded and removed.** An earlier revision of this document decided to keep a Hermes-internal "IntentIQ"/"OrchestratorIQ" pipeline documented, disambiguated from Logos's `intentIQ` by a naming note. That decision is reversed: documenting Hermes's internal reasoning shape in Gaia's own docs — under any name, with any disclaimer — misrepresents Hermes's internals as part of Gaia's architecture and keeps the `intentIQ` naming collision alive. orchestrator.md has been deleted; §4.5's boundary rule now states plainly that Hermes's internal shape is outside Gaia's architectural boundary, full stop. See evolution.md, "Hermes as a Standalone Capability."
2. **README.md, vision.md, coding-standards.md, roadmap.md, soul.md** — update any remaining "desktop client owns orchestration" or "no speculative backend" language to match §9's revised stance; add hypotheses to any description of what Hindsight holds.
3. **hermes/soul.md and Hermes documentation** — update to reflect Hermes as one cloud-hosted capability among many.
4. **intentIQ / reasonIQ docs** — if they exist separately, align with Logos framing, with how Logos consumes hypothesis confidence (§6.1), and with Logos owning all hypothesis/pattern judgment (§6.2).
5. **capability documentation** (Melodiq, SongCompanion, etc.) — ensure each is framed as an optional, cloud-hosted instrument.
6. **Local observation/capture capability** (deferred, see "Deployment Topology" above) — design separately when it is prioritized; do not retrofit it into this version's diagrams.
7. **services/cognition** (the hypothesis/pattern storage sidecar) — already built storage-only, matching §6.2; no code change implied by this revision, only that this document now says explicitly what that service's own README already said implicitly.
8. **services/gaia-api/src/responseEngine.js** (§4.10) — already built, matching this revision: the expression boundary between a capability result and the client, extracted out of `turn.js`'s orchestration code. It has since grown past this revision in two ways that both stayed inside that same boundary: the wire format gained two additive frame types (`step` plan progress and `error` calm failure — the cross-repo decision this document reserved, since made and implemented on both sides), and the multi-capability execution loop this line once recorded as deliberately unbuilt now exists as `orchestrator.js`'s `executePlan`, driven by Decision Engine 3.0's plans. See evolution.md for the violation the original extraction corrected, and memory/PRD.md's 2026-09-25 entries for both additions.

Each document should be held against this new architecture.md as the single source of truth.
