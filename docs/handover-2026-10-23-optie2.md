# Handover — optie 2: van per-beurt-hypotheses naar observaties → gedragen stellingen

Datum: 2026-10-23
Repos: `Gaia-Cloud` (server) en `gaia-desktop` (UI), beide op `main`, alles gepusht.

## Waar dit uit voortkwam

Een reviewkaart in de desktop zei *"Something speaks against this."* zonder te zeggen wát. Onderzoek wees uit dat de kaart niets kón zeggen: `evidence_for`/`evidence_against` bevatten turn-lokale ids (`hindsight-1`, `turn-2`) en de tekst erachter leefde alleen in de prompt van die ene beurt. Bewijs werd dus nooit bewaard — alleen het label.

Daarna volgde de grotere vraag: waarom ontstaan er eigenlijk 206 hypotheses in één maand, waarvan 493 van de 540 records nog `proposed` staan, 0 letterlijk herhaald worden en de reviewlijst een stapel eenmalige indrukken is. Antwoord: een hypothese werd *per beurt* gevormd uit één recall-brokje. Een overtuiging hoort op herhaalde grond te rusten. Dat is optie 2.

## Wat er nu staat (chronologisch)

| commit | repo | wat |
|---|---|---|
| `1b8d654` | gaia-desktop | De kaart toont de citaten onder "Wat hiervoor pleit / Wat ertegen pleit"; ids komen nooit in beeld. Oude records zonder tekst zeggen eerlijk "Waar dit op rust is niet bewaard gebleven". |
| `85b1ac7` | Gaia-Cloud | `evidence_items` (JSONB) in Cognition + snapshot bij schrijven; migratie `015`. |
| `d6dbe1f` | Gaia-Cloud | `observations`-tabel + routes + client; `sourceRef` en `observedAt` in elke snapshot; gedeelde snapshotvorm. Migratie `016`. |
| `61f52f8` | Gaia-Cloud | Fix: `/api/memory/search` antwoordt met een kale array, de client las `data.results` en gaf altijd leeg terug. |
| `cfaee2d` | Gaia-Cloud | `beliefFormationScan`: de enige plek die nog een stelling vormt. |
| `9ee4bd7` | Gaia-Cloud | Per-beurt-vorming uit (`formPerTurn`), `onFormed` seedt de manager. |
| `f51ebaf` | Gaia-Cloud | Fix: een eenmalige stelling wordt als **observatie** bewaard i.p.v. weggegooid; `conversationId` in de context. |
| `d9b26e9` | Gaia-Cloud | Sociale filter als modus (`GAIA_LOGOS_SOCIAL_GATE=on`), oude diepte-poort blijft default. |

## De keten zoals hij nu bedoeld is

1. Elke beurt levert (bij een diepe Logos-call) stellingen met bewijs.
2. Die worden **niet** meer als hypothese opgeslagen, maar als observatie: `statement` + snapshots (`id`, `source`, `sourceRef`, `observedAt`, `content`) + `conversation_id` + moment.
3. `beliefFormationScan` (elke 15 min) groepeert open observaties op gedeelde `sourceRef`, eist **≥2 observaties uit verschillende gesprekken**, en vormt dan één stelling met de verenigde bewijslijst. Geen modelcall: de bewoording is de nieuwste observatie.
4. Zo'n stelling start op confidence 0,75 (review-drempel), `scope: macro`, `persistence: durable`, en wordt via `onFormed` in de manager geseed zodat het model hem de volgende beurt herkent.
5. De kaart toont de stelling plus de citaten. De mens settle't.

## Deployment-stand (belangrijk)

