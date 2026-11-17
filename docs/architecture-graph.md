# Gaia-Cloud — how everything is connected

A visual map of the current system: the three stores, the live turn, the deferred cognition
that writes, the faculties, the human Absolute Override, and the surface a client reaches.

> Renders on GitHub natively (Mermaid). A standalone, zoomable version lives in
> `docs/architecture-graph.html`.
>
> Regenerated 2026-11-16 against `a1a485e`. Every claim below is a shortened form of
> `docs/architecture.md`, which is machine-checked by `scripts/verify-architecture.js`; where
> the two ever disagree, that document wins.

## 1. The whole system

```mermaid
flowchart TB
    subgraph clients["Clients — separate repositories"]
        web["Gaia Web<br/>(browser)"]
        desktop["Gaia Desktop<br/>(Tauri)"]
    end

    subgraph cloud["GAIA-API  :8891 — the one backend"]
        api["/conversation/turn — the turn<br/>/cognition · /conversations · /library<br/>/memory · /kairos · /eleos · /research<br/>/desktop (conditional) · /admin · /api"]
    end

    subgraph stores["Stores"]
        foundation["FOUNDATION — RAW REALITY<br/>observations · ingest · MCP<br/>(external; promotes nothing on its own)"]
        cognition["COGNITION — DERIVED OWNER<br/>hypotheses (4 kinds) · patterns<br/>observations · kairos episodes + digests<br/>Postgres, lifecycle transitions"]
        hindsight["HINDSIGHT — DERIVED STORE<br/>gaia:* tags · semantic recall<br/>three banks: bojan · gaia · gaia-logos"]
    end

    hermes["HERMES  (hermes_net)<br/>research jobs only — submit, poll later"]

    web -->|"Bearer"| api
    desktop -->|"Bearer"| api
    api -->|"the turn, as a raw observation"| foundation
    api -->|"derived records (lifecycle)"| cognition
    cognition -->|"cognitionSync mirror"| hindsight
    api -->|"recall · reflect · her own bank"| hindsight
    api -->|"archive asks only"| foundation
    api -.->|"research run submitted, never awaited"| hermes

    classDef ext fill:#2A241B,stroke:#CBA36A,color:#ECE6DA
    classDef own fill:#221D15,stroke:#CBA36A,color:#ECE6DA
    class foundation,hindsight,hermes ext
    class cognition own
```

## 2. The live turn — direct generation

```mermaid
flowchart TB
    A["client → POST /conversation/turn"] --> B["1. validate + auth<br/>token unset ⇒ fail closed (503)"]
    B --> C["2. resolve attachments<br/>library → text, or vision OCR"]
    C --> R["3. gated recall — parallel fan-out,<br/>every leg best-effort"]

    subgraph recall["one call per leg, none can fail the turn"]
        R1["Hindsight: reflections +<br/>the seven standing mental models"]
        R2["Hindsight: patterns —<br/>only on a retrieval signal"]
        R3["knowledge pages"]
        R4["Foundation: archive asks only<br/>('what is recorded')"]
        R5["conversation search — only on a<br/>lookup / past-reference signal"]
        R6["open-question raise"]
        R7["research reach — submits a run,<br/>does not wait"]
    end
    R --> R1 & R2 & R3 & R4 & R5 & R6 & R7

    R1 & R2 & R3 & R4 & R5 & R6 & R7 --> E["4. prompt assembly<br/>SOUL + recall blocks +<br/>capability awareness"]
    E --> F["5. ONE inference call<br/>primary → backup on a retryable,<br/>pre-output failure<br/>+ tools, at most 3 rounds"]
    F --> G["6. Response Engine<br/>src/responseEngine.js — the only<br/>writer of the wire format"]
    G --> H["reply delivered<br/>{ reply } or SSE frames"]
    H --> I["7. runDeferredCognition<br/>fire-and-forget, never awaited"]
    H --> J["research poll — a separate cycle<br/>findings → conversation · GET /research/jobs"]

    F -.->|"Hermes is never a fallback and,<br/>in the live path, never the generator"| H
    J -.->|"run status only"| HS["HERMES"]

    classDef nope fill:#2A241B,stroke:#6F675A,color:#A79E8E
    class HS nope
```

## 3. The tools inside that one call

| Tool | Where | Gated by |
| --- | --- | --- |
| `remember` → `bojan`, `keep` → `gaia`, `search_memory`, `retract_memory`, `forget_memory` | `reasoning/memoryTool.js` | `GAIA_MEMORY_TOOL` (one flag for all five) |
| `web_search` | `reasoning/webSearchTool.js` | presence of `GAIA_WEB_SEARCH_API_KEY` |
| `read_back` | `reasoning/conversationTool.js` | the transcript seam being wired |
| `desktop` | `desktopBroker.js` | `GAIA_DESKTOP` + client `desktop: true` + streamed turn |

