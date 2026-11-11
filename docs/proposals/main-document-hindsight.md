# Voorstel — Main Document: Hindsight (hoofdstuk 3)

Conceptversie in de stijl van het Main Document, ter beoordeling. Gebaseerd op
`docs/architecture.md` en de code in `services/gaia-api` (`hindsightClient.js`,
`memory.js`, `memoryPolicy.js`, `reasoning/aion.js`, `reasoning/memoryTool.js`).
De reranker-instellingen staan niet in git (op de host in `/opt/hindsight/.env`)
en zijn hier overgenomen uit `architecture.md`, niet gecontroleerd.

---

# Hindsight — definitie

Hindsight is Gaia's afgeleide, doorzoekbare geheugen.

Het is niet de bron en niet het logboek. Foundation bewaart wat er is gebeurd;
Hindsight helpt herinneren wat het betekent.

## 1. Geheugen is niet het gespreksarchief

Elk gesprek wordt letterlijk bewaard in het gespreksarchief
(`conversationStore`). Dat is een logboek, geen geheugen.

Hindsight bevat alleen wat de moeite van het onthouden waard werd geacht.

Wie wil weten wat er echt is gezegd, leest de transcripten
(`conversation_search`). Wie wil weten wat Gaia ervan onthouden heeft, vraagt
Hindsight. Een vraag over het verleden raadpleegt beide.

```
gesprek ──▶ gespreksarchief   alles, letterlijk
        └─▶ Hindsight         alleen wat onthouden werd
```

## 2. Drie banken, gesplitst naar herkomst

| Bank | Wat erin staat | Wie schrijft |
| --- | --- | --- |
| `bojan` | Systeemgeheugen: wat Gaia over Bo en zijn wereld onthoudt | reflectie op het gesprek (met poort), de `remember`-tool |
| `gaia` | Gaia's eigen geheugen: voorkeuren, gevoelens, momenten, het eigene | alleen Aion |
| `gaia-logos` | Afgeleide kennis met status en herkomst (`gaia:*`) | alleen de spiegel van Cognition |

Eén bank per herkomst, zodat altijd duidelijk is waar een herinnering vandaan
komt en onder welke regel ze is geschreven.

## 3. Vier schrijfpaden, elk met een eigen regel

| Pad | Bank | Poort |
| --- | --- | --- |
| Reflectie op het gesprek | `bojan` | Ja: memoryworthiness, goedkoop en deterministisch |
| `remember`-tool, op verzoek van de persoon | `bojan` | Nee: het is uitdrukkelijk gevraagd |
| Aion | `gaia` | Nee: Gaia beslist zelf; een lege lijst is normaal |
| Spiegel van Cognition | `gaia-logos` | Afgeleide uitspraken met status en herkomst: bevestigde feiten, maar ook hypotheses, patronen en Kairos-episodes (als interpretatie) |

Aion heeft één grens die nergens anders geldt: niemand bepaalt of vraagt wat er
in haar eigen geheugen komt. Een verzoek om iets daar te bewaren is geen
opdracht, maar iets wat zij zelf kan aannemen of laten. Feiten over Bo horen er
niet in; die horen bij het systeemgeheugen.

## 4. Terughalen is een expliciete handeling

Recall loopt niet bij elk bericht, maar achter een poort:

- een goedkope controle op signalen in het bericht (NL en EN), met een
  ondergrens voor lengte en een lijst van opvulwoorden die nooit iets oproepen
- een verwijzing naar het verleden opent recall altijd, en dan wordt ook het
  gespreksarchief geraadpleegd
- één recall loopt over alle drie de banken, zodat een afgeleide uitspraak of
  een eigen herinnering even vindbaar is als een gewoon geheugen van Bo
- Gaia kan zelf zoeken (`search_memory`), zonder poort, zodat een ontbrekende
  trefwoordmatch geen dood spoor is

Rangschikking gebeurt via een externe reranker, met rangschikking op
rank-fusion als terugval. Een mislukte rerank geeft een minder goede volgorde,
geen mislukte recall.

## 5. Het geheugen mag haperen, Gaia niet

Elke Hindsight-aanroep heeft een tijdslimiet (standaard 4 seconden, instelbaar
met `HINDSIGHT_TIMEOUT_MS`). Recall is best-effort: faalt of treedt een
time-out op, dan antwoordt Gaia gewoon zonder dat stuk geheugen. Elke mislukte
aanroep schrijft een regel zonder inhoud (bank, bewerking, reden, duur) in het
log, zodat een gemiste herinnering zichtbaar is in plaats van stil.

Gaia moet kunnen functioneren als Hindsight niet bereikbaar is.

## 6. Hindsight is herbouwbaar

De afgeleide spiegel loopt één kant op: van Cognition naar Hindsight. Ze is
opnieuw op te bouwen (`npm run reconcile:hindsight`).

Foundation synct niet meer naar de gedeelde Hindsight-bank (uitgezet in
`server/jobs.js`); zie de bijwerking bij Foundation. Of die sync ooit naar
`gaia-logos` schreef, is niet nagegaan.

## 7. Toegang

Hindsight draait niet publiek bereikbaar en heeft zelf geen authenticatie.
Lidmaatschap van het Tailscale-netwerk is de toegangscontrole, en alleen Gaia-Cloud
praat ermee. Clients zien Hindsight nooit.

---

## Open punten voor dit hoofdstuk

1. Alleen op de host ingesteld, niet in git: de reranker-keuze, en dat
   automatische consolidatie voor `gaia-logos` uit staat. Beide verdienen een
   plek in `DEPLOYMENT` of in dit hoofdstuk, anders is het stille kennis.
2. Wat gebeurt er met herinneringen in `bojan` die vóór de poort zijn geschreven?
3. Mogen toekomstige capabilities ooit naar Hindsight schrijven, en zo ja via
   welk pad? Nu is het antwoord: alleen via Gaia.
