# Gaia-Cloud — Advies: documentatie-drift en verbeteringen

> **Audit: 2026-11-11, tegen commit `5a9e1d9` (2026-11-05).** Methode: `docs/architecture.md`
> claim voor claim gelezen en tegen de code gelegd, in vier parallelle audits (geheugen/Cognition,
> Kairos/Eleos, desktop/research/turn, switches + HTTP-oppervlak). Elke bevinding hieronder heeft
> een bestand (+ regel waar ik die zelf heb nagelopen). `docs/architecture.md` is in dezelfde sessie
> herschreven naar de huidige stand; dit document is het verslag van wat daaruit kwam.

## 0. In één alinea

`docs/architecture.md` was bijgewerkt op **2026-10-16** en er zijn sindsdien **117 commits**
langsgekomen (121 sinds de laatste inhoudelijke ingreep in dat bestand). De dragende delen —
het driestore-model, de Absolute Override, de Hindsight-mirror, de turn-vorm — kloppen nog
steeds. Wat niet meer klopte: de lifecycle (een zesde status `expired` die nergens genoemd werd),
de recall-banken (per-turn recall raakt sinds 2026-10-23 bewust níet meer alle drie de banken),
de tools (verkeerde toolnaam, verkeerde grens), de deferred-keten (5 stappen in de doc, 8 + 2
in de code), de Kairos-synthesizer, de switches-tabel (7 van ~16 vlaggen) en het HTTP-oppervlak.

---

## 1. Wat niet meer klopte