Three *rounds* is the bound, not three calls: every call inside a round runs
(`generation/gaiaGenerator.js`, `DEFAULT_MAX_TOOL_ROUNDS = 3`). There is no tool named
`conversation_search` — that is the capability id, and `read_back` is the tool behind it.

## 4. Deferred cognition — where writing happens

```mermaid
flowchart TB
    D["runDeferredCognition — after the reply, never awaited"]

    subgraph side["side tasks — concurrent, awaited at the end"]
        S1["1. Foundation.submitObservation<br/>the completed turn as a raw record"]
        S7b["7b. Aion — Gaia's own bank (gaia)<br/>ungated, at her own discretion"]
        S7c["7c. Eleos — the check-in faculty<br/>gates now, delivers hours later"]
    end

    subgraph chain["sequential chain"]
        S2["2. Memoryworthiness — six cheap dimensions"]
        S3["3a/3b. hypothesis lifecycle prep, then<br/>background Logos: the depth gate decides<br/>whether ONE model call happens"]
        S4["4. applyReasoningResult —<br/>the structured result into the manager"]
        S5["5. pattern formation — needs a durable<br/>hypothesis changed and a non-discarded turn"]
        S6["6. Cognition retention: observations,<br/>open questions, relationships<br/>(deliberately not gated)"]
        S7["7. post-turn Hindsight reflection — gated"]
        S8["8. DecisionIQ review — observability only"]
    end

    D --> S1 & S7b & S7c
    D --> S2 --> S3 --> S4 --> S5 --> S6 --> S7 --> S8

    S3 -->|"proposes"| K["hypotheses · patterns ·<br/>open questions · relationships"]
    K --> SINK["cognitionSink"] --> COG["COGNITION<br/>owning the lifecycle"]
    COG --> SYNC["cognitionSync"] --> HS["HINDSIGHT<br/>gaia:* mirror"]
    S1 --> FND["FOUNDATION"]
    S7 --> HS
    S7b --> OWN["HINDSIGHT — the gaia bank"]
```

## 5. The faculties — loops with no turn involved

```mermaid
flowchart LR
    LOGOS["Logos — background reflection<br/>logos/logos.js<br/>a social turn is shallow and free,<br/>everything else gets one deep call"]
    KAIROS["Kairos — observations into narrative<br/>kairos/runtime.js + worker,<br/>then the day digest at 07:00"]
    ELEOS["Eleos — coming back to a moment<br/>reasoning/eleos.js + tick<br/>gate now, deliver hours later"]
    AION["Aion — Gaia's own bank<br/>reasoning/aion.js + scheduler<br/>every few turns, on session change,<br/>when the session goes idle"]
    SCANS["Three scans on a timer<br/>soft-promotion · expiry (14 days)<br/>belief formation"]
    REACH["Reach<br/>research jobs (Hermes) · web_search<br/>open-question raise"]

    LOGOS --> COG["COGNITION"]
    KAIROS --> COG
    SCANS --> COG
    AION --> OWN["HINDSIGHT — gaia"]
    ELEOS --> CHECK["eleos store<br/>check-ins"]
    REACH --> EXT["HERMES · a search provider<br/>the turn's own wording"]

    classDef ext fill:#2A241B,stroke:#CBA36A,color:#ECE6DA
    class EXT,OWN ext
```

Belief formation is the **only** thing that forms a statement from observations, and it needs
repeated ground. Per-turn hypothesis formation is off by default (Optie 2);
`GAIA_HYPOTHESIS_FORMATION=per_turn` restores the old behaviour.

## 6. Human Absolute Override — the only path to `confirmed`

```mermaid
sequenceDiagram
    participant Chat as GaiaChat (Web/Desktop)
    participant API as gaia-api /cognition/*
    participant Cog as Cognition
    participant HS as Hindsight

    Chat->>API: GET /cognition/hypotheses
    API->>Cog: list (proposed / testing / corroborated)
    Cog-->>Chat: pending statements
    Chat->>API: POST .../:id/test · /reject { reason } · /reopen { reason }
    API->>Cog: → testing · → rejected (verwerp_bron "mens")
    Chat->>API: POST .../:id/correct { reason }
    API->>Cog: reword a settled statement
    Chat->>API: POST .../:id/answer — an open question
    Chat->>API: POST .../:id/confirm { supersedes[], rationale }
    API->>Cog: → confirmed
    API->>Cog: supersede(old ids) → rejected (verwerp_bron "consolidatie")
    API->>HS: mirror (gaia:confirmed_fact)
```

## 7. The lifecycle — six statuses

