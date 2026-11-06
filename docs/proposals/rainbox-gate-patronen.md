# Voorstel — wat Gaia kan leren van RainBox (eval-gates en memory-provenance)

Status: voorstel, niets besloten, geen code. Bron: `neoneye/RainBox` (MIT, kleine
lokale-LLM-assistent). Gelezen via WebFetch: de mappenlijst van `source/`,
`source/memory/ops.py`, `source/evals/profile_gate.py`,
`source/evals/optimizer.py` en `source/CLAUDE.md`. **Niet gelezen:** de
supervisor/child-process-code, de shell-tool, de model-registry en de feedback →
eval-case-promotie. Wat daarover in omloop is, komt uit een samenvatting van
derden en is hier niet als feit overgenomen.

## 1. Wat er al is (dus niet overnemen)

| RainBox | Gaia-Cloud nu |
| --- | --- |
| Beslissen in code, niet in de prompt | `src/memoryWorthiness.js` (retain/discard met regex en drempels); `hypothesisManager.js` met benoemde drempels |
| Verworpen claim komt niet terug (`refused_tombstone`) | `rejected` is een harde terminale toestand; alleen `reopen()` door een mens (`hypothesisManager.js` rond regel 29) |
| Correctie moet overal doorwerken | `src/reasoning/memoryRetraction.js`: alle kopieën invalideren, bron retiren, in die volgorde |
| Eval-harnessen | `eval/` (Logos, hypothesis, pattern, memoryworthiness), met een eerlijke README over de stub-beperking |

De afweging "kopieer RainBox' geheugenmodel" valt dus grotendeels weg.

## 2. Wat wel interessant is

**a. Een deterministische release-gate voor wijzigingen (`profile_gate.py`).**
De gate doet geen modelaanroep. Hij vergelijkt opgeslagen eval-runs met
constanten die *vóór de eerste baseline* zijn vastgelegd
(`LOCALE_MARGIN = 0.15`, `CASE_PASS_FRACTION = 2/3`), en geeft `INVALID` als de
herkomst niet klopt (andere casusverzameling, ander modelgroep-snapshot, verkeerd
aantal herhalingen). Dan worden alle besluiten *niet* genomen, in plaats van
voorzichtig toch iets te zeggen. Gaia heeft nu evals, maar geen gate die zegt
"deze promptwijziging of modelwissel mag live". Dat past bij de zorg uit
`walkthrough.md` 21–23 over een vervangbaar LLM.

**b. Een optimizer die alleen aanbeveelt (`optimizer.py`).**
Eén knop tegelijk (`memory_retrieval_limit` 3/6/10, geen cartesisch product).
Een kandidaat wordt afgewezen bij: casus ontbreekt of is erbij gekomen, gemiddelde
daalt, een regressiecasus faalt, holdout daalt meer dan 0,05, of een
*forbidden-memory-leak* (absoluut: ook als de baseline hem al had). Er is bewust
geen automatische promotie; de uitkomst is een `OptimizerDecision`. Voor HARNESS²
(zie `harness2-harnessing-level-recursion.md`) is dit de toets die ontbrak:
een geleerde les gaat pas naar `testing` als hij de gate haalt.

**c. Dubbelzinnigheid vraagt om een vraag (`ops.py`).**
Bij meer dan één treffer voor "vergeet dat" handelt RainBox niet, maar vraagt
specifieker. Een claim met een conflict kan niet in de chat worden bevestigd; dat
moet op een aparte pagina. Gaia's retractie matcht op "het best passende citaat";
de vraag is of ze bij twee even goede treffers ook terugvraagt.

**d. Testdatabase die productie nooit raakt (`CLAUDE.md`).**
`conftest.py` dwingt elke pytest-run naar `rainbox_claude`, ook als er een
productie-URL is gezet; aanleiding was een eerdere test die echte
backup-instellingen wiste. Check of de Cognition- en gaia-api-tests hetzelfde
afdwingen of alleen afspreken.

## 3. Voorstel

1. **Eval-gate (a + b) als eerste stap**, klein: alleen voor de
   memoryworthiness- en Logos-harness. Drempels worden vastgelegd in een
   bestand voordat er een baseline is, en de gate geeft `INVALID` bij
   afwijkende casusset of afwijkend model. Geen nieuwe modelaanroepen.
2. **Eén-knop-per-keer en holdout** overnemen als regel voor elke
   prompt-/drempelwijziging die via de gate gaat.
3. **Terugvragen bij gelijke treffers** in retractie: eerst nagaan wat
   `memoryRetraction.js` nu doet bij twee even goede matches.
4. **Test-DB-afdwinging** controleren (alleen lezen, geen code).

**Niet in dit voorstel:** child-process-supervisor, `LISTEN/NOTIFY` in plaats van
`setInterval` (de scans in `beliefFormationScan.js` en `kairos/runtime.js` zijn
niet snel genoeg om dat te rechtvaardigen), en een shell-runner (hoort bij de
desktop-client en is hier niet na te gaan).

## 4. Voorbehouden

- De Logos-eval draait op een keyword-stub, geen echt model (zie `eval/README.md`).
  Een gate met vaste drempels op een stub zegt iets over de pipeline, niet over
  redeneerkwaliteit. De gate is pas betekenisvol met een echt model.
- RainBox' optimizer is in de gelezen code nog niet aan agent-gedrag gekoppeld;
  het is een patroon, geen bewezen werkende lus.
- Ik heb vijf bestanden gelezen, niet de hele repo.