| # | Claim in `architecture.md` (oud regelnummer) | Verdict | Bewijs in de code | Wat er nu staat (nieuw doc) |
| --- | --- | --- | --- | --- |
| 1 | Cognition bewaart "hypotheses, patterns, candidate models, open questions, relationships" (L18) | onvolledig | `cognition/src/hypotheses.js:36` (`KINDS`), `db/migrations/016_create_observations.sql`, `008_create_kairos_episodes.sql` | Cognition bezit óók `observations` en `kairos_episodes` |
| 2 | Capabilities zijn "Hermes, Melodiq, MCP, …" (L21) | fout | `capabilityRegistry.js` — geen `melodiq`, geen `mcp`; wel `hermes, native, research, web_search, conversation_search, hindsight, memory, memory_retraction, memory_forgetting, own_memory, foundation, desktop, tool` | echte id's opgesomd |
| 3 | desktop-capability (L26-36) | deels juist | werkt alléén op een **streamed** turn met `desktop:true` (`server.js`, `turn.js`); `open-url` is confirmatievrij (`desktopBroker.js` `SKILL_POLICY`) | beide voorwaarden en de uitzondering benoemd |
| 4 | registry "pure metadata, no routing logic" (L38-39) | deels juist | `capabilityRegistry.js` draagt `routing: true`-data, gelezen door `researchReach.js` | "data, geen logica" — één routingbeslissing in de hele codebase |
| 5 | Turn-volgorde `validate → SOUL/context prompt → gated recall → call` (L63-64) | **fout** | `turn.js`: `recallForTurn(...)` (≈L950) vóór `buildTurnPrompt(...)` (≈L977) | recall vóór prompt-assemblage |
| 6 | "Hermes is never a fallback en never the generator" (L65-66) | deels juist | `turn.js:293` `adaptHermesToGenerator(hermes)` staat er nog als primair pad; `server.js` geeft `hermes` niet mee | "in het live serverpad nooit de generator; het legacy-pad is dode code" |
| 7 | Tools: `remember`, `search_memory`, `conversation_search`, `desktop`, "at most three tool calls" (L78-81) | **fout** | `conversationTool.js:34` heet `read_back`; `memoryTool.js` heeft ook `keep`/`retract_memory`/`forget_memory`; `webSearchTool.js` `web_search`; `gaiaGenerator.js:43` `DEFAULT_MAX_TOOL_ROUNDS = 3` = 3 **rondes**, elke ronde kan meerdere calls doen | tabel met echte toolnamen + rondes-≠-calls |
| 8 | Deferred: 5 genummerde stappen (L83-93) | verouderd | `turn.js:1070-1389` nummert 1-8 + 7b (Aion) + 7c (Eleos); stap 4 = manager-apply, 5 = patroonvorming, 6 = Cognition-retentie | 8 stappen + 2 zijtaken, allemaal benoemd |
| 9 | "Per-turn recall spans all three" banken (L127-129) | **fout sinds 2026-10-23** | `server.js:193` `hindsightPassive = createCrossBankRecallClient(hindsightApp)` (alleen `bojan`); `hindsightSelf` = bojan+gaia; `gaia-logos` bewust uitgesloten; comment `server.js:185-192`; `turn.js:542-545`; `test/recallBanks.test.js` bewaakt het | recall-split expliciet, met de volledige client voor `search_memory` |
| 10 | Lifecycle-diagram (L160-164) | **onvolledig** | `migrations/013_hypothesis_expiry.sql:38` — zesde status `expired`; `hypotheses.js:39` `VERWERP_BRONNEN = ['mens','consolidatie','verlopen']`; `hypotheses.js:49-62` `VALID_TRANSITIONS` (o.a. `proposed→confirmed`, `corroborated/confirmed→testing`, `expired↔`); routes `expire`/`revive` | volledig diagram + tabel met menselijke verbs (`reopen`, `correct`, `answer`) |
| 11 | "corroborated (machine, C ≥ 0.80)" (L161) | onvolledig | `hypothesisManager.js:144` `softPromoteConfidence: 0.8` — maar `isSoftPromotable` (L176-184) eist `scope === 'micro'` én `status === 'testing'` én geen tegenbewijs | de poort volledig benoemd |
| 12 | Kairos-synthesizer "only returns a summary and an app name" (L191-193) | verouderd | `kairos/synthesizer.js` levert ook `title` (migratie `011_kairos_episode_title.sql`), plus het hogere tekenplafond voor berichtenapps (commit `6d29914`, `e95be41`) | titel + berichtenvenster-cap |
| 13 | "The trailing, still-open run is never finalized on a poll" (L186-189) | deels juist | `clusterer.js:110-117`: zodra de run langer dan het venster stil is (of 30 min haalt) wordt hij wél gefinaliseerd; `test/kairosClusterer.test.js:81` | preciezere regel |
| 14 | Switches "read in `services/gaia-api/src/server.js`" (L264-265) | deels fout | `GAIA_KAIROS_ENABLED` wordt gelezen in `kairos/runtime.js:50` | "per module, waar de module eigenaar is" |
| 15 | Switches-tabel: 7 vlaggen (L267-275) | onvolledig | ontbreken o.a. `GAIA_HYPOTHESIS_FORMATION`, `GAIA_OPEN_QUESTION_REACH`, `GAIA_HYPOTHESIS_SCAN`, `GAIA_HYPOTHESIS_EXPIRY`, `GAIA_BELIEF_FORMATION`, `GAIA_BELIEF_RECALL_GROUND`, `GAIA_LOGOS_SOCIAL_GATE`, `GAIA_NATIVE_SUPPORTS_VISION`, `GAIA_WEB_SEARCH_API_KEY`, `HINDSIGHT_RECALL_BANK_IDS`; en `GAIA_MEMORY_TOOL`/`GAIA_HYPOTHESIS_PERSISTENCE` zijn veel breder dan beschreven | 20-rij-tabel met echte default + leesplek |
| 16 | Clients-sectie (L281-293) | onvolledig | `GET /api/version` is openbaar; `/memory/*`, `/research/*`, `/conversations/events`, `/conversations/:id/export/:format`, `/kairos/episodes/:id/evidence`, de volledige `/cognition`-set en `/eleos/checkins/:id/ack` ontbreken | route-tabel per mount |
| 17 | Hindsight-reranker-config, VPS-waarden, CPU-cijfers (L136-156, L205-210) | **niet verifieerbaar uit de repo** | geen `HINDSIGHT_API_RERANKER_*`/`enable_reranking`-symbool in git; doc zegt het zelf ("not in git") | verplaatst naar *deployment*; in het nieuwe doc als zodanig gemarkeerd |
| 18 | "Gaia-Web completed its move onto gaia-api" (L7-9) | niet verifieerbaar hier | claim over de Gaia-Web-repo | als externe claim gemarkeerd |