- Migraties **015 en 016 zijn gedraaid** op de VPS (`docker compose run --rm gaia-cognition npm run migrate`), cognition en gaia-api zijn gedeployed.
- `POST /v1/banks/gaia/observations` is met de hand getest en werkt (rij met `sourceRef` kwam terug). Testrij opgeruimd.
- `[beliefs] formation pass started (every 900000ms, min 2 observations from 2 conversations)` staat in de log.
- **`observations` stond daarna op 0 rijen** — dat was de aanleiding voor `f51ebaf` (Logos' eigen `observations`-array komt leeg terug; de claims worden nu omgeleid). Of dat op de VPS al is gedeployed is niet bevestigd.
- `d9b26e9` (sociale filter) is nog niet gedeployed.
- `6ce0d1a` (walkthrough) + branch `vibe/logos-social-gate-default-8a4556`: de sociale filter is **default** geworden (`GAIA_LOGOS_SOCIAL_GATE=off` is nu de opt-out), en er is een kostenmonitor (`npm run why:logos-gate`) die deep/shallow per uur uit het decision log rapporteert.

## Wat als eerste te controleren

```bash
docker exec gaia-cognition-db psql -U gaia_cognition -d gaia_cognition -c \
"select count(*) total,
        count(*) filter (where jsonb_path_exists(evidence_items, '\$[*].sourceRef')) with_ref,
        count(distinct conversation_id) conversations,
        count(*) filter (where consumed_at is not null) consumed
   from observations;"
```

- `total` groeit na een diepe beurt → de omleiding werkt.
- `total` groeit maar `with_ref = 0` → de as is te smal, zie hieronder.
- `total = 0` en de log zegt `deep` → er gaat iets mis in de retentie; kijk naar `[gaia:observations]` in de log.

En de regel waar het om gaat: `[beliefs] formed N statement(s)`.

## Openstaand werk, in volgorde van waarde

1. **De as is smal — opgelost door recall-overlap (vibe/recall-overlap-grouping-8a4556).** `evidenceAssembler.js` gaf alleen Hindsight-items een `sourceRef`; mentale modellen, uploads, gespreksbeurten en tool-resultaten kregen `null`, dus die observaties konden nooit aggregeren. De formatie-pass verrijkt nu elke open observatie zonder `sourceRef` met **recall ground**: een recall (dezelfde cross-bank seam als de beurt, `low` budget) van de stelling, waarvan de top memory-unit ids op de observatie worden opgeslagen (`recall_ground`, migratie 017). Twee observaties wier recall ground overlappert — zelfs één gedeelde unit — zijn hetzelfde onderwerp. De merge is idempotent, dus een hertonnen pass na een halve failure convergeert. Union-find groepeert nu over `ref:` én `recall:` keys. Env: `GAIA_BELIEF_RECALL_GROUND` (default true), `..._MAX_PER_PASS` (50), `..._TOP` (5).
2. **De sociale poort is default (opgelost, `vibe/logos-social-gate-default-8a4556`).** `GAIA_LOGOS_SOCIAL_GATE=off` zet de oude diepte-poort terug als expliciete opt-out voor vergelijking. De 17 tests in `test/logos.test.js` en `test/turn.test.js` zijn herschreven: de oude politiek (skip op geen-bewijs en op intentie) is vervangen door de sociale filter, de echte semantics (information gaps, confidence bij shallow) zijn bewaakt gebleven. gaia-api 1661/1661, cognition 73/73.
3. **Kostenmonitor — gebouwd, meten loopt.** Met de sociale poort als default kost elke niet-sociale beurt een Logos-call. `npm run why:logos-gate` (`services/gaia-api/scripts/summarize-logos-gate.js`) leest het decision log (dir, file of stdin) en rapporteert per UTC-uur: turns, deep, shallow, deep% en per-reason counts — hoeveel `deep`-beslissingen per uur er echt gemaakt worden, voordat dit gejudged wordt. Nog open: een paar dagen live data verzamelen op de VPS en dan pas beslissen of de default blijft.
4. **De 166 oude `proposed` hypotheses — survey-tool gebouwd (`vibe/legacy-hypothesis-survey-8a4556`).** Ze zijn wezen van het oude model: geen bewijs-tekst (van vóór `015`) en geen observatie-herkomst, dus ze kunnen niet opnieuw gevormd worden. `npm run survey:legacy-hypotheses` (`services/gaia-api/scripts/survey-legacy-hypotheses.js`) splitst elke `proposed` hypothese in `current` (heeft `evidence_items`, nooit aangeraakt), `legacy_no_ground` (helemaal geen bewijs) en `legacy_refs_without_text` (wel for/against-ids, maar die zijn turn-lokaal en lossen niets op — de expiry-scan touched deze helft nooit, want die weigert records mét `evidence_for`). Zonder `--apply` is het een dry-run die de legacy-records print (id, datum, counts, statement-preview) om gericht te kunnen settle'n; mét `--apply` worden ze gelapsed via `POST /hypotheses/:id/expire` — `verlopen`, géén `rejected`, dus niet terminaal en reviveerbaar (`expired → testing`) als er ooit bewijs binnenkomt. Nog open: dry-run draaien op de VPS, de lijst doornemen, de waardige settle'n, dan `--apply`.
5. **Retroactief bewijs bestaat niet.** Alles van vóór `015` houdt `'[]'` en toont de eerlijke terugval. Alleen nieuw bewijs draagt tekst.

## Beslissingen met reden (niet opnieuw bediscussiëren zonder te lezen)

- **Snapshot, geen verwijzing.** `evidence_items` is een citaat van wat gewogen is, geen live pointer. Een herinnering die later verandert, verandert het besluit niet met terugwerkende kracht.
- **Relatie niet in de snapshot.** Voor/tegen blijft in `evidence_for`/`evidence_against`, benoemd door `id`. Eén bron van waarheid.
- **Observaties in Cognition, niet in Foundation.** Foundation houdt de rauwe, ongekoppelde momentopname (en de bestaande regel blijft: observatie → Foundation, nooit een Hindsight-write). Cognition houdt de gekoppelde werkset die gegroepeerd kan worden. Zonder koppeling is er niets om op te groeperen.
- **Geen modelcall in de formatie-pass.** De bewoording is de nieuwste observatie. Eén hallucinatiebron minder; een modelcall per gevormde stelling is een latere verfijning, niet per beurt.
- **De mens settle't nog steeds.** De pass maakt een stelling reviewbaar, niet waar. `confirmed` blijft mensenwerk.
- **Per-beurt-vorming uit, maar niet stil.** `GAIA_HYPOTHESIS_FORMATION=per_turn` zet het oude gedrag terug; `skippedProposals` en `observed` maken zichtbaar wat er gebeurt.

## Bestanden

- `services/cognition/src/evidenceItems.js` — één definitie van een snapshot + merge (verkiest een entry mét `sourceRef`).
- `services/cognition/src/observations.js` + `src/routes/observations.js` + migraties `015`, `016`.
- `services/gaia-api/src/reasoning/evidenceSnapshots.js` — `indexEvidence` / `snapshotsFor`.
- `services/gaia-api/src/reasoning/beliefFormationScan.js` — de pass (`runOnce`, env-drempels).
- `services/gaia-api/src/reasoning/cognitionSink.js` — `save` / `update` / `observe`.
- `services/gaia-api/src/logos/socialFilter.js` — `isSocialTurn`.
- `gaia-desktop/desktop/src/cognition/EpistemicReviewCard.jsx` — de citaten op de kaart.
- Walkthroughs: `Gaia-Cloud/walkthrough.md` (entries 2026-10-21 t/m 10-23), `gaia-desktop/walkthrough.md`.

## Env-vars die er nu toe doen

```
GAIA_HYPOTHESIS_FORMATION=per_turn   # oude per-beurt-vorming terug (default: beliefs)
GAIA_BELIEF_FORMATION=true|false     # de formatie-pass
GAIA_BELIEF_FORMATION_INTERVAL_MS    # default 900000
GAIA_BELIEF_MIN_OBSERVATIONS         # default 2
GAIA_BELIEF_MAX_AGE_DAYS             # default 14
GAIA_BELIEF_LOOKBACK                 # default 200
GAIA_BELIEF_RECALL_GROUND=true|false # recall-overlap as (default: true)
GAIA_BELIEF_RECALL_GROUND_MAX_PER_PASS  # default 50
GAIA_BELIEF_RECALL_GROUND_TOP        # default 5
GAIA_LOGOS_SOCIAL_GATE=off           # oude diepte-poort terug (default: sociale filter aan)
```
