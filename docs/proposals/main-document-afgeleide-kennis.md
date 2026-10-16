# Voorstel — Main Document: afgeleide kennis

Status: voorstel ter beoordeling, niet leidend. Bedoeld als aanvulling op
`Project Gaia - Main Document.pdf` (3 oktober 2026), dat alleen deel 1
(Foundation) uitwerkt.

## 1. Wat er nu is: twee systemen voor hetzelfde

Het Main Document zegt dat Foundation naast de bron ook Evidence, Hypothesis en
Fact beheert. `docs/architecture.md` zegt dat Foundation alleen ruwe observaties
bewaart en dat `services/cognition` de afgeleide levenscyclus bezit. Beide
kloppen met de code, omdat beide systemen bestaan.

| | Foundation (`Bojanni050/Foundation`) | Cognition (`services/cognition`) |
| --- | --- | --- |
| Objecten | episode, evidence, hypothesis, fact, knowledge_gap | hypothesis, pattern, candidate model, open question, relationship, Kairos-episode |
| Levenscyclus | status `observation`, `interpretation`, `hypothesis`, `confirmed`, `rejected`; fact hangt aan bevestigende hypothese; supersessie via `supersedes_fact_id` | `proposed`, `testing`, `corroborated` (machine, C ≥ 0.80), `confirmed` (alleen mens), `rejected` |
| Wie stelt voor | eigen reflectie-engine (`hypothesisReflectionSync.js`, hooguit 3 voorstellen per run) | Logos, na elk antwoord |
| Wie bevestigt | alleen de mens | alleen de mens (GaiaChat) |
| Bronkoppeling | evidence naar episode, onafhankelijke bronnen geteld | `sources: ["foundation:<id>"]` |
| Naar Hindsight | `hindsightSync.js` | `cognitionSync` (bank `gaia-logos`) |

Gelezen uit bestanden en schema's; ik heb niet gedraaid hoe ze samenwerken.

Gevolg: dezelfde vraag ("wat denkt Gaia dat dit betekent, en wie heeft het
bevestigd?") heeft twee antwoorden, en Hindsight kan van twee kanten gevuld
worden. Waar het ene systeem een hypothese bevestigt, weet het andere dat niet
vanzelf.

## 2. Beslissing nodig: één eigenaar per concept

Regel die ik voorstel, ongeacht de keuze hieronder:

> Foundation bewaart wat er is gebeurd. Een afgeleid object heeft precies één
> eigenaar. Alleen een mens bevestigt. Hindsight is herbouwbaar uit zijn bron.

Drie manieren om dat in te vullen:

**A. Foundation bezit alle epistemische objecten** (het Main Document zoals
geschreven). Cognition krimpt tot wat Foundation niet heeft, of verdwijnt.
Voordeel: één levenscyclus, sterkste herkomstregels (onafhankelijke bronnen,
episodes). Nadeel: Cloud schrijft nu naar Cognition, dus Logos' voorstellen en
`corroborated` moeten ergens anders heen.

**B. Foundation alleen bron, Cognition alle afgeleide kennis**
(`architecture.md` zoals geschreven). De epistemische tabellen in Foundation
worden uitgefaseerd. Voordeel: past bij de huidige Cloud-code. Nadeel: Foundation
verliest een werkende reflectie-engine en bevestigingsflow, en het Main Document
moet op meerdere plekken worden herschreven.

**C. Splitsen op aard.** Foundation bezit wat bevestigd moet worden over de
persoon (hypothesis, fact, knowledge_gap). Cognition bezit wat Gaia zelf
afleidt over haar werk en tijd (patterns, candidate models, relationships,
open questions, Kairos-episodes). Voordeel: beide systemen houden een duidelijk
terrein. Nadeel: de grens moet scherp zijn, en Cloud's hypotheses moeten
verhuizen.

Mijn neiging is A of C, omdat het Main Document al leidend is en Foundation de
strengste bevestigings- en bronregels heeft. Dat is een lezing van de
bestanden, geen oordeel over welke implementatie beter werkt in de praktijk;
dat kun jij beter beoordelen.

## 3. Wat dan nog mist in het Main Document

Het document belooft vijf delen en heeft er één. Per ontbrekend deel de vragen
die het moet beantwoorden:

- **Logos:** is het een reflectielaag op de achtergrond na het antwoord (zo
  werkt de code) of een stap tussen Hindsight en Gaia (zo staat het in het
  diagram)? Wat mag Logos wel en niet schrijven?
- **Hindsight:** welke banks bestaan er (`bojan`, `gaia`, `gaia-logos`), wie mag
  erin schrijven, en wat gebeurt er als het geheugen niet bereikbaar is?
- **Gaia-Cloud + admin:** de uniforme API, SOUL, Cognition (of de uitkomst van
  sectie 2), het beheeroppervlak, en de schakelaars uit `architecture.md`.
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

Het Main Document staat nu op minstens twee plekken: `Foundation/docs/` (docx en
pdf) en `Gaia-Cloud/docs/Project Gaia/` (pdf). Een leidend document met twee
kopieën raakt vanzelf uit de pas. Voorstel: één bron in markdown naast
`architecture.md`, en het pdf of docx daaruit genereren.
