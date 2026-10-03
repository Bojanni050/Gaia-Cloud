---
pulse-tags: ["architecture", "logos", "epistemics", "harness", "sub-agents"]
pulse-connections: [{"path": "architecture/architecture.md", "relation": "extends", "why": "Advances and supersedes the v2.4.0 architecture by consolidating Logos and formalizing the harness model."}, {"path": "architecture/gaia-architecture-v3-0-rewrite-proposal.md", "relation": "supports", "why": "Implements the finalized specifications proposed in the v3.0 rewrite proposal."}, {"path": "architecture/decisions/chronicle-hindsight-considerations.md", "relation": "supports", "why": "Adopts the two-pipe, single-truth memory pipeline and epistemic status model finalized in the considerations document."}]
---

# Gaia v3.0 — Systeemarchitectuur & Ontwerp
**Status:** Definitief (September 2026)  
**Type:** Systeemarchitectuur & Componentenspecificatie  
**Auteur:** Gaia Core Team  

---

## 1. Visie & Kernparadigma ("Het Harnas is Gaia")

Gaia v3.0 is ontworpen als een levenslange, persoonlijke intelligentie (*Reflective Intelligence*). Het systeem rust op twee fundamentele architectonische principes:

1. **Scheiding van Identiteit en Inferentie:**  
   Gaia is niet het onderliggende Large Language Model (LLM); het LLM is een inwisselbaar inferentie-orgaan. Alles wat Gaia haar identiteit, geheugen, epistemische discipline en continuïteit geeft, leeft binnen **Het Harnas** (`Gaia-Cloud` + `Foundation`).
2. **Het Conversatie- vs. Reflectiemaxime:**  
   > *"De conversatie is de ervaring. Logos is de reflectie op die ervaring."*  
   Live gespreksbeurten verlopen direct (`Gebruiker → Gaia → LLM → Response`) zonder synchrone redeneervertraging. Alle cognitieve evaluaties, patroonherkenning en leereffecten vinden asynchroon op de achtergrond plaats.

---

## 2. Geconsolideerde Cognitie: Logos

In september 2026 zijn de voorheen gescheiden subsystemen **IntentIQ** (intentie-interpretatie) en **ReasonIQ** (logische toetsing) definitief gepensioneerd als losse softwarelagen. Hun functionaliteit is samengevoegd binnen **Logos**, één overkoepelende reflectieve faculteit op prompt- en achtergrondniveau.

### De 3 Dimensies van Logos
* **Retrospectieve Intentie (ex-IntentIQ):** Evalueert achteraf wat de gebruiker probeerde te bereiken en vergelijkt dit met de initiële aanname van Gaia.
* **Betekenis & Evidentie (ex-ReasonIQ):** Onderzoekt brondata uit Chronicle, toetst hypothesen en bewaakt de bewijslast over meerdere beurten.
* **DecisionIQ (Besluitvorming & Uitkomsten):** Reflecteert op Gaia's eigen keuzes en tool-efficiëntie (bijv. of een sub-agent zoals Hermes wel of niet nodig was).

---

## 3. Epistemische Discipline & De Geheugenpijp

Gaia hanteert een strikte, eenrichtingsgebonden datastroom om te voorkomen dat AI-aannames de harde feiten vervuilen:

$$\text{Chronicle (Source of Truth)} \longrightarrow \text{Hindsight / Insight (Patronen)} \longrightarrow \text{Logos (Beoordeling)}$$

### Epistemische Statusmarkeringen
* **`observation`:** Harde, geregistreerde bronfeiten in **Chronicle** (geüploade chats, notities, schermopnames, audiodagboeken).
* **`interpretation` / `hypothesis`:** Door Logos/Hindsight geëxtraheerde patronen, herinneringen en werkhypothesen.
* **`confirmed`:** Expliciet door de mens gevalideerde kennis (**Absolute Override**). Geen enkel model kan data automatisch naar `confirmed` promoveren.
* **`rejected`:** Door de mens of consolidatie afgewezen hypothesen (met vastgelegde verwerpreden).

---

## 4. De 5-Repository Structuur

Om type-drift te voorkomen en duidelijke grenzen te bewaken, is de codebase opgedeeld in 5 gespecialiseerde repositories:

1. **`Gaia-Cloud`:** Het Harnas — herbergt SOUL, Logos, `gaia-api` en de orkestratielogica.
2. **`Foundation`:** De Stekkerdoos — herbergt Chronicle (Drizzle/SQLite opslag), de Ingestie Gateway en `mcpServer.js`.
3. **`capture-rs`:** Lokale scherm- en activiteitenopname in Rust op de client.
4. **`gaia-desktop`:** Native desktop-app (Tauri + React).
5. **`gaia-web`:** Webinterface voor `higaia.nl`.

### Integratie met IDE's (VS Code / Cursor)
IDE's koppelen **uitsluitend via MCP** aan `Foundation` (`mcpServer.js`). Dit garandeert dat alle ingevoerde snippets of notities verplicht de status `observation` krijgen en niet rechtstreeks de reflectielaag (Hindsight) vervuilen.

---

## 5. Sub-agenten & De HADES-regel

Gespecialiseerde instrumenten (zoals **Hermes** voor executie en communicatie op meerdere apparaten) voeren smalle taken uit onder de **HADES-regel**:

* Sub-agenten handelen uitsluitend in opdracht van Gaia.
* Sub-agenten bouwen **nooit** een eigen duurzaam geheugen op.
* Sub-agenten hebben **geen** eigen identiteit, karakter of zelfstandige epistemische autoriteit buiten Gaia om.

---

## 6. SOUL & Identiteitsbehoud

* **SOUL:** Een constante, beknopte constitutie die Gaia's stem, waarden en grenzen vastlegt.
* **Leren zonder Drift:** Gaia leert van ervaringen doordat haar *kennis* en *hypothesen* in Logos Memory groeien, terwijl haar *persoonlijkheid en waarden* (SOUL) onveranderd strak en herkenbaar blijven.
