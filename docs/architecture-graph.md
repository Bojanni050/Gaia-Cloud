# Gaia-Cloud — how everything is connected

A visual map of the current system: the three stores, the live turn, the
deferred cognition that writes, and the human Absolute Override.

> Renders on GitHub natively (Mermaid). A standalone, zoomable version lives in
> `docs/architecture-graph.html`.

## 1. The whole system

```mermaid
flowchart TB
    subgraph clients["GaiaChat clients"]
        web["Gaia Web<br/>(browser)"]
        desktop["Gaia Desktop<br/>(Tauri)"]
    end

    subgraph cloud["GAIA-API  :8891 — the Harness"]
        api["uniform Gaia API<br/>/conversation/turn · /cognition/*<br/>/library · /conversations · /speech · /admin/*"]
    end

    subgraph stores["Stores"]
        foundation["FOUNDATION  :4577 (external)<br/>RAW REALITY<br/>observations · /api/ingest/* · MCP"]
        cognition["COGNITION  :8890 (repo)<br/>DERIVED OWNER<br/>hypothesis · pattern · model<br/>question · relationship (Postgres)"]
        hindsight["HINDSIGHT  :8888 (external)<br/>DERIVED STORE<br/>gaia:* tags · semantic recall"]
    end

    hermes["HERMES  :8642 (hermes_net)<br/>capability — NOT in the live turn"]

    web -->|"HTTPS + Bearer"| api
    desktop -->|"HTTPS + Bearer"| api
    api -->|"submit observation"| foundation
    api -->|"write derived (lifecycle)"| cognition
    cognition -->|"cognitionSync mirror"| hindsight
    api -->|"recall / mental models / pages"| hindsight
    api -->|"archive asks only"| foundation
    api -.->|"never called live"| hermes

    classDef ext fill:#2A241B,stroke:#CBA36A,color:#ECE6DA
    classDef own fill:#221D15,stroke:#CBA36A,color:#ECE6DA
    class foundation,hindsight ext
    class cognition own
```

## 2. The live turn — direct generation

```mermaid
flowchart TB
    A["client → POST /conversation/turn"] --> B["1. validate + auth<br/>fail-closed 503 / 401"]
    B --> C["2. resolve attachments<br/>library → text / vision"]
    C --> D["3. gated recall (parallel)"]
    D --> D1["Hindsight: reflections +<br/>mental models + knowledge pages"]
    D --> D2["Hindsight: patterns (gaia:pattern)"]
    D --> D3["Foundation: archive asks only<br/>'wat staat er vastgelegd'"]
    D1 & D2 & D3 --> E["4. SOUL prompt + recall blocks +<br/>capability awareness"]
    E --> F["5. ONE inference call<br/>primary → backup (429/5xx/timeout, pre-output)"]
    F --> G["6. Response Engine<br/>only writer of the wire format"]
    G --> H["reply delivered ({ reply } or SSE)"]
    H --> I["7. runDeferredCognition<br/>fire-and-forget · never awaited"]

    F -.->|"Hermes is NEVER a fallback"| H
```

## 3. Deferred cognition — where writing happens

```mermaid
flowchart TB
    D["runDeferredCognition (after reply, never awaited)"]
    D --> S1["1. Foundation.submitObservation<br/>the turn as a RAW observation"]
    D --> S2["2. Memoryworthiness (deterministic gate)"]
    D --> S3["3. Logos reflection (one model call, deep only)"]
    D --> S4["4. Hindsight reflectOnTurn (gated)"]

    S3 --> K1["hypotheses"]
    S3 --> K2["patterns"]
    S3 --> K3["open questions"]
    S3 --> K4["relationships"]
    K1 & K2 & K3 & K4 --> SINK["cognitionSink"] --> COG["COGNITION<br/>(lifecycle owner)"]
    COG --> SYNC["cognitionSync"] --> HS["HINDSIGHT<br/>(gaia:* mirror)"]
    S1 --> FND["FOUNDATION"]
    S4 --> HS
```

## 4. Human Absolute Override — the only path to `confirmed`

```mermaid
sequenceDiagram
    participant Chat as GaiaChat (Web/Desktop)
    participant API as gaia-api /cognition/*
    participant Cog as Cognition
    participant HS as Hindsight

    Chat->>API: GET /cognition/hypotheses
    API->>Cog: list (proposed / testing)
    Cog-->>Chat: pending statements
    Chat->>API: POST .../:id/test
    API->>Cog: → testing
    Chat->>API: POST .../:id/reject { reason }
    API->>Cog: → rejected (verwerp_bron "mens")
    Chat->>API: POST .../:id/confirm { supersedes[], rationale }
    API->>Cog: → confirmed
    API->>Cog: supersede(old ids) → rejected (verwerp_bron "consolidatie")
    API->>HS: mirror (gaia:confirmed_fact)
```

## 5. The lifecycle

```mermaid
stateDiagram-v2
    [*] --> proposed
    proposed --> testing: first evidence
    proposed --> rejected: let go
    testing --> corroborated: machine soft-promotion (C ≥ 0.80)
    testing --> confirmed: HUMAN ONLY
    testing --> rejected: let go
    corroborated --> confirmed: HUMAN ONLY
    corroborated --> testing: refine / contradiction
    corroborated --> rejected: let go
    confirmed --> testing: contradicting evidence
    confirmed --> rejected: superseded (consolidatie)
    rejected --> [*]
    confirmed --> [*]
```

## 6. What lives where

```mermaid
flowchart LR
    subgraph raw["FOUNDATION — raw reality"]
        obs["observation (immutable)"]
    end
    subgraph derived["COGNITION — derived lifecycle"]
        hyp["hypothesis"]
        pat["pattern"]
        mod["mental model"]
        q["open question"]
        rel["relationship"]
    end
    subgraph store["HINDSIGHT — derived store"]
        g["gaia:hypothesis · gaia:pattern<br/>gaia:confirmed_fact<br/>gaia:open_question · gaia:relationship"]
    end
    hist["conversationStore<br/>raw transcript"]

    obs -->|"derive"| derived
    derived -->|"mirror"| store
    store -->|"semantic recall"| Gaia(("Gaia"))
```

## The three boundaries

1. **Foundation = raw reality.** A client that claims a `status` is refused (422). Observations only.
2. **Cognition = the lifecycle owner.** It stores and books transitions; it never reasons. Logos proposes, the human confirms.
3. **Hindsight = the derived store.** Rebuildable from Cognition with provenance; recall lives here because Cognition has no vector search.