**Niet fout maar wel stil:** vier plekken in de code beweren het tegenovergestelde van wat de code doet (zie C5).

---

## 2. Waarom dit kon gebeuren

1. **Geen verificatie-anker.** Het document noemt nergens tegen welke commit het klopt, dus
   niemand merkt dat het veroudert — het leest nog even zelfverzekerd.
2. **Documentatie zit niet in het deploy-/testpad.** `deploy.yml` filtert op
   `services/gaia-api/**`, `services/cognition/**` en de workflow zelf. Een docs-only push
   bouwt en test niets, dus drift in `docs/` heeft geen enkele signaalfunctie.
3. **Twee soorten waarheid in één bestand.** Code-waarheid (welke route, welke status) en
   deployment-waarheid (VPS-paden, Hindsight-banksettings, gemeten latenties) staan door
   elkaar. De tweede soort kan dit repo niet bevestigen en veroudert harder.
4. **De geschiedenis is vertakt.** `evolution.md` stopt op 2026-10-14, `walkthrough.md` (1043
   regels) is de echte chronologie, `walkthrough2.md` is de lopende. Drie documenten vertellen
   hetzelfde verhaal op drie verschillende peilen.
5. **`architecture-graph.md` loopt mee achter.** De deferred-tekening heeft daar nog 4 stappen
   (regel 73-76) — dezelfde fout als punt 8, in het visuele document dat mensen eerder lezen
   dan de prose.
6. **De docs zijn deels runtime-inhoud.** Vijf van de documenten zijn onderdeel van een artifact
   dat clients pullen en gaia-api inbakt (zie C12), en dat artifact faalt hard als één van die
   vijf ontbreekt. Een docs-wijziging is hier dus een codewijziging, en een docs-opruiming een
   build-failure.

---

## 3. Adviezen — het documentatieproces

| | Advies | Waarom | Inspanning |
| --- | --- | --- | --- |
| **A1** | Houd de **"Verified against code: commit `<sha>`"**-regel bovenaan `architecture.md` bij (staat er nu) en werk hem bij elke ingreep bij. | Eén regel die veroudering zichtbaar maakt. | 1 min per wijziging |
| **A2** | Voeg een **`scripts/verify-architecture.js`** toe: grep op ankers (paden, routenamen, toolnamen, vlaggen, statuswaarden, tag-namen) en faal op alles wat verdwenen is. Draai het in de CI, en voeg `docs/**` toe aan de `pull_request`-paths van `deploy.yml` (of een eigen docs-job). | Drift wordt een rode build in plaats van een verrassing maanden later. Het script is ~80 regels, geen dependencies, en de ankers staan al in het nieuwe doc. | 1-2 uur |
| **A3** | Splits **`docs/deployment.md`** af: VPS-paden, Tailscale-adressen, container-/netwerknamen, `/opt/hindsight/.env`, `HINDSIGHT_TIMEOUT_MS=8000`, de reranker-chain, gemeten cijfers. Laat `architecture.md` ernaar verwijzen. | Dan kan de architectuur code-waarheid blijven en hoeft de VPS-waarheid niet in git te staan om toch vindbaar te zijn. | 1 uur |
| **A4** | Regenereer `docs/architecture-graph.md` (of zet er een verwijzing neer). | De visuele versie is nu misleidender dan geen versie: 4 stappen, geen Aion/Eleos, geen `/memory`, `/eleos`, `/research`. | 1-2 uur |
| **A5** | Kies voor `evolution.md`: bijwerken **of** expliciet bevriezen met een regel ("historie tot 2026-10-14; daarna `walkthrough*.md`"). Ook daar staat de lifecycle nog met vier statussen. | Half-bijgehouden geschiedenis is erger dan een duidelijk afgesloten boek. | 15 min. **Uitgevoerd 2026-11-11:** bevroren — frontmatter `status: frozen` + `frozen_at`, een regel bovenaan het document, en beide verwijzingen in `README.md` zeggen het nu ook. |
| **A6** | Herschrijf het *Status*-blok in `README.md`: het verwijst naar een Switches-tabel met vier flags; het zijn er inmiddels ~16 gedragsvlaggen + presence-gates. | De README is het eerste wat iemand leest. | 10 min |
| **A7** | Schrijf de walkthrough-afspraak op (`>1000 regels` → nieuw bestand, chronologisch, oudste bovenaan, Findings/Conclusions/Actions) in bv. `docs/CONVENTIONS.md`. | De afspraak bestaat nu alleen in de praktijk; `walkthrough.md` zit op 1043 regels. | 15 min |
| **A8** | Voeg `docs/README.md` toe als index met per document een statusregel (actief/bevroren + verified-against). | Vijf documenten beschrijven nu overlappende delen van hetzelfde systeem zonder eigenaarschap. | 30 min |

