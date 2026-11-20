# Voorstel — Main Document: Logos (hoofdstuk 2)

Conceptversie in de stijl van het Main Document, ter beoordeling. Gebaseerd op
`docs/architecture.md` en de code in `services/gaia-api` (`logos/`,
`reasoning/`, `turn.js`, `eval/`). Gelezen uit bestanden, niet gedraaid.

---

# Logos — definitie

Logos is Gaia's cognitieve vermogen: wat probeert de persoon te bereiken, wat
betekent dit, wat volgt er uit wat we weten, en hoe zeker zijn we?

Foundation bewaart wat er is gebeurd; Hindsight helpt herinneren wat het
betekent; Logos onderzoekt wat we ervan moeten denken.

## 1. Logos is geen agent en geen router

Logos is een denkend onderdeel van Gaia, geen uitvoerder. Dit staat in de code
vastgelegd, niet alleen in documenten (voor IntentIQ is de grens ook getest; voor
Logos zelf heb ik dat niet nagegaan).

Logos:

- roept nooit Hermes, Hindsight of MCP aan
- kiest of voert nooit een tool uit
- schrijft nooit zelf naar een database
- beslist nooit over het antwoord of de actie van Gaia
- maakt nooit zelf iets `confirmed`

Logos stelt voor. Het bezit geen waarheid.

## 2. Logos draait na het antwoord, niet ervoor

Het antwoord zelf is directe generatie: één aanroep, zonder tussenstap.
Begrijpen gebeurt binnen die ene aanroep. Er is geen aparte interpretatiestap
vóór het antwoord, en geen planning of routering.

```
bericht ──▶ SOUL + context + (poort) recall ──▶ één aanroep ──▶ antwoord
                                                                   │
                                                                   ▼
                                                       Logos (op de achtergrond)
```

Pas als het antwoord is afgeleverd start Logos, zonder het antwoord nog te
raken of te vertragen. Wat Logos oplevert kan de persoon dus nooit bereiken
voordat Gaia gesproken heeft.

IntentIQ, de eerdere aparte interpretatiestap, bestaat nog als module met een
eigen testset, maar wordt in de live beurt niet aangeroepen. De poort voor
recall draait op lexicale regels. Zie de open punten.

## 3. Eén vermogen, drie dimensies

Interpretatie, betekenis en bewijs, en beslissingsreflectie zijn geen drie
subsystemen maar eigenschappen van één Logos-pass.

| Dimensie | Vraag | Wanneer |
| --- | --- | --- |
| Interpretatie | Wat probeert de persoon te bereiken? | binnen de ene aanroep, en in reflectie |
| Betekenis en bewijs | Wat volgt eruit, met welk bewijs? | op de achtergrond, na het antwoord |
| DecisionIQ | Had deze beurt een gespecialiseerde capability nodig? | na afloop, alleen voor observatie |

DecisionIQ verandert nooit iets aan een lopende beurt; het legt alleen vast.

## 4. Bewijs is gelinkt, nooit verzonnen

Wat Logos als bewijs krijgt wordt vooraf samengesteld uit wat de beurt al
ophaalde (recall uit Hindsight, mental models, uploads). Elk bewijsstuk heeft
een stabiel id.

Hypotheses, conclusies en tegenstrijdigheden verwijzen naar die id's. Een id
dat niet in de aangeleverde lijst staat wordt weggehaald voordat het verder
gaat. Een model kan dus geen bron verzinnen.

## 5. Diepte wordt bepaald door bewijs, niet door lengte

Een goedkope, lokale controle beslist per beurt of het model nodig is.

- **Ondiep** kost niets. Zonder bewijs is er niets om over te redeneren, en een
  modelaanroep zou alleen hetzelfde eerlijke "niets om over na te denken"
  opleveren. Ondiep betekent niet niets doen: Logos meldt nog steeds eerlijk
  onzekerheid en ontbrekende informatie.
- **Diep** is één modelaanroep, alleen als er daadwerkelijk iets te wegen valt.

Het model komt uit de rol "reasoning" in de beheerinstellingen en kan zonder
codewijziging worden vervangen.

## 6. Wat Logos oplevert: voorstellen

Voorstellen voor hypotheses, patronen, open vragen en relaties.

- **Hypotheses:** een bestaande hypothese wordt herkend (`existingId`) in plaats
  van gedupliceerd. Nieuw bewijs komt als expliciete update: relatie, een
  begrensde verandering van zekerheid, en een onderbouwing.
- **Patronen:** kandidaten die twee of meer duurzame hypotheses verbinden.
  Voorzichtig gevormd: een onterecht patroon is erger dan een gemist patroon.
  Nooit als `confirmed`.
- **Tegenstrijdigheden en open vragen:** benoemd met herkomst.

Twee beheerders houden de toestand bij (`hypothesisManager`, `patternManager`);
zij redeneren niet. Een afzonderlijke schakel (`cognitionSink`) schrijft naar
Cognition, en zet nooit zelf een status.

## 7. Twee woordenboeken voor status

| Waar | Statuswaarden | Betekenis |
| --- | --- | --- |
| Logos, binnen één beurt | `proposed`, `testing`, `confirmed`, `rejected` | Logos' oordeel in deze beurt, nooit een opgeslagen overgang |
| Cognition, de levenscyclus | `proposed`, `testing`, `corroborated`, `confirmed`, `rejected` | de echte levenscyclus; `corroborated` is machinaal en wordt niet als vaststaand voorgesteld |

Alleen een mens maakt iets `confirmed` (Absolute Override), in GaiaChat.

## 8. De jongere broer en de rest

Kairos is Logos' jongere broer: een goedkope satelliet die ruwe observaties tot
verhalende episodes vouwt, altijd als interpretatie en met herkomst. Eleos en
Aion zijn geen Logos-delen; zie hun eigen beschrijving.

## 9. Elke beslissing is later na te lezen

Elke interpretatie en elke diepte-beslissing wordt gelogd (één regel per
beslissing, per dag bewaard). Een later gebleken fout wordt als aparte regel
vastgelegd, nooit door de oorspronkelijke beslissing te wijzigen, zodat een
analyse achteraf kan zien wat Gaia toen wist.

Er is geen online zelfaanpassing: niets wat gelogd is stuurt rechtstreeks een
volgende beslissing bij.

De testsets (`npm run eval:intent` en verwante) zijn bewust synthetisch en
meten coherentie, niet alleen nauwkeurigheid. Een redelijk aantal "onbekend"
en "dubbelzinnig" is daarbij geen fout.

---

## Open punten voor dit hoofdstuk

1. **IntentIQ:** formeel parkeren of weer live aansluiten? Nu is de code
   aanwezig, getest en gelogd, maar de live beurt gebruikt hem niet. Dit raakt
   het principe "Intent First" (zie `principles.md`, voorstel).
2. **Twee statuswoordenboeken** (sectie 7) kunnen verwarren. Eén benaming, of
   expliciet houden zoals hier?
3. **Hoe vaak is "diep"?** Het is nuttig om dat percentage ergens vast te
   leggen, omdat het de kosten van de achtergrondlaag bepaalt.
4. **Plaats van Kairos:** onder Logos (zoals nu) of onder Gaia-Cloud?
