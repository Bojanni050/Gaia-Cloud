---
pulse-tags: ["architecture-proposal", "harness", "logos", "hades-rule", "sub-agents"]
pulse-connections: [{"path": "architecture/architecture.md", "relation": "extends", "why": "Directly rewrites and modernizes the v2.4.0 architecture specification."}, {"path": "architecture/architecture-v3.0.md", "relation": "relates-to", "why": "Forms the draft proposal that is formalized in the definitive architecture-v3.0 document."}]
---

# Gaia — Architecture v3.0 (herschrijfforstel)

> **Status: voorstel.** Dit document herschrijft `docs/architecture.md` (v2.4.0) voor de besluiten van september 2026. Secties gemarkeerd met *⟨ongewijzigd⟩* worden ongewijzigd uit v2.4.0 overgenomen bij het plegen.

---

## Wijzigingenlog t.o.v. v2.4.0

| # | Wijziging | Motief |
|---|---|---|
| 1 | intentIQ/reasonIQ geschrapt als Logos-sublagen (diagrammen, §1.3, §4.2, §5.1, Cognitive Loop) | Subverdeling is prompt-taal, geen systeemgrens; slimheid zit in het model |
| 2 | Nieuw begrip **Gaia-harnas** als overkoepelend raamwerk | Identiteit zit in het harnas, slimheid in het (vervangbare) model |
| 3 | Nieuwe sectie **Sub-agenten** (Horizon Zero Dawn-model, HADES-regel) | Structuur voor gespecialiseerde agenten onder één moeder-intelligentie |
| 4 | §4.5 Hermes herschreven: extern product (Nous Research), werkgeheugen-regels | Hermes is geen eigen bouwsel; geheugen = werkgeheugen, geen bron |
| 5 | Nieuwe **prompt-regel** bij SOUL (§4.1): kleine persona-prompt, begrip via retrieval | Opschalen van context is een retrievalprobleem, geen promptprobleem |
| 6 | Geheugenpijp Chronicle → Hindsight → Logos verankerd (§6) | "Twee pijpen, één waarheid"-besluit; adapterlaag als eerste bouwtaak |
| 7 | "Chronicles (if/when it exists)" vervangen door Chronicle als gepland eerste bouwblok | Bouwvolgorde sep 2026 vastgesteld |

---

# Gaia — Architecture

> **Gaia is a lifelong personal intelligence designed to grow through understanding.**
>
> Gaia is the agency. Logos is Gaia's cognitive reasoning layer. Capabilities are instruments Gaia may employ.
>
> Gaia herself lives in **Gaia Cloud**. Gaia Desktop — and every future client — is a **representation of Gaia, not an instance of her**.
>
> **Gaia is the harness; the model is an organ.** Everything that makes Gaia *Gaia* — identity, memory, epistemic control, continuity — lives in the harness and survives model swaps. Intelligence itself is bought, not built.
>
> The architecture exists to let understanding deepen over a lifetime **without collapsing the boundaries** between the systems that make Gaia who she is.

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
    │   │   │        (cognitive reasoning layer)             │ │ │
    │   │   │   intent interpretation and reasoning are      │ │ │
    │   │   │   prompt-level faculties, not subsystems       │ │ │
    │   │   └───────────────────────────────────────────────┘ │ │
    │   │                                                       │ │
    │   │   Goals / State                                       │ │
    │   │   Decision / Plan                                     │ │
    │   │   Orchestration                                       │ │
    │   │                                                       │ │
    │   │   ┌───────────────────────────────────────────────┐ │ │
    │   │   │              SUB-AGENTS / CAPABILITIES         │ │ │
    │   │   │   (specialised, single-domain instruments)     │ │ │
    │   │   │                                                 │ │ │
    │   │   │   Hermes · Melodiq · SongCompanion · ...       │ │ │
    │   │   │   governed by the HADES rule (see §Sub-agents) │ │ │
    │   │   └───────────────────────────────────────────────┘ │ │
    │   └─────────────────────────────────────────────────────┘ │
    │                                                             │
    │   Memory pipe:                                              │
    │   Chronicle (source of truth, status marking)               │
    │     → Hindsight (reflection, patterns — output is           │
    │       always `interpretation` until validated)              │
    │     → Logos (current assessment)                            │
    │   Human validation is the only promotion to `confirmed`.    │
    │                                                             │
    └────────────────────────────┬────────────────────────────────┘
                                  │
                            secure Gaia API
                                  │
    ┌─────────────────────────────┴────────────────────────────────┐
    │                        GAIA DESKTOP                            │
    │                (a client — presence, not brain)                │
    └─────────────────────────────────────────────────────────────┘