---

## 4. Adviezen — de code (op risico)

| | Bevinding | Risico | Advies |
| --- | --- | --- | --- |
| **C1** | `services/cognition/data/` (de Postgres-datadir die `services/cognition/docker-compose.yml` mount) is **nergens** in `.gitignore` opgenomen; `services/gaia-api/.gitignore` heeft wél `data/`. | Eén `git add -A` na een lokale `docker compose up` commit een compleet databasecluster in een publieke repo. | `data/` toevoegen aan `services/cognition/.gitignore` (of één regel in de root). 2 min. |
| **C2** | De netwerknaam van de Cognition-stack is **tegenstrijdig binnen één bestand**: `services/gaia-api/docker-compose.yml` zegt bij de service "project *gaia-cognition*, dus netwerk `gaia-cognition_default`" en in de netwerksectie "project *cognition*, netwerk `cognition_gaia_cognition_default`" (`name:` op regel 56). `deploy.yml:121` herhaalt de eerste lezing. | Een verkeerde `name:` laat de deploy falen op "network not found" — of, erger, laat gaia-api op een oud netwerk naar een verkeerde `COGNITION_URL` kijken. | Pin de projectnaam expliciet met een top-level `name: gaia-cognition` in `services/cognition/docker-compose.yml`, zet de daaruit volgende netwerknaam in gaia-api, en verifieer één keer met `docker network ls | grep -i cognition` op de VPS. 30 min. |
| **C3** | `GET /admin` (de HTML-shell) is **ongeauthenticeerd** en `/admin/api/*` gebruikt hetzelfde Bearer-token als clients. | De operatorpagina — inclusief provider-config, key-hints en modelkeuzes — is op de tailnet voor iedereen met het client-token (of zonder token, de pagina zelf) bereikbaar. | Geef de adminroutes een eigen operator-token (`GAIA_ADMIN_TOKEN`) of zet minimaal `auth` op de pagina-route. 30 min. |
| **C4** | Vlag-idioom is inconsistent: `GAIA_HYPOTHESIS_SCAN`, `GAIA_HYPOTHESIS_EXPIRY` en `GAIA_BELIEF_FORMATION` gaan **uit** bij élke waarde die niet exact `'true'` is (`(env.X \|\| 'true') !== 'true'`), terwijl `GAIA_OPEN_QUESTION_REACH` en `GAIA_RESEARCH_REACH` alleen `'on'` accepteren en `GAIA_DESKTOP`/`GAIA_ELEOS` alleen `'true'`. | `GAIA_HYPOTHESIS_EXPIRY=on` of `=1` zet de pas **stil** uit; `GAIA_RESEARCH_REACH=true` zet research stil uit. Dat is precies het soort fout dat je pas weken later ziet aan een lege store. | Eén helper (`flag(env, 'GAIA_X', { default: true, truthy: ['true','on','1'] })`) en alle lezers daarop; documenteer per vlag de default in één tabel (staat nu in `architecture.md`). Half dag. |
| **C5** | Vier comments beschrijven het tegenovergestelde van de code: `services/gaia-api/src/server.js:810` ("v3.0: no live tools … nothing routes to a tool" — er zijn vijf tools), `db/migrations/003_derived_lifecycle_v3.sql:7` en `008_create_kairos_episodes.sql:10` (`['chronicle:<id>']` terwijl de code `foundation:<uuid>` schrijft, `foundationRef.js:28`), `services/gaia-api/.env.example` ("the write path is not built yet" voor de `gaia`-bank, terwijl `reasoning/aion.js` én de `keep`-tool daar schrijven), en `services/cognition/package.json` (description met vier statussen). | Een comment die liegt kost bij elke volgende lezer een half uur. | Vier kleine tekstfixes. 15 min. |
| **C6** | Twee migraties heten `010_…`: `010_hypothesis_correction.sql` en `010_normalize_sources_prefix.sql`. `db/migrate.js` sorteert op bestandsnaam, dus de volgorde is nu toevallig deterministisch (`h` vóór `n`). | Een nieuwe `010_*` of een rename kan de volgorde stil veranderen; `schema_migrations` registreert per bestandsnaam, dus een hernoeming voert de migratie opnieuw uit. | Hernummer naar `010`/`018` (of geef elke nieuwe migratie een uniek oplopend nummer en noteer de regel in `CONVENTIONS.md`). 10 min. |
| **C7** | De negen achtergrondpassen (soft-promotie, expiry, belief formation, Aion, Kairos-worker, research-poll, Eleos-tick, Logos-depth, sync) hebben **geen enkel statusoppervlak**; alleen de Logos-beslissingen hebben `GET /admin/api/logos/decisions`. | "Staat de expiry-pass uit, of is er niets verlopen?" is nu alleen via de env te beantwoorden. Bij een stille pass merk je niets. | Voeg `GET /admin/api/scans` toe: per pass `{ enabled, lastRunAt, lastCounts, lastError }`. De passen hebben die data al (ze loggen en tellen). Half dag. |
| **C8** | `test/recallBanks.test.js` bewaakt de bankregel met **regex op de brontekst** van `server.js`/`turn.js`. | Een onschuldige herformattering breekt de test (fout-positief), terwijl een echte gedragsverandering via een andere constructie er juist doorheen glipt (fout-negatief). | Vervang (of vul aan) met een gedragstest op `recallForTurn` met een fake cross-bank client die registreert welke banken bevraagd worden. 1 uur. |
| **C9** | Capability-id `conversation_search` en toolnaam `read_back` dekken hetzelfde ding zonder enige vastgelegde mapping. | Elke nieuwe lezer (of client-auteur) leest de architectuurdoc als fout. | Comment in `capabilityRegistry.js` bij `conversation_search`: "the tool behind this capability is `read_back`". 5 min. |
| **C10** | `.emergent/` (platform-scaffolding, cron-dispatch) en `proxy/` staan in de repo zonder plek in de architectuur; de cron-scripts verwijzen naar een Emergent-platform dat geen rol meer speelt. | Dode scaffolding kost ruimte en verwarring; `proxy/` is wél echt (nginx-token-injectie voor hermes-agent). | `proxy/` opnemen in `architecture.md` (staat er nu kort in) en `.emergent/` documenteren of verwijderen. 20 min. |
| **C11** | Van de 11 scripts in `services/gaia-api/scripts/` staan er 3 in `package.json` (`reconcile:hindsight`, `why:recall`, `why:logos-gate`). De rest (`validate-memory-worthiness`, `validate-pattern-awareness`, `summarize-turn-timing`, `_scan-mojibake`, `provision-*`, `migrate-knowledge-pages-*`) is onontdekt. | Operationeel gereedschap dat niemand vindt, wordt niet gebruikt — en `_scan-mojibake` suggereert dat er ooit een encoding-probleem was dat niemand nu nog kan reproduceren. | `services/gaia-api/scripts/README.md` met per script doel, wanneer te draaien, en of het idempotent is. 30 min. |
| **C12** | Vijf documenten zijn **load-bearing runtime-inhoud**, geen documentatie. `scripts/build-foundation-artifact.js` bundelt `soul.md`, `principles.md`, `lexicon.md`, `architecture.md` en `evolution.md` tot `foundation-artifact.json`; `publish-foundation.yml` publiceert dat als release `foundation-latest` (en triggert daarmee een Gaia-Web-rebuild), en `deploy.yml` materialiseert het in `services/gaia-api/` zodat de container het inbakt. `src/foundation.js` kiest per turn een set op basis van de laatste drie user-berichten: `technical` → soul+principles+lexicon+**architecture.md**; `gaia` ("wie ben je", "hoe denk je", "evolutie") → soul+principles+lexicon+**evolution.md**; anders alleen de eerste drie. | Een docs-opruiming is hier geen opruiming: `cef92c1` ("docs", 2026-11-11) verwijderde de mapinhoud en liet `publish-foundation` meteen falen — `Error: Could not find document at .../docs/principles.md` (run `42942613195`); pas de revert `fc25ee4` zette het goed. En elke `docs/**`-wijziging verandert de tekst die Gaia als eigen constitutie leest én de promptgrootte op die turns (`evolution.md` 130 kB; `architecture.md` nu 31 kB i.p.v. 18 kB). | Verwijder nooit één van die vijf los van `DOCUMENTS` in `build-foundation-artifact.js`, en behandel een docs-wijziging als een codewijziging: artifact herbouwen, de betreffende turn-soort nalopen. Zet de bundel-lijst en de selectieregels in `architecture.md` — nu staan ze alleen in `foundation.js` en de comment in het buildscript. 10 min (workflow-guard), 1 uur (documenteren). |

