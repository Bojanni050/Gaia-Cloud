# Zich een vaardigheid toe-eigenen

Wat Gaia zelf mag leren, en waarom de grens daar ligt.

## De vraag, en de drie dingen die eronder liggen

"Ze mag zich skills toe-eigenen als ze die nodig heeft, en ze verbeteren." Dat
klinkt als één wens, maar het zijn drie verschillende dingen met een heel
verschillend risico:

1. **Ontdekken wat ze mist.** Ze loopt vast, zegt "dat kan ik niet", of een tool
   geeft een weigering terug. Dat verdampte tot nu toe: de beurt eindigde in een
   afwijzing en er bleef geen spoor achter, dus dezelfde leemte kon elke week
   opnieuw worden geraakt zonder ooit zichtbaar te worden.
2. **Samenstellen.** Een nieuwe vaardigheid als geordend recept over primitieven
   die er al zijn: `web_search` → `file-write`, `file-search` → `open-url`,
   `hindsight.recall` → `hermes` → `write`.
3. **Schrijven.** Ze genereert code die op de machine van de persoon draait.

## De grens die we gekozen hebben

**Alleen samenstellen.** Geen door het model geschreven code die zelfstandig
uitvoert.

De reden is niet voorzichtigheid om de voorzichtigheid. Het is dit: de
mogelijkheden van een client zijn eindig en liggen bij de client. Gaia kan geen
nieuwe Tauri-command verzinnen, geen nieuwe Desktop Commander-tool, geen nieuw
protocol. Wat ze zich kan toe-eigenen is dus altijd **een nieuwe combinatie van
wat er al is** — en dat is precies de laag die nu handwerk is: elke samenstelling
van drie bestaande stappen moet door een mens in code worden geschreven.

De tweede reden is de aanvalsoppervlakte. Een vaardigheid die het model zelf
schrijft en zelf draait, is de kortste route van "een alinea op een webpagina" naar
"code op jouw schijf". Zolang samenstellen de grens is, kan een kwaadwillende
pagina hooguit een *voorstel* beïnvloeden dat een mens beoordeelt — niet iets
laten uitvoeren.

## De fases

Elke fase levert het bewijs voor de volgende. Niets wordt overgeslagen.

### Fase 0 — het gat zichtbaar maken (gebouwd)

`src/skillGap.js`, één record per moment dat een beurt iets vroeg dat er niet
was (`kind: 'skill.gap'`, in dezelfde decision log als `tool.call`).

Vier redenen, en het onderscheid is de moeite:

| reason | wat het betekent |
|---|---|
| `unknown-tool` | ze vroeg om een tool die niet bestaat (`open_website`) — dit is de sterkste aanwijzing voor een ontbrekende vaardigheid, want ze heeft zelf een naam bedacht voor wat ze wilde |
| `unknown-skill` | een desktop-skill die niet in het register staat (`send-email`) |
| `not-carried` | een echte skill die deze machine niet kan uitvoeren (wel in het register, geen executor aan de clientkant) |
| `not-configured` | een bestaande tool die deze beurt niet was aangemeld — een bedradingsvraag, geen ontbrekende vaardigheid |

Een gewone fout is **geen** gat: een tool die kapot is vraagt niet om een nieuwe
vaardigheid. Daarom telt alleen de vier vaste weigerzinnen hierboven.

De records zijn inhoudsloos, zoals `tool.call` en `recall.measure`: tool,
capability, skill, reden, gesprek, ronde. Geen prompt, geen gebruikerswoorden,
geen argumenten. `skill` overleeft alleen als het op een registertoken lijkt —
een model kan in dat veld van alles zetten en een pagina kan het model van alles
laten zeggen, dus een zin landt hier nooit.

### Fase 1 — de formatie-pass (nog niet gebouwd)

`skillFormationScan`, naar het model van `beliefFormationScan`:

- groepeer open gap-records per `skill` of per `capability`;
- eis herhaling over **meerdere gesprekken** — één keer iets missen is geen
  vaardigheid, net zoals één observatie geen stelling is;
- eis dat het voorgestelde recept **alleen bestaande primitieven** gebruikt, en
  dat elke stap een skill is die het register kent (`validateCapabilitySkill`);
- resultaat is een **voorstel**, geen actieve vaardigheid: dezelfde reviewkaart
  die de hypotheses al gebruiken, en de mens settle't.

Drempels horen env-instelbaar te zijn, met dezelfde vorm als de belief-pass
(`..._MIN_GAPS`, `..._LOOKBACK_DAYS`, `..._INTERVAL_MS`).

### Fase 2 — de recept-uitvoerder (nog niet gebouwd)

Eén generieke executor die een goedgekeurd recept stapsgewijs draait, met per
stap het bestaande beleid (`auto` / `confirm`), de bestaande time-outs,
output-caps en action frames van `desktopBroker.js`. Geen nieuwe code, geen nieuw
recht: een recept is een herinnering aan een volgorde, niet een nieuwe macht.

Hier wordt het pas nuttig, en hier hoort ook de grens: een recept heeft een
maximum aantal stappen en een maximum totaal tijd, anders kan een verkeerd
recept de beurt laten rondtollen.

### Fase 3 — verbeteren (nog niet gebouwd)

Een vaardigheid heeft een versie en een meetbaar succespercentage uit
`tool.call` (`outcome: answered | empty | failed`). Zakt het, dan komt er een
**voorstel** tot herziening — betere beschrijving, andere stapvolgorde, extra
stap — en geen stille zelfaanpassing. Bewijs draagt, niet het voorstel.

## Wat hier expliciet niet in zit

- **Geen dynamisch register voordat fase 0 en 1 staan.** Een groeiende lijst
  halfwerkende vaardigheden waarvan niemand weet of ze ooit iets oplossen is
  hetzelfde patroon als 540 hypotheses waarvan 493 `proposed`.
- **Geen goedkeuring die geen voorstel is.** De mens keurt; de pass stelt voor.
- **Geen retroactief gat.** Net als bij bewijs begint de log leeg: wat vóór
  fase 0 is misgegaan, is niet te reconstrueren zonder de gesprekken opnieuw te
  interpreteren, en dat is duurder en onbetrouwbaarder dan opnieuw meten.

## Waar het aanhaakt

- `src/skillGap.js` — het vocabulaire en het record (fase 0).
- `src/generation/gaiaGenerator.js` — `appendToolRound` logt het gat naast
  `tool.call`, want daar komt het resultaat terug en daar is de gevraagde skill
  bekend (uit de argumenten van de `desktop`-tool).
- `src/capabilityRegistry.js` — blijft voorlopig de bron van wat bestaat.
- `src/capabilityAwareness.js` — toont per beurt wat ze echt heeft; een
  goedgekeurde vaardigheid hoort daar later bij te komen.
- `src/desktopBroker.js` — de machinerie die fase 2 hergebruikt.
