---
title: Gaia — Architectuur v3.0 (voorstel)
document: architecture-v3
version: 3.0.0-proposal
status: proposal
last_updated: 2026-10-03
owner: Gaia Product Foundation
framing: "Gaia is a lifelong personal intelligence designed to grow through understanding."
---

# Gaia — Architectuur v3.0

> **Status: voorstel.** Dit document beschrijft de beoogde V3-architectuur en de status die aantoonbaar is in deze repository op 3 oktober 2026. Het vervangt [architecture.md](./architecture.md) nog niet. Besluiten die in de V3-bronnen uiteenlopen staan onder [Open architectuurbesluiten](#7-open-architectuurbesluiten).

## 1. Doel en ontwerpprincipes

Gaia is één agency in Gaia Cloud. Clients zijn interfaces naar Gaia, geen afzonderlijke instanties. Identiteit, cognitie, geheugen, capabilities en ervaring blijven gescheiden verantwoordelijkheden.

De V3-architectuur hanteert de volgende uitgangspunten:

1. **Het harnas is Gaia; het model is vervangbaar.** Identiteit, orkestratie en epistemische grenzen blijven buiten het redeneermodel.
2. **Bouw tegen contracten.** Providers, opslag en uitvoeringsinstrumenten blijven achter vervangbare interfaces.
3. **Logos reflecteert; Gaia handelt.** Logos redeneert, maar voert zelf geen acties uit en bezit geen opslag.
4. **Waarneming en afleiding blijven gescheiden.** Bronmateriaal wordt niet stilzwijgend een feitelijke herinnering.
5. **Capabilities hebben begrensde bevoegdheden.** Gaia bepaalt of een instrument nodig is; gevoelige acties volgen de menselijke toestemmingsgrens.
6. **Eén expressiegrens.** Antwoorden en capability-uitkomsten gaan via Gaia's Response Engine.
7. **De architectuur is doelgericht, de status is expliciet.** Een doelcomponent wordt niet als bestaand beschreven omdat hij in een V3-bron staat.

## 2. Systeemgrenzen en componenten

| Component | Verantwoordelijkheid in het doelbeeld | Status in deze repository |
|---|---|---|
| **Gaia Cloud / Gaia API** | Harnas, centrale agency, SOUL, orkestratie, API voor clients | Aanwezig: `services/gaia-api` bevat API, turn-orchestratie, SOUL, Hermes-integratie en Response Engine. |
| **Logos** | Cognitieve faculteit voor betekenis, intentie, bewijs en reflectie | Deels aanwezig in losse implementaties onder `services/gaia-api/src/logos/` en de decision/orchestration-code. V3-consolidatie is niet gerealiseerd in deze repository. |
| **Hindsight** | Externe, vervangbare geheugenprovider voor terughalen en bewaren van begrip | Integratie aanwezig via `services/gaia-api/src/hindsightClient.js`; provider en opslag staan buiten deze checkout. |
| **Cognition-service** | Huidige opslag- en API-laag voor patronen en hypothesen | Aanwezig als `services/cognition`; gebruikt een eigen PostgreSQL-schema en Hindsight-client. De uiteindelijke V3-eigenaarschapgrens is nog open. |
| **Foundation / Chronicle** | Beoogd bronarchief, ingestiepoort en MCP-server; registreert waarnemingen | Niet aanwezig in deze checkout. Een externe repository of deployment is hiermee niet beoordeeld. |
| **Hermes** | Extern executie-instrument voor taken onder Gaia's regie | Client/adapters aanwezig; de Hermes-dienst zelf is extern. De V3-regels voor werkgeheugen en zelflerende skills zijn nog niet volledig als adaptercontract afgedwongen. |
| **capture-rs** | Lokale observatie/capture aan de clientzijde | Niet aanwezig in deze checkout; V3-doelcomponent. |
| **Gaia Desktop en Gaia Web** | Clients die via de Gaia API met dezelfde Gaia communiceren | Niet aanwezig in deze checkout; hun repositories en productie-integratie zijn hier niet beoordeeld. |
| **Proxy** | Interne netwerkgrens voor Hermes-integratie | Aanwezig onder `proxy/`. |

De beoogde fysieke verdeling bestaat volgens de V3-bronnen uit vijf repositories: `Gaia-Cloud`, `Foundation`, `capture-rs`, `gaia-desktop` en `gaia-web`. Dit is een doelstructuur; deze checkout bevat alleen Gaia Cloud met de genoemde services en proxy.

## 3. Gespreks- en reflectiestromen

De V3-bronnen gebruiken twee formuleringen die nog niet volledig op elkaar zijn afgestemd: het live gesprek moet direct blijven, terwijl Logos als reflectie op die ervaring wordt beschreven. Daarom zijn de stromen hieronder een conceptueel doelbeeld, geen definitief timingcontract.

### Live gesprek — beoogd

```text
Client → Gaia API → Gaia / Logos-context → (optionele capability) → Gaia
       → Response Engine → Client
```

Gaia ontvangt de input, benut beschikbare context, bepaalt of een capability nodig is, integreert het resultaat en geeft één Gaia-antwoord terug via de Response Engine. Een eenvoudige beurt mag niet onnodig afhankelijk worden van een zware synchrone agentketen. Of een beperkte Logos-intentiepassage onderdeel blijft van elk live antwoord is een open besluit.

### Reflectie — beoogd

```text
Ervaring / geregistreerde bron → Chronicle (observation)
                               → Hindsight (interpretation / hypothesis)
                               → Logos (beoordeling en reflectie)
                               → geheugenprovider (persistente uitkomst)
```

De exacte timing van capture, reflectie en opslag is niet vastgelegd. De pijlen geven de beoogde scheiding en richting aan; zij leggen geen synchroon/asynchroon protocol of concrete API vast.

## 4. Geheugen- en epistemische grenzen

De V3-bronnen stellen een eenrichtingsmodel voor:

| Informatie | Betekenis | Beoogde eigenaar |
|---|---|---|
| `observation` | Geregistreerde broninformatie met herkomst | Chronicle / Foundation |
| `interpretation` | Afgeleide betekenis die nog geen bevestigde kennis is | Hindsight of de vast te stellen reflectielaag |
| `hypothesis` | Voorlopige uitspraak met bewijs en onzekerheid | Opslaglocatie nog te besluiten; zie open besluit 2 |
| `confirmed` | Door de mens expliciet bevestigde kennis | Geheugenprovider, met bevestiging door de mens als autoriteit |
| `rejected` | Afgewezen hypothese met reden en herkomst | Geheugenprovider, volgens nog vast te leggen overgangsregels |

Geen taalmodel, Logos-instantie of sub-agent mag op basis van een confidence-score zelfstandig de status `confirmed` toekennen. De precieze confidence-berekening en de bevoegdheid om hypotheses af te wijzen zijn nog open. Ingestie hoort broninformatie als `observation` te markeren; een adapter hoort afgeleide informatie als interpretatie herkenbaar te houden.

**Open ontwerpgrens:** Sommige V3-teksten noemen Chronicle bronarchief en Hindsight reflectie; andere noemen “Logos Memory” of laten Hindsight zelf reflecteren. Dit document kiest geen opslagarchitectuur voordat is vastgesteld wie hypotheses vormt, beoordeelt en duurzaam opslaat.

## 5. Capabilities, sub-agenten en acties

- Gaia beslist of een capability wordt ingezet. Een capability beslist niet zelf dat zij nodig is.
- Hermes is in V3 een externe executie-sub-agent, geen deel van Logos' interne cognitie. Zijn werkgeheugen is tijdelijk; duurzame uitkomsten keren alleen met herkomst en voorlopige epistemische status terug.
- Melodiq, SongCompanion en toekomstige domeininstrumenten blijven optioneel en krijgen begrensde verantwoordelijkheden.
- MCP biedt acties en integraties. Acties met gevoelige of externe gevolgen volgen een expliciete toestemmingsgrens.
- Sub-agenten spreken niet zelfstandig namens Gaia. Hun resultaten worden door Gaia geïntegreerd en via de Response Engine uitgedrukt.
- De voorgestelde HADES-regel verbiedt sub-agenten een eigen identiteit, geheugen van record of epistemische autoriteit te ontwikkelen. De toegestane taakbreedte van Hermes en de grens tussen “capability” en “sub-agent” moeten nog worden vastgesteld.

## 6. Huidige implementatie en V3-gaten

De tabel in §2 is een repository-inspectie, geen claim over niet-gekoppelde repositories of productieomgevingen. In deze checkout zijn Gaia API, SOUL, Hermes-adapters, Hindsight-integratie, Response Engine, Logos-gerelateerde modules, cognition-service en proxy aanwezig. De afzonderlijke Foundation/Chronicle-, capture-rs-, Desktop- en Web-repositories zijn hier niet opgenomen.

De voornaamste zichtbare overgang naar V3 is de consolidatie van de bestaande intentie-, redeneer- en besliscode naar één Logos-faculteit, zonder dat de huidige API-grenzen of Response Engine worden verward met de doelarchitectuur. Ook moet de adaptergrens tussen geregistreerde waarneming, afgeleide hypothese en geheugenpersistentie worden vastgesteld. Dit zijn documenteerbare doel- en statusverschillen; dit document voert geen codewijzigingen of migratie uit.

## 7. Open architectuurbesluiten

De volgende punten zijn expliciet open gehouden omdat de bronset verschillende antwoorden bevat:

1. **Timing van Logos:** Is Logos alleen achtergrondreflectie na een beurt/sessie, of blijft een beperkte intentie- en betekenispassage onderdeel van het live antwoord? De definitieve V3-architectuur benadrukt asynchrone reflectie; het herschrijfvoorstel behoudt een Logos-passsage in de live flow.
2. **Hypothesevorming en opslag:** Vormt Logos hypotheses en slaat Hindsight ze alleen op, reflecteert Hindsight zelf, of bestaat er een aparte “Logos Memory”? Leg één eigenaar vast voor vormen, beoordelen, lifecycle-overgangen en persistentie.
3. **Confidence en statusovergangen:** De Absolute Override verbiedt automatische promotie naar `confirmed`, maar de `3 pijlers`-bron en de V3-PDF noemen confidence-formules, drempels en “zachte promotie”. Bepaal of die drempels alleen retrieval/gedrag beïnvloeden of een statusovergang mogen veroorzaken.
4. **Afwijzing en tegenhypothese:** Bepaal wie een hypothese naar `rejected` mag verplaatsen, of dit automatisch kan, en wanneer een verplichte tegenhypothese nodig is. De bronnen verschillen over automatische consolidatie en de reikwijdte van dialectische toetsing.
5. **Chronicle als verplichte eerste stap:** Bepaal of alle capture synchroon via Chronicle moet lopen, of dat alleen de uiteindelijke bronregistratie verplicht is. De herschrijftekst noemt dit detail expliciet onbeslist.
6. **Hermes en de HADES-grens:** Bepaal hoe brede multi-step uitvoering past bij de eis dat sub-agenten één domein hebben, en welk Hermes-werkgeheugen eventueel buiten een actieve taak mag voortbestaan.
7. **Repository- en servicegrenzen:** Bevestig de vijf-repository-doelstructuur en de relatie tussen `Foundation`, de bestaande cognition-service en de Gaia API voordat componenten of contracten worden verplaatst.

Tot deze punten zijn besloten, blijven de V3-documenten voorstellen. De bestaande [architecture.md](./architecture.md), [vision.md](./vision.md) en overige funderingsdocumenten blijven de geldende documentatie.

## Bronnen

Gebaseerd op de V3-bestanden in `docs/v3/`, in het bijzonder `v3.0-foundation-v2 (1).md`, `architecture-v3.0.md` en `gaia-architecture-v3-0-rewrite-proposal.md`. De huidige status is gecontroleerd tegen de code en README's in deze checkout. Geen van de afwijkingen uit de bronset is hier stilzwijgend als definitief besluit behandeld.
