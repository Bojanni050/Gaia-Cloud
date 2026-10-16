# Voorstel — Main Document: Cockpit (deel van hoofdstuk 1)

Conceptversie, ter beoordeling. **Aanname:** "Cockpit" in de inhoudsopgave
("Foundation + Cockpit") is het Gaia Server Control Center
(`Bojanni050/Gaia-CommandCenter`). Het woord "cockpit" komt nergens in de code
of docs voor, dus dit is een gok op basis van functie. Bevestig of corrigeer.

---

# Cockpit — definitie

De Cockpit is waar Bo ziet hoe het geheel ervoor staat. Hij kijkt mee; hij
stuurt niets.

## 1. Alleen kijken

Een webinterface (React + FastAPI, poort 8899, via Tailscale) die Gaia's
onderdelen toont en monitort. Het Docker-socket blijft server-side en wordt
alleen gelezen.

## 2. Wat hij laat zien

- **Architectuurmatrix** per laag (harnas, geheugenpijp, capabilities,
  clients), met per onderdeel de epistemische soort en levensfase
  (actief, interim, gepland).
- **Gezondheid en latency** van elk onderdeel; een geplande component wordt
  nooit rood.
- **Systeembronnen** en Docker-status, plus container-logs.
- **Ingestie-viewer:** wat capture-rs aanlevert en of het episode werd.
- **Hypothesen-viewer** (Cognition, alleen lezen) en **Kairos-episodes**.
- **Recall-latency van Hindsight** als percentielen, niet als gemiddelde.
- Directe links naar de UI's van Hermes, Hindsight, Gaia Admin en Gaia Web.

Alle onderdelen staan in één register (`backend/registry.yaml`).

## 3. Waarom hij bij Foundation hoort

De Cockpit leest uit Foundation (ingestie) en Cognition (afgeleide kennis) en
laat de geheugenpijp zien. Hij is een venster, geen laag.

---

## Open punten voor dit hoofdstuk

1. Klopt de aanname dat dit de Cockpit is?
2. De README van het Control Center beschrijft een geheugenpijp
   "Foundation → Hindsight → Cognition" en verwijst naar
   `Gaia-Cloud/docs/architecture-v3.md`, dat niet bestaat. Bijwerken.
3. Cognition staat daar als "interim"; dat klopt niet meer met
   `architecture.md`.
4. Moet de Cockpit ooit schrijven (bevestigen), of blijft hij strikt lezen?