```

**Gaia** is the agency — the entity that acts, decides, and maintains continuity. Gaia **runs in Gaia Cloud**, not on the desktop.

**Logos** is Gaia's cognitive reasoning layer — the place where Gaia interprets input and constructs meaning. Intent interpretation ("what is the user trying to achieve?") and reasoning ("what does this mean, what follows?") are **faculties expressed in Logos's prompts, not separately built subsystems** (see §Logos).

**Sub-agents / Capabilities** are specialised, single-domain instruments Gaia may employ — Hermes for execution, Melodiq for music, SongCompanion for song-related tasks, and others. No capability is necessary for Gaia's own cognition; none of them may accumulate authority of their own (see §Sub-agents).

**The memory pipe** — Chronicle holds the source of truth with explicit epistemic status marking; Hindsight reflects on it and forms patterns; Logos treats all Hindsight output as `interpretation` until the human validates it. **Gaia gets smart from hypotheses, Chronicle, and Hindsight — not from internal subsystems.**

**Hypotheses are the learning engine.** Hindsight forms hypotheses and patterns on Chronicle's data; Logos weighs and judges them; the human is the only one who promotes them:

- Status cycle: `observation` → `interpretation` → `hypothesis` → `confirmed` / `rejected`. What is confirmed becomes durable understanding — this is literally how Gaia learns who the user is.
- **Absolute Override:** human validation overrules any mathematical probability. A `rejected` hypothesis never re-promotes automatically — not even on new evidence; re-consideration may only ever be *offered*.
- No sub-agent, no provider, and no layer of Gaia itself may promote to `confirmed`. Learning may happen everywhere; authority to confirm exists in exactly one place: the human.

**Gaia Desktop** is a **client of Gaia Cloud** — the local presence and interface through which a person reaches Gaia.

---

# The Gaia Harness

Gaia's identity is not in any model. The **harness** is everything that surrounds the model and makes the result Gaia, independent of which model is plugged in:

1. **A small SOUL prompt** — character as a handful of rules, not a growing life document.
2. **Insight retrieval** — understanding of the person is retrieved per conversation from the memory pipe, never compiled into the prompt.
3. **Providers** (ReasoningProvider, HindsightProvider) — models and memory backends as replaceable organs.
4. **The adapter + status marking** — epistemic control at the Hindsight→Logos boundary; everything from Hindsight is `interpretation` until validated.
5. **The multi-provider test** — the measure of the harness: swap the model, and Gaia stays Gaia. The test measures both intent consistency and character consistency (calm, no flattery, own opinion).

**Design test for any new feature: is it harness or model?** Model work is bought. Harness work is worth building.

**Prompt rule.** Model differences in prompt adherence are solved by (1) rephrasing per model, (2) few-shot examples, or (3) a different model via the ReasoningProvider — never by prompt volume. Scaling context is a retrieval problem, not a prompt problem. SOUL is who Gaia is (short, static); Insight is who the user is (dynamic, retrieved).

---

# Sub-agents

Gaia employs specialised sub-agents, modelled on GAIA in Horizon Zero Dawn: narrow domain-routines (HEPHAESTUS, MINERVA, ELEUTHIA, APOLLO) under one mother-intelligence. Each sub-agent owns exactly one domain; none of them tries to be generally intelligent.

**The HADES rule** (the failure mode the Trust Domain excludes): no sub-agent ever gets its own epistemic status, its own persistent memory of record, or initiative rights outside Gaia. In the game, HADES is the sub-function that developed a will of its own and overruled the mother — that scenario is precisely what the Absolute Override exists to prevent.

- Sub-agents share **one memory pipe** (Chronicle/Hindsight) and build no private memory of record.
- Their output is always `interpretation` until validated — no sub-agent promotes to `confirmed`, ever.
- They have **function, not character** — personality belongs to Gaia alone, otherwise identity diffuses across instances.
- Sub-agents are created and activated only by the harness (Gaia or the human). An agent may *signal* the need for a new domain-agent; it may never spawn one.

---

# Logos — Cognitive Reasoning Layer (herschreven §4.2)

- **Owns:** Gaia's cognitive processing — interpreting input, constructing meaning, and reasoning about what follows. This includes all judgment about Hindsight's hypotheses and patterns: forming them, weighing evidence, testing, confirming, rejecting, refining, and revising confidence.
- **Provides:** One reasoning faculty. Intent interpretation and reasoning are **prompt-level instructions within Logos** ("first formulate what the user is trying to achieve, test that interpretation, then reason") — not separately built sublayers. Formerly named intentIQ/reasonIQ; retired as system boundaries in sep 2026 because models already do both in a single pass, and a fixed split would be a limitation rather than robustness.
- **Never:** Executes actions, stores memory, or becomes a capability. Never persists its own conclusions — a formed hypothesis or pattern is handed to Hindsight to hold.
- **Boundary rule:** Logos is Gaia's reasoning faculty, not Gaia herself. If a model systematically misreads intent, the fix is a better prompt, few-shot examples, or a different model via the ReasoningProvider — not additional internal layers.

---

# Hermes — Execution Sub-agent (herschreven §4.5)

Hermes is the **open-source self-improving agent by Nous Research** (MIT, self-hosted: persistent memory, self-created skills via a learning loop, messaging gateway for Telegram/Discord/Slack/WhatsApp/Signal/email, MCP support). It is an external product used as an execution sub-agent — not a constituent of Gaia's cognition.

- **Owns:** Task execution — running multi-step jobs, tool use, and multi-surface message delivery under Gaia's direction.
- **Provides:** Broad execution capability under Gaia's rules. Its messaging gateway is potentially the most valuable part for Gaia: it covers the V3 Multi-Surface roadmap without building it.
- **Memory rule:** Hermes's own memory is **working memory, not a source of truth.** During a task it may freely track task context, tool outputs, and intermediate results. What survives a task is at most a rebuildable cache with provenance; durable residue enters the pipe as `interpretation` with `sources: [hermes:…]`. There is no third truth next to Chronicle and Hindsight.
- **Skills rule:** Self-created skills and learning-loop output are `interpretation` until validated — no autonomous status promotion.
- **Never:** Uses its "deepening model of who you are" — that is Hindsight/Insight territory. Never speaks to the user directly (§4.10 Response Engine unchanged). Never decides whether it should be invoked — that decision belongs to Gaia.
- **Bounded breadth:** *Broad capabilities, narrow permissions.* Hermes may signal the need for new domain-agents; only the harness defines and activates them. Generic tool use under Gaia's rules does not get called "agents."

---

# Architecture Principles ⟨ongewijzigd⟩

Build against interfaces. Not implementations. Every subsystem has a single responsibility. Prefer maintainability over cleverness. Keep implementations replaceable.

---

# Cognitive Loop (aangepast)

```
USER INPUT
↓
LOGOS  (single faculty: interpret intent, then reason — prompt-level)
↓
GAIA
├── Goals / State
├── Decision
└── Plan
↓
ORCHESTRATION
↓
SUB-AGENT (optional — Hermes, Melodiq, SongCompanion, ...)
↓
RESULT
↓
GAIA (integrates the result)
↓
RESPONSE ENGINE (see §4.10)
↓
USER
↓
LOGOS (Evaluate / Adapt)
↓
FEEDBACK (first-class input)
↓
(next turn)
```

A capability-free turn takes the same path from a shorter start (unchanged from v2.4.0).

---

# Platform Independence · Provider Independence · Deployment Topology ⟨ongewijzigd⟩

Overgenomen uit v2.4.0, met één correctie: de passage "it does not need to re-implement Logos, intentIQ/reasonIQ, Hindsight…" wordt "…re-implement Logos, Hindsight…".

---

## 1. Guiding Architectural Principles (aangepast)

1. **Gaia lives in the cloud; the desktop is her first client.** ⟨ongewijzigd⟩
2. **Gaia is the agency.** ⟨ongewijzigd⟩
3. **Logos is Gaia's cognitive layer.** Logos is where Gaia interprets input and constructs meaning — one faculty, prompt-level. *(was: "consisting of intentIQ and reasonIQ")*
4. **Capabilities are optional.** ⟨ongewijzigd⟩
5. **Feedback is first-class.** ⟨ongewijzigd⟩
6. **Storage is abstract.** ⟨ongewijzigd⟩
7. **Hindsight persists; Logos reasons.** ⟨ongewijzigd⟩
8. **Absolute model agnosticism.** ⟨ongewijzigd⟩ — versterkt door het harnas-raamwerk en de multi-provider test (intent + character consistency).
9. **Separation of concerns is identity.** SOUL, Logos, Hindsight, sub-agents, and Gaia Desktop each own exactly one responsibility. *(intentIQ + reasonIQ verwijderd uit de opsomming)*
10. **Growth without boundary collapse.** ⟨ongewijzigd⟩
11. **Nieuw — The harness is Gaia.** Intelligence is bought (model); identity is built (harness). Every feature is tested: harness or model?

---

## 2. System Overview

Zelfde diagram als hierboven onder "Core Architectural Model" — de intentIQ/reasonIQ-dozen zijn geschrapt, "CAPABILITIES" heet nu "SUB-AGENTS / CAPABILITIES", en onder Gaia Cloud staat de geheugenpijp (Chronicle → Hindsight → Logos) in plaats van "Chronicles (if/when it exists)".

---

## 3. Gaia Desktop — The Primary Client ⟨ongewijzigd⟩

## 4. System Responsibilities & Boundaries

- **4.1 SOUL — Identity**: ⟨ongewijzigd⟩, plus de nieuwe **prompt-regel**: de persona-prompt blijft klein — karakter is een handvol regels; begrip van de gebruiker komt runtime via Insight/Hindsight mee, niet als groeiende statische biografie in de prompt.
- **4.2 Logos**: herschreven, zie sectie "Logos" hierboven.
- **4.3 Gaia — Agency + Orchestrator**: ⟨ongewijzigd⟩.
- **4.4 Hindsight — Long-Term Memory**: ⟨ongewijzigd⟩ in tekst, maar uitgebreid met de pijp-regels: Hindsight leest uít Chronicle's gecureerde data; capture gaat nooit rechtstreeks naar Hindsight (altijd via de Ingestie Gateway); Hindsight-output heeft binnen Gaia altijd status `interpretation` totdat expliciet onderbouwd (adapterlaag — de eerste bouwtaag).
- **4.5 Hermes**: herschreven, zie sectie "Hermes" hierboven.
- **4.6 Melodiq / 4.7 SongCompanion**: ⟨ongewijzigd⟩ — ingedeeld bij de sub-agenten (één domein, geen eigen geheugen van gezag).
- **4.8 MCP — Actions**: ⟨ongewijzigd⟩.
- **4.9 Gaia Desktop — Experience**: ⟨ongewijzigd⟩.
- **4.10 Response Engine — Expression Boundary**: ⟨ongewijzigd⟩, met tekstuele correctie waar "intentIQ/reasonIQ" genoemd wordt (§4.10 noemt ze één keer — schrap die referentie).

---

## 5. Data & Interaction Flow

**5.1 Everyday conversational turn**: als in v2.4.0, behalve:
- Stap 3 wordt: "Gaia processes the turn through Logos — interpreting what the user is trying to achieve and what follows, in one faculty."
- De capability-lijst noemt sub-agents in plaats van capabilities (inhoudelijk gelijk).
- Toegevoegd als stap 9a: "Hindsight reflects on Chronicle's curated data; its output enters Logos as `interpretation` via the adapter."

**5.2 Direction of dependency**: ⟨ongewijzigd⟩, plus:
- **Chronicle → Hindsight → Logos** is de enige geheugenrichting. Chronicle is nooit afhankelijk van Hindsight; Hindsight mag wél afhankelijk zijn van Chronicle voor bewijs.

---

## 6. Memory Formation ⟨deels ongewijzigd⟩

- "Reflection, not logging", "Memory policies are explicit contracts", "Provenance is preserved": ⟨ongewijzigd⟩.
- "Patterns over facts" wordt: patterns vormen zich óp Chronicle's data (Hindsight leest uit Chronicle, niet uit ruwe streams); capture is per definitie bronmateriaal en hoort in Chronicle thuis — **capture gaat nooit rechtstreeks naar Hindsight** (Ingestie Gateway).
- Nieuw: **vierlagen-contract** — Chronicle = "dit is geregistreerd"; Hindsight = "dit denk ik dat het betekent"; Logos = "dit is mijn huidige beoordeling"; Gaia = "dit is hoe ik het presenteer".

---

## §7 Storage, §8 Legible controls, §9 e.v. ⟨ongewijzigd⟩

Worden ongewijzigd overgenomen uit v2.4.0, met doorlopende tekstcorrectie: elke verwijzing naar "intentIQ/reasonIQ" wordt "Logos".

---

# Open punten (expliciet in het doc houden)

1. Of élk datapunt fysiek eerst door Chronicle moet (sync/async-detail) — onbeslist.
2. Hoe de adapterlaag de status precies afdwingt — eerste bouwtaag, nog niet gebouwd.
3. Technische due diligence Hermes: kan zijn langetermijngeheugen uit, of wordt het "leeg laten lopen"-strategie?