```mermaid
stateDiagram-v2
    [*] --> proposed
    proposed --> testing: first evidence
    proposed --> confirmed: a person settles it directly
    proposed --> rejected: let go (verwerp_bron mens)
    proposed --> expired: nothing arrived, 14 days (verwerp_bron verlopen)
    testing --> corroborated: soft-promotion — micro, C ≥ 0.80, no counter-evidence
    testing --> confirmed: HUMAN ONLY
    testing --> rejected: let go
    testing --> proposed: a person rewrites it
    corroborated --> confirmed: HUMAN ONLY
    corroborated --> testing: refine / contradiction
    corroborated --> rejected: let go
    expired --> testing: evidence arrives — a lapse is not a judgement
    expired --> confirmed: a person settles it
    expired --> rejected: let go
    expired --> proposed: a person rewrites it
    rejected --> testing: reopen — the only exit from that quarantine
    confirmed --> [*]
    rejected --> [*]
```

`expired` deletes nothing and quarantines nothing. `verwerp_bron` has three values: `mens`,
`consolidatie` (a newer statement superseded it, with a `superseded_by_id` pointer) and
`verlopen` (the machine's own lapse reason, kept apart because nothing was judged).
`corroborated` may inform retrieval; it is never presented as settled.

## 8. What lives where

```mermaid
flowchart LR
    subgraph raw["FOUNDATION — raw reality"]
        obs["observation · ingest · MCP<br/>(immutable)"]
    end
    subgraph derived["COGNITION — derived, lifecycle owner"]
        hyp["hypothesis (kind: hypothesis ·<br/>mental_model · relationship ·<br/>open_question)"]
        pat["pattern"]
        ob2["observation"]
        kai["kairos_episode · kairos_digest"]
    end
    subgraph store["HINDSIGHT — derived store, three banks"]
        g["gaia:hypothesis · gaia:mental_model<br/>gaia:pattern · gaia:confirmed_fact<br/>gaia:open_question · gaia:relationship<br/>gaia:kairos_episode · gaia:aion"]
    end
    hist["conversationStore<br/>the raw transcript, every turn verbatim"]
    eleos["eleos check-ins"]

    obs -->|"derive — belief formation"| derived
    derived -->|"mirror, rebuildable"| store
    store -->|"semantic recall"| Gaia(("Gaia"))
    hist -->|"literal search: read_back"| Gaia
    eleos -->|"a moment worth returning to"| Gaia
```

Two rules that are easy to get wrong. **The notebook is not memory**: `conversationStore` saves
every turn verbatim, and it is neither Hindsight nor Cognition. And **per-turn recall does not
span all three banks**: an ordinary turn fills its recall lines from `bojan` alone, `gaia`
joins only when the turn asks about her, `gaia-logos` takes no lines of its own, and the *full*
cross-bank client is what `search_memory` uses.

## 9. The HTTP surface

| Mount | Routes |
| --- | --- |
| inline | `GET /health`, `GET /`, `GET /soul`, `POST /conversation/turn` (JSON or SSE), `GET /speech/info`, `GET /speech/stt-info`, `POST /speech`, `POST /speech/stream`, `POST /speech/transcribe` |
| `/library` | `POST /files`, `GET /files`, `GET /files/:id`, `DELETE /files/:id` |
| `/conversations` | `GET /`, `GET /events` (SSE), `GET /search?q=`, `GET /:id`, `GET /:id/export/:format`, `DELETE /:id` |
| `/cognition` | `GET /hypotheses`, `POST /hypotheses/:id/{test,reject,reopen,correct,answer,confirm}` |
| `/memory` | `POST /retract`, `POST /forget` |
| `/kairos` | `GET /episodes`, `GET /episodes/stream` (SSE), `GET /episodes/:id/evidence`, `GET /digests`, `GET /digest?date=`, `POST /digest` |
| `/eleos` | `GET /checkins`, `POST /checkins/:id/ack` |
| `/research` | `GET /jobs`, `POST /jobs/:id/ack`, `POST /jobs/:id/approval` |
| `/desktop` | `POST /actions/:id/decision`, `POST /actions/:id/result` — only when `GAIA_DESKTOP` is on |
| `/admin` | operator-only, ~30 API routes; its HTML shell (`GET /admin`) is unauthenticated |
| `/api` | `GET /version` — public, no auth |

Cognition's own service speaks
`POST|GET|PATCH|DELETE /v1/banks/:bankId/{hypotheses,patterns,episodes,observations}`, on the
tailnet and unauthenticated. Clients never reach it directly.

## The three boundaries

1. **Foundation = raw reality.** A client that claims a `status` is refused (422).
   Observations only, and the store promotes nothing to fact by itself.
2. **Cognition = the lifecycle owner.** It stores and books transitions; it never reasons.
   Logos proposes, belief formation forms statements from repeated ground, and the person
   settles them.
3. **Hindsight = the derived store.** Rebuildable from Cognition with provenance, and recall
   lives there because Cognition has no vector search.