---

## 5. Quick wins vs. groter werk

**Vandaag te doen (< 1 uur totaal):** C1 (gitignore), C5 (vier comments), C6 (migratienummer),
A6 (README-statusblok), C9 (registry-comment), A5 (evolution bevriezen of bijwerken).

**Een halve dag:** C4 (vlag-helper), C7 (`/admin/api/scans`), C2 (netwerknaam pinnen en op de
VPS verifiëren), C3 (operator-token).

**Een dag of meer:** A2 (`verify-architecture.js` + CI-hook), A3 (`deployment.md` splitsen),
A4 (graph regenereren), C8 (gedragstest voor de bankregel), C10/C11 (opruimen + scriptdocs).

**Volgorde die ik zou kiezen:** C1 → C5 → A2 → C4 → C2 → C7 → C3. C1 is een dataveiligheidsgat,
C5 maakt elke volgende lezing goedkoper, A2 voorkomt dat dit advies over drie weken zelf
verouderd is.

---

## 6. Wat er nu ligt, en hoe je het controleert

- **`docs/architecture.md`** — herschreven naar de stand van `5a9e1d9`: gecorrigeerde
  lifecycle (6 statussen), de recall-split, de echte tools en hun grenzen, de 8-staps
  deferred-keten, een volledige switches-tabel met echte defaults en leesplekken, de
  route-inventaris, en een expliciete scheiding tussen code-waarheid en
  *(external)*/*(deployment)*.
- **`docs/advice.md`** — dit document.
- Controle: `git diff fedc3c6 -- docs/architecture.md` voor de wijziging zelf; `git show
  5a9e1d9 --stat` voor de stand; `cd services/gaia-api && npm test` en
  `cd services/cognition && npm test` voor de suites waartegen ik gelezen heb.

**Openstaande beslissingen voor jou** (ik heb hier niets over doorgevoerd):

1. Waar landen deze twee bestanden — branch + PR, of direct op `main`?
2. Splitsen we `docs/deployment.md` af (A3), of blijft de VPS-waarheid in `architecture.md`?
3. Krijgt `/admin` een eigen operator-token (C3), of bewust niet omdat de API al
   tailnet-only is?
