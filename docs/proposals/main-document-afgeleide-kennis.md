# Voorstel — Main Document: afgeleide kennis

Status: optie A gekozen door Bo op 16 oktober 2026 (Foundation is bron, Cognition is de afgeleide laag, de documenten volgen de werkelijkheid). Uitgevoerd in Foundation (README, DEPLOYMENT.md, Main Document-docx) op branch `docs/epistemic-layer-status`. De rest van dit voorstel is nog open. Bedoeld als aanvulling op
`Project Gaia - Main Document.pdf` (3 oktober 2026), dat alleen deel 1
(Foundation) uitwerkt.

Gecorrigeerd na een opmerking van Bo: een eerdere versie stelde dat Foundation
en Cognition allebei actief afgeleide kennis produceren. Dat klopt niet; zie
sectie 1.

## 1. Wat er nu is

Foundation (`Bojanni050/Foundation`, laatste commit 5 oktober) heeft de
epistemische tabellen (episode, evidence, hypothesis, fact, knowledge_gap),
maar de actieve laag is bewust uitgezet:

- `server/jobs.js` start de reflectie-engine, de promotie
  (observation naar hypothesis) en de Hindsight-sync niet meer. De reden in de
  code: ze vuurden tegen dezelfde gedeelde Hindsight-bank.
- `POST /reflection/run` en `POST /hindsight/run` geven `410 Gone`.
- Wat Foundation wel draait: embeddings aanvullen (auto-heal) en gateway-rijen
  als episode bevriezen (ingest-bridge).

In de praktijk is Foundation dus bron plus episodes, en `services/cognition` in
Cloud de enige actieve afgeleide laag (Logos stelt voor, mens bevestigt,
spiegel naar Hindsight). Dat komt overeen met `docs/architecture.md`.

De documentatie loopt daar niet gelijk mee:

| Document | Zegt |
| --- | --- |
| Main Document (3 okt) | Foundation beheert Evidence, Hypothesis en Fact |
| Foundation `README.md` | "opslag + epistemiek + één API", "de enige epistemische bron" |
| Foundation `DEPLOYMENT.md` §3c | de reflectie-engine draait elke 15 minuten (optioneel) |
| Foundation `jobs.js` | de engine staat bewust uit |
| `architecture.md` | Foundation bewaart ruwe realiteit, Cognition de afgeleide levenscyclus |

Gelezen uit bestanden; ik heb niet gedraaid wat er op de server staat. De
bevestig- en verwerproutes bestaan in Foundation nog in de code
(`/api/memory/hypotheses/:id/confirm`), maar volgens Bo loopt het bevestigen in de
praktijk via Cognition (GaiaChat). Niet nagegaan: wat er met de bestaande rijen
in Foundations epistemische tabellen gebeurt.

## 2. Beslissing nodig: wat is de status van Foundations epistemische laag?

Regel die ik voorstel, ongeacht de keuze:

> Foundation bewaart wat er is gebeurd. Een afgeleid object heeft precies één
> eigenaar. Alleen een mens bevestigt. Hindsight is herbouwbaar uit zijn bron.

Drie mogelijkheden:

**A. Bevestigen dat het uit staat en de documenten volgen de werkelijkheid.**
Foundation is bron, Cognition is de afgeleide laag. Het Main Document, de
README en `DEPLOYMENT.md` van Foundation worden aangepast. De tabellen blijven
bestaan als gereserveerd, of worden later opgeruimd. Kleinste ingreep, past bij
de code zoals die nu draait.

**B. De laag in Foundation terugbrengen** (zoals het Main Document het
beschrijft). Dan moet Cognition's rol worden herzien en moet het
Hindsight-conflict worden opgelost: dat was kennelijk de reden voor het
uitzetten. Grootste ingreep.

**C. Splitsen op aard.** Foundation bezit wat bevestigd moet worden over de
persoon (hypothesis, fact), Cognition wat Gaia over haar eigen werk afleidt.
Vraagt een scherpe grens en het opnieuw inschakelen van delen van Foundation.

Mijn neiging is A: dan klopt alles met wat er draait, en het Main Document
wordt alleen voor dit deel aangepast. B of C is alleen zinvol als je de
Foundation-laag bewust terug wilt, en dan eerst met een antwoord op waarom ze
tegen de gedeelde Hindsight-bank botsten.

## 3. Wat dan nog mist in het Main Document

Het document belooft vijf delen en heeft er één. Per ontbrekend deel de vragen
die het moet beantwoorden:

- **Logos:** is het een reflectielaag op de achtergrond na het antwoord (zo
  werkt de code) of een stap tussen Hindsight en Gaia (zo staat het in het
  diagram)? Wat mag Logos wel en niet schrijven?
- **Hindsight:** welke banks bestaan er (`bojan`, `gaia`, `gaia-logos`), wie mag
  erin schrijven, en wat gebeurt er als het geheugen niet bereikbaar is?
- **Gaia-Cloud + admin:** de uniforme API, SOUL, Cognition, het
  beheeroppervlak en de schakelaars uit `architecture.md`.
- **Clients:** Web en Desktop praten beide alleen met `gaia-api`; de
  bevestigingsflow voor acties op de eigen computer.
- **Cockpit:** staat in de inhoudsopgave, wordt nergens beschreven.

## 4. Kleine correcties aan wat er al staat

- "ls iets te groot" moet "Als iets te groot" zijn (deel 7).
- Resterende bronverwijzing "v3.0-foundation-v2 (1)" verwijderen.
- Diagrammen opnieuw uitlijnen, of vervangen door gegenereerde.
- "Chronicle" wordt in het document gebruikt voor de georganiseerde bron, en in
  Cloud voor de chat-samenvatter (`Chronicle-Gaia`). Eén betekenis kiezen.

## 5. Waar het document woont

Het Main Document staat op twee plekken: `Foundation/docs/` (docx en pdf) en
`Gaia-Cloud/docs/Project Gaia/` (pdf). De pdf's zijn nu identiek (zelfde
checksum), maar een leidend document met twee kopieën raakt vanzelf uit de pas.
Voorstel: één bron in markdown naast `architecture.md`, en het pdf of docx daaruit
genereren.
