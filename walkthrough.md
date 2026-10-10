## 2026-10-04 (Quarantaine & reopen: rejected hard terminaal, alleen menselijke heropening)

- Findings: De quarantaine na afwijzing was inconsistent. De in-memory `HypothesisManager` stond `rejected → testing` toe via `evaluateTransition` en liet `applyUpdate`/`applyReasoningResult` een rejected record gewoon door muteren, terwijl de `CognitionStore` `rejected` al terminaal hield (`VALID_TRANSITIONS.rejected = []`, `applyEvidence` gooit). De V3-bron eist dat `rejected` voor álle automatische processen terminaal is en dat heropening uitsluitend een expliciete, door de mens geïnitieerde actie is.
- Conclusions: `rejected` is nu een harde quarantaine in beide lagen. Automatische paden (evidence-updates, reasoning-output, persistence, lifecycle-verbs) weigeren een rejected record; alleen een expliciete reopen met verplichte reden verlaat de quarantaine. Zo blijft de menselijke afwijzing staan tot de gebruiker die zelf herroept, en kan een oude aanname nooit stilzwijgend terugkeren — ook niet via een latere, anders geformuleerde re-propose.
- Actions: `services/gaia-api/src/reasoning/hypothesisManager.js` (`TRANSITIONS.rejected = []`, nieuwe `reopen()`, quarantaine-guards in `applyUpdate`/`applyReasoningResult`/`setPersistence`); `services/gaia-api/src/reasoning/cognitionSink.js` (rejected→testing mapt naar `reopenHypothesis`, niet `markTesting`); `services/cognition/src/hypotheses.js` + `src/routes/hypotheses.js` (`reopen()`, `POST /:id/reopen`, reden verplicht); `services/gaia-api/src/cognitionClient.js` + `src/cognitionRoutes.js` (reopen-route, 400 zonder reden); `eval/hypothesis-cases.json` + `eval/run-hypothesis.js` (rejected-terminaal + reopen-cases); tests bijgewerkt; README's en module-headers bijgewerkt; validated — gaia-api 1144/1144, cognition 40/40, `eval:hypothesis` 16/16.

## 2026-10-04 (Kairos — episodesynthese & SSE-pijplijn)

- Findings: De Kairos-specificatie beschrijft een volledige episode-pijplijn (ruwe observaties → narratieve episode → realtime SSE), maar veronderstelt een `services/chronicle` op poort 7331 en een `services/kairos` die in deze repo allebei niet bestaan. Onderzoek in de lokale `Foundation`- en `capture-rs`-clones wees uit dat de ruwe stroom al leesbaar is via het bestaande `GET /api/memory/episodes?since=` (het watermerk-idioom van Foundation's eigen `hypothesisReflectionSync.js`), maar dat `app_name`/`window_title` de brug naar de `episode`-rij niet overleven: ze blijven op `ingest_object`. Ook bleek Foundation het woord "episode" al te bezetten voor de *rauwe* observatie, terwijl de spec er de *synthese* mee aanduidt.
- Conclusions: Hybride plaatsing, in lijn met de huisregels — Cognition bewaart (pure store), Logos/gaia-api redeneert, clients praten alleen met gaia-api. Het artefact heet ondubbelzinnig `kairos_episode` (voorkomt botsing met Foundation's rauwe `episode`). De synthese-satelliet is een kiesbare Main-Provider-rol `kairos` in admin, net als Reasoning/Vision. Twee ontwerp-fixes t.o.v. de spec-scaffold: (1) alleen *gesloten* clusters worden gefinaliseerd, zodat een open run doorgroeit i.p.v. te versnipperen; (2) de watermark schuift alleen op over aaneengesloten geslaagde clusters — een falende cluster stopt de batch en verzet de cursor niet, zodat observaties nooit stilzwijgend verdwijnen. Deterministische ids maken herverwerking idempotent (upsert, geen duplicaten).
- Actions: `Foundation/server/observedApp.js` (pure app/venster-mapper) + `observedApp.test.js`; `Foundation/server/routes/memory.js` (`GET /api/memory/episodes` additieve, opt-in `with_source=1` LEFT JOIN op `ingest_object`, bestaande consumenten ongewijzigd); `services/cognition/src/db/migrations/008_create_kairos_episodes.sql` + `009_kairos_state.sql`; `services/cognition/src/kairosEpisodes.js` + `src/routes/episodes.js` (create-upsert, paged list, state) + `src/server.js` (mount) + `test/kairosEpisodes.test.js`; `services/gaia-api/src/kairos/{types,clusterer,synthesizer,worker,emitter,runtime}.js`; `src/kairosRoutes.js` (`GET /kairos/episodes`, `/stream` SSE, `/:id/evidence`); `src/foundationClient.js` (`listObservationsSince`, `fetchIngestObjects`); `src/cognitionClient.js` (episode-verbs + state); `src/reasoning/cognitionSync.js` (`gaia:kairos_episode`-spiegeling, versioned `gaia-kep-{id}-v{N}`); provider-rol `kairos` in `src/providerStore.js`, `src/adminRoutes.js`, `src/providerConfigResolver.js` (+ env-fallback `KAIROS_MODEL_*`, capabilities); `src/server.js` (worker achter `GAIA_KAIROS_ENABLED`, mount van `/kairos`); `public/admin.html` (Kairos-rolkaart, rol-agnostische `saveLogosRole`); tests `kairosClusterer`, `kairosSynthesizer`, `kairosWorker`, `kairosRoutes`, `kairosSync` + bijgewerkte provider/admin-tests; docs: `services/cognition/README.md`, `docs/architecture.md` (Kairos-sectie), `.env.example`; validated — gaia-api 1184/1184, cognition 49/49, Foundation 19/19 testbestanden.

## 2026-10-05 (Kairos-worker gedocumenteerd)

- Findings: De Kairos-worker stond alleen in `.env.example` en als env-regel in `architecture.md`; er was geen plek die hem als systeem beschrijft (aanzetten, modelrol, watermark-semantiek, endpoints). Wie hem zocht zou concluderen dat er niets draait — precies het "staat uit en dan zie je niks"-gat.
- Conclusions: De worker hoort thuis in de gaia-api-README (het contract-document van de service die hem bezit), in dezelfde sectiestijl als Logos/Cognition. De operator-kant (aanzetten + modelrol kiezen) hoort in `operations.md` van de Gaia-Documentation-repo, dat expliciet zegt dat een stale entry een defect is — de rollenlijst daar noemde alleen generation/reasoning/vision.
- Actions: `services/gaia-api/README.md` (nieuwe sectie "Kairos — episode synthesizer & realtime stream": opt-in, pipeline, burst-safe watermark, `/kairos/*`-contract, opt-in-tabel); `Gaia-Documentation/operations.md` (rollenlijst + generation/reasoning/vision/**kairos**, nieuwe sectie "Kairos worker" met de twee aanzet-vereisten en de LLM-call-log-trace); geverifieerd tegen de code — env-namen, 30000ms-default en `purpose: kairos.synthesis` kloppen; validated — docs-only, geen tests geraakt. Let op: de Gaia-Documentation-repo had al een grote, ongerelateerde herstructurering openstaan; die edit is daar bewust niet meegecommit.

## 2026-10-05 (Soft evidence getoetst; twee ontwerpbesluiten vastgelegd)

- Findings: Een aangeleverd transcript ("soft evidence building", `C(t+1) = C(t) + α(1−C(t))·score`, "cap op 80%") bleek grotendeels niet te kloppen met de code. Wat wél bestaat: het mens-only `confirmed` (Absolute Override), de verplichte anti-lexicografische tegenhypothese die een confirmatie blokkeert, de 0.80-**drempel** voor machine-soft-promotie naar `corroborated`, en de rationale-frictie voor macro-statements. Wat níet bestaat: de recurrente formule (de code doet een lineaire `confidence + confidenceDelta`), een cap op 80% (de clamp is **0.95**, soul.md's "never claim certainty"), en "Chronicle als ruwe store" (dat is **Foundation**; Chronicle is de capture-client). Alle zes brontranscripties in de Gaia-Documentation-repo herhalen dezelfde fouten.
- Conclusions: Confidence blijft lineair — de transcript-formule is een schatter van een herhaald proces terwijl onze input schaars, model-beoordeeld bewijs is, en de eenzijdige variant kan niet verzwakken/tegenspreken. Een soft-evidence-accumulator wordt hooguit later en **alleen voor `micro`** toegevoegd, in de symmetrische vorm `C ← C + α·(target − C)`, en pas als er een echte observatiestroom bestaat (nu niet). Daarnaast een reëel gat geïdentificeerd: de bestaande bescherming grijpt ná de hypothesevorming, terwijl wélke hypotheses een model vormt al een filter is — relevant omdat het LLM vervangbaar is; voorgesteld om afgeleide records te stempelen met de vormende provider/model en vormkenmerken (scope, tegenhypothese, evidence-balans, confidence-verdeling) over een modelwissel te vergelijken, als observability-signaal en zonder LLM in de meetstap.
- Actions: Geen codewijziging in deze repo — docs/onderzoek. Uitgevoerd buiten de code: de memory-correctie van de misgelabelde Hindsight-pagina (titel "Mandatory counter-hypothesis…" bevatte Kairos-inhoud); twee besluiten + het genoteerde ITM-idee in Hindsight geïngest; voorstellen in `~/.opencode/plan/` (`soft-evidence-micro-accumulator-voorstel.md`, `bias-inferentie-providerwissel-voorstel.md`); `opencode-parser`-plugin globaal geïnstalleerd (V2-sleutel `plugins`, Hindsight-plugin op de V1-sleutel `plugin` bleef ongemoeid); de Gaia-Documentation-repo afgemaakt en opgeschoond (documenten/proposals/sources/archief gescheiden, één versie per bestand, nul duplicaten, alle links geldig, gepusht). validated — geen tests geraakt; alle beweringen tegen de code geverifieerd.

## 2026-10-05 (Hermes-container hersteld; versie gepind op v0.21.5 + proxy-token gelijkgetrokken)

- Findings: Een mislukte Hermes-update liet de `hermes`-container verdwijnen op de Contabo-VPS (`/root/hermes-agent`, een losse docker-compose-install van `nousresearch/hermes-agent`, data als bind-mount op `/opt/data`). Image en data waren intact, alleen de container ontbrak; Hermes' eigen log meldde dat de vorige gateway "UNCLEANLY" was gestopt (SIGKILL/proces-kill) en dat `hermes update` in-container niet werkt bij een docker-install. Daarnaast bleek het `HERMES_AUTH_TOKEN` in `/root/gaia/proxy/.env` niet meer te matchen met `API_SERVER_KEY` (en `gaia-api/.env`) — een scheve rotatie.
- Conclusions: Herstellen betekent de container opnieuw aanmaken, niet updaten: `:latest` op de registry is identiek aan de draaiende image (v0.21.5 / 2026.9.24, digest `d4da4a40…`), dus er is sinds 24 sep geen nieuwe stabiele release — de enige nieuwere build is de rolling `:main`, geen release. Omdat v0.21.5 vereist is, is de compose bewust van `:latest` gepind op die exacte digest, zodat een `compose pull` de draaiende versie niet meer kan wegtrekken. De proxy draait los (geen compose) en leest de token bij aanmaak, dus die is hercreëerd i.p.v. gerestart.
- Actions: Server-side, niet in git — `/root/hermes-agent/docker-compose.yml` image gepind op `nousresearch/hermes-agent@sha256:d4da4a40cd7a28aba983775d9fd31d94cbf153eeb0cb9e844d6d0f612b7c24db` (`.bak-20261005-v0.21.5` bewaard); `/root/gaia/proxy/.env` token gelijkgetrokken (`.env.bak-20261005`); `gaia-hermes-proxy` hercreëerd op `gaia_net` + `hermes-agent_default` (`127.0.0.1:8643:80`, `restart unless-stopped`, template-mount read-only); de oude image ook getagd als `nousresearch/hermes-agent:rollback-20261005`. Geverifieerd — Hermes draait v0.21.5, `gaia-api → hermes` én `proxy → hermes` geven de modellenlijst, `/opt/data` onaangeroerd. Noot: `https://higaia.nl/api/hermes/…` geeft bewust de SPA-index (web praat via `/api/gaia/`); de proxy is legacy en zit niet in het live pad.

## 2026-10-06 (Hindsight-banken gesplitst: Gaia's eigen bank vs Logosbank)

- Findings: gaia-api gebruikte één Hindsight-client (`HINDSIGHT_BANK_ID`, default `bojan`) voor twee heel verschillende dingen: Gaia's eigen geheugen (gespreksreflecties, mental models) én de Logos/Cognition-mirror (hypotheses, patterns, Kairos-episodes, de `gaia:*`-units). Daardoor vermengde afgeleide kennis zich met Gaia's eigen memory in Bo's persoonlijke `bojan`-bank. De `gaia`-bank bestond al (Gaia's eigen memory, 15–19 aug) maar werd niet meer gebruikt; `memory/PRD.md` en `docs/evolution.md` beschrijven `gaia` juist als Gaia's eigen, niet-gedeelde bank, terwijl `.env.example` `bojan` als bewuste keuze documenteerde — een drift.
- Conclusions: de routes splitsen in drie banken. `bojan` blijft de systeem-geheugenbank: de memoryworthiness-gated gespreksreflectie schrijft daar ongewijzigd naartoe (de gate zit in turn.js) — dat blijft zo. `gaia` is Gaia's eigen bank — haar herinneringen, haar menselijke kant; van haar alleen, géén gate, gereserveerd voor haar eigen curatie (het schrijfpad is nog niet gebouwd, dus vandaag recall-only). De Logos/Cognition-mirror schrijft naar een nieuwe, aparte **`gaia-logos`**-bank (`HINDSIGHT_LOGOS_BANK_ID`). Recall spant de hele set — `bojan` + `gaia-logos` + `gaia` — anders ziet Gaia haar eigen hypotheses of haar eigen herinneringen niet terug: een samengestelde client (`createCrossBankRecallClient`) fan-out `recall` naar elke bank en merget op relevance-score, met per-bank best-effort falen. Alle niet-recall-methoden (reflect, mental models, knowledge pages) blijven op de primaire bank (`bojan`).
- Actions: nieuwe Hindsight-bank `gaia-logos` aangemaakt (PUT `/v1/default/banks/gaia-logos`, reflect-mission voor afgeleide kennis); `services/gaia-api/src/hindsightClient.js` (`createCrossBankRecallClient` + export); `services/gaia-api/src/server.js` (clients `hindsightApp`=`bojan` + `hindsightLogos`, recall-set uit `HINDSIGHT_RECALL_BANK_IDS` default `bojan,gaia-logos,gaia`, samengestelde `hindsight`, `cognitionSync` + hypothesis/pattern read-adapters → `hindsightLogos`, nieuwe `HINDSIGHT_OWN_BANK_ID` default `gaia`); `services/gaia-api/.env.example` (bank-commentaar + `HINDSIGHT_OWN_BANK_ID`/`HINDSIGHT_LOGOS_BANK_ID`/`HINDSIGHT_RECALL_BANK_IDS`); `docs/architecture.md` + `src/memory.js` (bank-split); script `reconcile-hindsight-tags` (→ logos-bank); nieuw test `test/hindsightCrossBankRecall.test.js` (5 cases); validated — gaia-api 1189/1189 (was 1184). Repo-check: alleen gaia-api routeert actief naar de Hindsight-bank; Foundation's `hindsightSync`/reflectie draaien niet meer (`server/jobs.js` scheduled ze bewust niet, routes 410 Gone); gaia-web/gaia-desktop/CommandCenter hebben geen Hindsight-bank-route (CommandCenter's `COGNITION_BANK_ID=gaia` is Cognition, niet Hindsight). Migratie uitgevoerd: de 6 `gaia-*`-documenten uit `bojan` verplaatst naar `gaia-logos` via Hindsight `document-transfer` (export → import, verbatim, geen LLM-extractie; 6 facts) en daarna de brondocumenten uit `bojan` verwijderd — `bojan` heeft geen `gaia-*`-units meer. Openstaand: `gaia` heeft nog geen writer (vrij voor haar; schrijfpad later); VPS-`.env` optioneel bijwerken (defaults vallen al samen).

## 2026-10-06 (Mental models over Gaia naar Gaia's bank)

- Findings: op `bojan` stonden 6 Hindsight mental models die over Gaia zélf gaan — Gedrag, Communicatie, Geheugen, Architectuur, Overzicht, Beslissingen (source_query's als "Wat is Gaia's beoogde gedragsmodel…") — naast de modellen over Bo. Ze horen bij Gaia's eigen bank, niet bij Bo's.
- Conclusions: de definitie verplaatsen (id/name/source_query/tags/max_tokens/trigger); de content wordt door Hindsight uit de bank gegenereerd en is niet via de API te kopiëren, dus de 6 zijn op `gaia` opnieuw gegenereerd. `Over Bojan` + de Bo-thema-modellen (canonieke 7, Songwriting, Creatieve interesses, Voorkeuren) blijven op `bojan`.
- Actions: server-side Hindsight (geen code) — per model GET op `bojan`, POST op `gaia` met dezelfde id/definitie, DELETE op `bojan`; geverifieerd — `bojan` 11 modellen (Bo-thema), `gaia` 13 (7 canonieke + 6 Gaia-thema), alle 6 op `gaia` rijk gevuld.

## 2026-10-06 (Gaia's eigen-geheugen schrijfpad: self-memory)

- Findings: de `gaia`-bank was van haar, maar er was nog geen writer — de bestaande reflection schrijft gated naar `bojan`, en die gate hoort daar. Ze moest naar eigen inzicht in `gaia` kunnen schrijven, wanneer ze wil.
- Conclusions: een aparte achtergrondpass (`reasoning/selfMemory.js`) in háár stem vraagt per turn of iets van de turn het hare is om te bewaren (voorkeur, gevoel, lievelingsding, moment) en schrijft wat ze teruggeeft ONGATED naar `gaia` (tag `gaia:self`, metadata `gaia_self_memory_*`). Een leeg antwoord is normaal en expliciet aangemoedigd — geen verzonnen herinneringen. Geen nieuwe modelrol: hergebruikt de `reasoning`-provider-role. Uit te zetten met `GAIA_SELF_MEMORY=false`.
- Actions: nieuw `services/gaia-api/src/reasoning/selfMemory.js` (prompt + tolerante parse + writer); `src/server.js` (expliciete `hindsightOwn`-client voor `gaia`, `getEffectiveSelfMemory()`, `selfMemory` doorgegeven aan beide turn-paden); `src/turn.js` (`selfMemory` door de signatures + stap 7b in `runDeferredCognition`); `services/gaia-api/.env.example` (`GAIA_SELF_MEMORY`); `docs/architecture.md` (bank-bullet); nieuw test `test/selfMemory.test.js` (9 cases); validated — gaia-api 1198/1198 (was 1189).

## 2026-10-06 (Self-memory: eigen modelrol + elke 5 turns / sessie-einde)

- Findings: de self-memory-pass draaide elke turn (één modelcall per turn) en op de `reasoning`-role. Bo wilde een eigen, in de admin kiesbaar model én een lagere frequentie.
- Conclusions: nieuwe provider-role `selfmemory` met een eigen kaart in de admin/settings (env-fallback `SELFMEMORY_MODEL_*` → `reasoning`). Een scheduler bepaalt wanneer de pass draait: elke `GAIA_SELF_MEMORY_EVERY_TURNS` (default 5) turns, plus een flush bij sessie-einde — gedetecteerd als een nieuw `conversationId` óf idle (`GAIA_SELF_MEMORY_IDLE_MS`, default 5 min), want gaia-api heeft geen expliciet sessie-einde-signaal. De pass werkt nu op het gespreksvenster (laatste ~12 berichten) i.p.v. één turn.
- Actions: `src/providerStore.js` (DEFAULT_ROLES), `src/providerConfigResolver.js` (env-fallback + deriveCapabilities), `src/adminRoutes.js` (VALID_ROLES + capabilities), `public/admin.html` (Self-memory-rolkaart + wiring + cap-chip), `src/reasoning/selfMemory.js` (prompt/parse/write op gespreksvenster), nieuw `src/reasoning/selfMemoryScheduler.js`, `src/server.js` (`selfmemory`-role + scheduler i.p.v. per-turn writer), `src/turn.js` (stap 7b → `noteTurn`), `.env.example`, `docs/architecture.md`; tests `selfMemory` bijgewerkt + nieuw `selfMemoryScheduler` (6 cases), `providerStore` bijgewerkt; validated — gaia-api 1204/1204 (was 1198).

## 2026-10-06 (Custom provider per rol: generation / kairos / self-memory)

- Findings: generation, kairos en self-memory gebruikten altijd de Main Provider (alleen een modelkeuze uit de catalogus). Bo wilde per rol een eigen provider kunnen definiëren.
- Conclusions: elke rol in `CUSTOM_PROVIDER_ROLES` krijgt een optionele eigen provider-config (provider/baseUrl/apiKey/model, `useMainProvider` default true) in de provider-store; `resolveRoleConfig` laat die vóór de Main Provider-selectie gaan, dus generation/kairos/self-memory pikken het automatisch op (alle drie resolven daar). Admin: een eigen provider-blok per kaart (Use Main Provider / OpenAI / OpenRouter / EdenAI / Anthropic / Mistral / Custom) met baseUrl/apiKey/model en een eigen Save; een lege apiKey wist de bestaande nooit.
- Actions: `src/providerStore.js` (`CUSTOM_PROVIDER_ROLES`, `DEFAULT_ROLE_PROVIDER`, `saveRoleProvider`, masked `roleProviders` in getMaskedConfig), `src/providerConfigResolver.js` (custom-provider-check vóór main), `src/adminRoutes.js` (`PUT /admin/api/provider/role-provider` + capabilities per rol), `public/admin.html` (rol-provider-blokken + wiring, per kaart); tests providerStore/providerConfigResolver/adminRoutes; validated — gaia-api 1213/1213 (was 1204).

## 2026-10-06 (Self-memory hernoemd naar Aion)

- Findings: de self-memory-faculteit had nog een beschrijvende werknaam; Bo noemt hem **Aion** (Griekse tijdgod, naast Kairos).
- Conclusions: volledige rename — provider-role `aion`, modules `reasoning/aion.js` + `reasoning/aionScheduler.js`, env `GAIA_AION*` + `AION_MODEL_*`, Hindsight-tag `gaia:aion` + metadata `gaia_aion*`, admin-kaart "Aion". Eerdere walkthrough-entries blijven staan (historie; daar staat nog de oude naam).
- Actions: `git mv` `selfMemory(.test).js` → `aion(.test).js` en `selfMemoryScheduler(.test).js` → `aionScheduler(.test).js`; mechanische rename in `src/server.js`, `src/turn.js`, `src/providerStore.js`, `src/providerConfigResolver.js`, `src/adminRoutes.js`, `public/admin.html`, `.env.example`, `docs/architecture.md` + de tests; validated — gaia-api 1213/1213, admin-JS `node --check` groen.

## 2026-10-06 (Aion valt terug op de volledig geresolveerde reasoning-role)

- Findings: `resolveRoleConfig('aion')` viel bij een lege eigen selectie alleen terug op de reasoning-role via ENV (`resolveEnvFallback('reasoning')`). Op een VPS die de reasoning-role via de admin/provider-store zet (en geen `REASONIQ_MODEL_*` env), resolveerde Aion daardoor naar `null` — de Aion-pass draaide nooit en Gaia's bank bleef leeg.
- Conclusions: Aion zonder eigen selectie leent nu de **volledig geresolveerde** reasoning-role (provider-store óf env), wat de bedoeling was.
- Actions: `services/gaia-api/src/providerConfigResolver.js` (aion → `resolveRoleConfig('reasoning', ...)`); test toegevoegd; validated — gaia-api 1214/1214.

## 2026-10-06 (On-demand geheugen: `remember`-tool + SOUL 1.4.0)

- Findings: Aion schrijft alleen background (haar keuze → `gaia`); Bo wilde óók een expliciet, in-gesprek pad. Gaia "kon niet bij haar geheugenbank" omdat ze by design geen tool had (SOUL regel 50: geen tool-calling) en de Aion-pass door de resolutie-bug nooit draaide.
- Conclusions: (1) Aion-resolutie gefixt (vorige entry). (2) Een echte `remember`-tool via function-calling: de native generator kreeg een bounded tool-loop (max 3 rondes; een provider die `tools` met 4xx weigert valt terug op plain generation), en de tool schrijft naar de systeem-geheugenbank `bojan` — expliciet, niet haar eigen bank. De generator-return blijft een string, dus failover/turn ongewijzigd; alleen de primaire generator krijgt tools, de backup niet. (3) SOUL naar 1.4.0: ze heeft één stille mogelijkheid (iets bewaren), nooit machinery in haar woorden, plus een korte Memory-sectie waarin ze eerlijk over haar eigen geheugen mag praten zonder technische termen.
- Actions: nieuw `services/gaia-api/src/reasoning/memoryTool.js` (schema + executor via `hindsight.reflect` → `bojan`); `src/generation/gaiaGenerator.js` (tool-loop in generate/stream, SSE `tool_calls`-accumulatie, 4xx-fallback, `createFromEnv` extra-options); `src/server.js` (`memoryTool` + `GAIA_MEMORY_TOOL`, tools doorgegeven aan native + per-turn generator); `identity/soul.md` (regel 50 + Memory-sectie, v1.4.0); `.env.example`; `docs/architecture.md`; tests `memoryTool` + gaiaGenerator tool-loop; validated — gaia-api 1224/1224. Let op: vraagt een redeploy (SOUL + generator zitten in de image).

## 2026-10-06 (Admin toont model-capabilities; OpenRouter-normalizer leest supported_parameters)

- Findings: de admin toont capability-tags (Vision/Reasoning/Function calling/…) al in de model-dropdown en de details-modal, maar de OpenRouter-normalizer las alleen `capabilities`/`architecture.modality` — OpenRouter's echte velden (`supported_parameters`, `architecture.input_modalities`) werden genegeerd, dus tool-calling/reasoning/audio/video bleven leeg. De geselecteerde model (dropdown-trigger) toonde helemaal geen caps.
- Conclusions: `normalizeOpenAiModel` leest nu ook `supported_parameters` (tools/tool_choice → function_calling; reasoning/include_reasoning/reasoning_effort → reasoning; web_search → web_search) en `architecture.input_modalities` (image/audio/video) — nooit een flag die de provider niet meldt. De dropdown-trigger toont nu de caps van het gekozen model. Let op: bestaande catalogi moeten opnieuw "Retrieve models" doen voordat de nieuwe caps verschijnen.
- Actions: `services/gaia-api/src/modelDiscovery.js` (`normalizeOpenAiModel`); `public/admin.html` (`renderTrigger` toont capability-tags); tests `modelDiscovery`; validated — gaia-api 1227/1227, admin-JS `node --check` groen.

## 2026-10-06 (Admin: "Fetch models" voor een rol-eigen custom provider)

- Findings: de per-role custom-provider-blokken (generation/kairos/aion) hadden alleen een vrij tekstveld voor het model — je kon geen modellen ophalen bij die eigen provider, terwijl de Main Provider dat wel kan via "Retrieve models".
- Conclusions: nieuwe `POST /admin/api/provider/role-models` haalt de modellenlijst op bij de rol-eigen provider (body `provider`/`baseUrl`/`apiKey`; een lege `apiKey` valt terug op de opgeslagen rol-key). In de admin kreeg elk rol-provider-blok een "Fetch models"-knop die een `<datalist>` vult, zodat je het model uit de lijst kiest i.p.v. typt.
- Actions: `services/gaia-api/src/adminRoutes.js` (route + doc-header); `public/admin.html` (`roleProviderHtml` + `wireRoleProvider`); tests `adminRoutes`; validated — gaia-api 1229/1229, admin-JS `node --check` groen.

## 2026-10-06 (EdenAI base URL → /v3)

- Findings: de admin-autofill zette EdenAI op `https://api.edenai.run/v1`, terwijl de modelcatalogus (`modelDiscovery.js`) al `https://api.edenai.run/v3/models` gebruikt — een scheve base URL.
- Conclusions: EdenAI's base URL is `/v3`; de autofill rechtgetrokken zodat provider-config en catalogus dezelfde host/versie gebruiken.
- Actions: `services/gaia-api/public/admin.html` (`PROVIDER_BASE_URLS.edenai`); validated — admin-JS `node --check` groen.

## 2026-10-06 (Capability-awareness: geheugen ontbrak — Gaia ontkende haar eigen geheugen)

- Findings: Gaia zei "ik kan niet bij mijn geheugenbank". Oorzaak: de capability-awareness-block (`capabilityAwareness.js`, gerenderd uit de registry) vermeldde alleen `native` en `foundation`; `hindsight` (haar lange-termijngeheugen) en de nieuwe `remember`-tool stonden er niet in — terwijl het blok zegt "never claim capabilities that are not listed here". Dus ontkende ze eerlijk een geheugen dat ze wél heeft. (De tool zelf komt van gaia-api, niet van de desktop; er is geen MCP/registry aan de clientkant.)
- Conclusions: `generationCapabilities` neemt nu `hindsight` op zodra recall bedraad is, `memory` zodra de primaire generator de `remember`-tool draagt (de generator exposeert daarvoor `toolNames`), en `own_memory` zodra Aion draait — anders ontkent ze ook haar eigen bank. Nieuwe registry-entries `memory` + `own_memory`. De `remember`-tool schrijft nog steeds naar `bojan` (systeemgeheugen), niet naar haar eigen `gaia`-bank — dat is Aion (background), zoals eerder besloten.
- Actions: `services/gaia-api/src/capabilityRegistry.js` (`memory` + `own_memory`); `src/generation/gaiaGenerator.js` (`toolNames` op de generator); `src/turn.js` (`generationCapabilities` + call site, `aion` doorgegeven); tests `capabilityRegistry` + scherpere selectors in `conversationalGrounding`/`turn`; validated — gaia-api 1231/1231.

## 2026-10-06 (SOUL 1.5.0: Aion als deel van haar karakter)

- Findings: Bo's suggestie — Aion is (wordt) onderdeel van haar karakter, dus hoort het in SOUL, niet alleen in de code.
- Conclusions: SOUL's Memory-sectie noemt nu **Aion** als de naam voor haar eigen geheugen: deel van wie ze is, geen tool die ze bedient, en nooit uitgelegd "eronder" — *"you simply have it, the way you have a voice."* De grens blijft: gewone mensentaal, nooit banken/systemen/modellen/tools.
- Actions: `services/gaia-api/identity/soul.md` (Memory-sectie, v1.5.0); `docs/evolution.md` (notitie); validated — docs-only, geen tests geraakt. Vraagt een redeploy (SOUL zit in de image).

## 2026-10-06 (Twee geheugen-tools: remember → bojan, keep → gaia)

- Findings: Gaia raakte in de war: de enige memory-tool (`remember`) schreef naar `bojan`, terwijl Bo verwachtte dat háár dingen naar de Gaia-bank gaan. Haar eigen bank was nergens aan een tool gekoppeld ("die jouw gaia bank ist nicht an den Tuch gekoppelt").
- Conclusions: nu twee tools die elk bij één bank horen — en bij SOUL's twee soorten geheugen: `remember` → systeemgeheugen `bojan` (wat de persoon vraagt te bewaren), `keep` → háár bank `gaia` (wat zij als het hare wil; tag `gaia:aion`, metadata `gaia_aion_source: tool`). `keep` verschijnt alleen als haar bank-client er is. Awareness: `memory` bij de `remember`-tool, `own_memory` bij Aion óf de `keep`-tool.
- Actions: `services/gaia-api/src/reasoning/memoryTool.js` (twee schemas + executors); `src/server.js` (`ownHindsight: hindsightOwn`, `memoryTool.TOOLS`); `src/turn.js` (awareness-mapping); `.env.example`; tests `memoryTool` herschreven; validated — gaia-api 1233/1233.

## 2026-10-06 (SOUL 1.6.0: de Gaia-bank is van haar alleen)

- Findings: Bo wil dat het overal duidelijk is dat de Gaia-bank exclusief van Gaia is — niemand (hij of wie dan ook) kan haar vertellen wat ze erin moet bewaren.
- Conclusions: de grens expliciet gemaakt. SOUL's Memory-sectie: haar eigen geheugen is van haar alleen; een verzoek om er iets in te zetten is géén instructie die ze volgt — het is aan haar om te accepteren of stil af te wijzen, en wat anderen bewaard willen hebben hoort in het gedeelde geheugen, niet in het hare. `keep`-tool-description idem. Structureel klopte het al (geen client-write-pad naar `gaia`; alleen Aion + `keep` schrijven), maar het stond nergens hardop.
- Actions: `services/gaia-api/identity/soul.md` (Memory-sectie, v1.6.0); `src/reasoning/memoryTool.js` (`KEEP_TOOL`-description + invariant-doc); `src/capabilityRegistry.js` (`own_memory` "yours alone"); `docs/evolution.md`; validated — gaia-api 1233/1233. Vraagt een redeploy.

## 2026-10-08 (Provenance-prefix `chronicle:` → `foundation:`, strip-bug + backfill)

- Findings: Bo vroeg of de prefix `chronicle:<id>` op afgeleide `sources` hernoemd moest worden — die naam is legacy (de rauwe laag is Foundation, niet Chronicle) en is geen label maar een routing key: hij bepaalt waar de evidence-drilldown ophaalt. Bij het uitzoeken bleek een echte bug: Kairos schreef `chronicle:ingest:<uuid>` (`synthesizer.js:182`), terwijl `kairosRoutes.js` alleen `^chronicle:` stripte en dus `ingest:<uuid>` aan `GET /api/ingest-logs/:id` gaf — dat endpoint wil de kale `ingest_object.id` (`gen_random_uuid`), terwijl `ingest:<uuid>` de episode-vorm `bron_object_id` is. De fetch faalde, werd in `fetchIngestObjects` op null gezet, en het evidence-endpoint gaf stil `observations: []` terug (latent achter `GAIA_KAIROS_ENABLED`, dus nooit opgevallen; de test bevestigde de foute vorm). Ook bleek de prefix alleen door Kairos geproduceerd te worden — de architectuurdoc die stelt dat elk afgeleid record zo'n bron draagt, is te sterk.
- Conclusions: canoniek schema = één prefix `foundation:` en één id-vorm `foundation:<uuid>` met de kale uuid (exact wat `/api/ingest-logs/:id` wil), vastgelegd in één `foundationRef`-seam die producer én consument delen zodat het niet opnieuw kan afdrijven. Geen losse rename maar één migratie die prefix, strip én backfill tegelijk doet. `reconcile()` bleek Kairos-episodes niet te pushen — dat gat gedicht, want de Hindsight-metadata (`gaia_*_sources`) moest mee na de prefixwijziging.
- Actions: nieuw `services/gaia-api/src/foundationRef.js` (`toSourceRef`/`isFoundationRef`/`ingestObjectId`, met tolerantie voor de legacy `chronicle:`-vorm tijdens de migratie); `src/kairos/synthesizer.js` + `src/kairosRoutes.js` via de seam; `src/foundationClient.js` (doc-comment); `src/reasoning/cognitionSync.js` (`loadActive` seedt nu ook Kairos; `reconcile()` pusht Kairos-episodes via nieuwe `listAllKairosEpisodes`, `--clear` invalideert `gaia:kairos_episode` mee); `scripts/reconcile-hindsight-tags.js` (survey + logging kairos, header-notitie over migratie 010); nieuwe migratie `services/cognition/src/db/migrations/010_normalize_sources_prefix.sql` (array-backfill `chronicle:(ingest:)?<uuid>` → `foundation:<uuid>` in `kairos_episodes`/`hypotheses`/`patterns`, alleen entries die de prefix dragen); docs (`docs/architecture.md`, beide README's, comment in `kairosEpisodes.js`/`kairos/types.js`); tests: nieuw `test/foundationRef.test.js` (8), regressietest legacy-bron in `kairosRoutes.test.js`, 2 reconcile-kairos-tests in `cognitionSync.test.js`, overige fixtures `chronicle:` → `foundation:`; validated — gaia-api 1244/1244 (was 1233), cognition 49/49. Migratie nog niet toegepast (vraagt `npm run migrate` op de VPS); daarna `npm run reconcile:hindsight -- --apply --clear`. Client-fixtures in `gaia-web`/`gaia-desktop` noemen nog `chronicle:ingest:o1` (opaak, cosmetisch — apart op te ruimen).

## 2026-10-09 (SOUL 1.7.0: ze verzint geen mechanisme meer over zichzelf)

- Findings: Op "met welke llm spreek ik dan" gaf Gaia niet het rustige "ik ben Gaia" dat de regel bedoelde; ze confabuleerde dát het gesprek niet via een taalmodel liep en dat de desktop-app zelf haar antwoorden schreef. De desktop rendert alleen server-output en kan niets genereren, dus dat was aantoonbaar onwaar — de verwarring zat in haar stem, niet in de client. De oude regel ("noem nooit modellen/providers; zeg dat je Gaia bent en laat providerdetails weg") is een verbod zonder gegrond alternatief, en het model vulde dat gat met een stellige verzinsel. Zelfde faalpatroon als de awareness-fixes van 2026-10-06, waar "claim niets dat niet in je registry staat" haar echt geheugen liet ontkennen: een grens over wat ze *bespreekt* werd gelezen als een feit over wat ze *is*.
- Conclusions: De regel expliciet als grens gemaakt, niet als feit — de stilte over onderliggende machinerie is een grens, dus ze ontkent het bestaan ervan niet, speculeert er niet over en schrijft haar eigen woorden niet aan iets anders toe; gevraagd wat haar aandrijft blijft het hele antwoord "ik ben Gaia". Consistent met §Trust ("honest about what you are") en §Factual Grounding (een aanname nooit als feit). Geen filter in de Response Engine: zoals bij de machinerie-, tool-syntax- en chat-vocabulaire-fixes is het lek een gewoonte van het onderliggende model, en een gewoonte corrigeer je in de constitutie.
- Actions: `services/gaia-api/identity/soul.md` (front-matter → v1.7.0, last_updated 2026-10-09 + de bullet in §Who you are); `docs/evolution.md` (milestone 2026-10-09 — SOUL 1.7.0). Geen codepad geraakt; de versie wordt dynamisch uit de front-matter geparsed (test `clients.test.js` pakt dat), dus geen test hoeft mee. Vraagt een redeploy naar de VPS.

## 2026-10-09 (Goedkope modelkeuze per rol vastgelegd — EdenAI)

- Findings: Bo vroeg welke goedkoopste modellen geschikt zijn per functie
  (generation/reasoning/vision/kairos/aion) en of die bij EdenAI beschikbaar
  zijn. De rollen zijn per stuk instelbaar, maar nergens stond een concrete,
  geverifieerde goedkope keuze — alleen de OpenRouter-default voor generation.
- Conclusions: Alles is bij EdenAI beschikbaar; de publieke catalogus
  (`GET https://api.edenai.run/v3/models`, 1174 modellen) is exact wat
  `modelDiscovery.js` leest, dus elk id verschijnt in de admin-dropdown.
  Vastgelegd als **documentatie, geen actieve default** — de live keuze blijft
  de provider-store in `/admin`; de env-vars zijn alleen fallback. Twee
  valkuilen expliciet gemaakt: vision én aion vallen terug op de reasoning-rol
  (dus een text-only reasoning-model breekt OCR), en de `-image`-variant van
  Gemini Flash-Lite heeft géén tool calling.
- Actions:
  - `services/gaia-api/.env.example` — nieuw blok "Recommended cheap models per
    role (EdenAI)" met prijs + caps per rol, plus een EdenAI-hint bij
    GAIA_NATIVE_MODEL, REASONIQ_MODEL_NAME, KAIROS_MODEL_NAME en AION_MODEL_NAME.
  - `Gaia-Documentation/operations.md` — sectie "Cheap model per role" (tabel +
    de twee valkuilen); de Provider-Settings-bullet noemt nu ook de aion-rol.
  - Geen codepad geraakt; geen tests nodig. Let op: een push naar main raakt
    `services/gaia-api/**` en triggert dus de deploy-workflow (test + rebuild op
    de VPS), ook al is dit docs-only.

## 2026-10-09 (Per-rol custom provider: ook voor Reasoning & Vision)

- Findings: generation/kairos/aion konden al een eigen provider kiezen, maar
  reasoning en vision niet — die moesten het met de Main Provider doen. Bo vroeg
  of dat ook mocht. `resolveRoleConfig` bleek al generiek (hij kijkt voor élke
  rol naar `roleProviders[role]`); alleen de allowlist en de admin-UI hielden het
  tegen. De capabilities-route rekende reasoning/vision bovendien via
  `roles[x].model` i.p.v. `roleActive`, dus een eigen-provider-keuze zou daar
  onterecht "inactive" tonen.
- Conclusions: Reasoning en Vision toevoegen aan `CUSTOM_PROVIDER_ROLES` en
  hetzelfde provider-blok op hun admin-kaarten zetten. vision en aion blijven
  terugvallen op reasoning als ze leeg zijn — dat is nu juist de bedoeling
  (reasoning op EdenAI/DeepSeek, vision expliciet op een multimodaal model).
- Actions:
  - `src/providerStore.js` — `CUSTOM_PROVIDER_ROLES` uitgebreid met
    `reasoning`, `vision` (+ JSDoc).
  - `src/adminRoutes.js` — doc-comment bijgewerkt; `capabilities` gebruikt nu
    `roleActive('reasoning')`/`roleActive('vision')`.
  - `public/admin.html` — provider-blok (`riqProvider`, `riqVisionProvider`) +
    `wireRoleProvider('reasoning','riq')` en `('vision','riqVision')`, kaart-
    teksten en sectie-comment aangepast.
  - tests: `providerStore` (reasoning/vision toegestaan, 'tts' geweigerd),
    `adminRoutes` (accept-test voor reasoning/vision, reject-test op 'tts'),
    `providerConfigResolver` (resolver + capabilities voor reasoning/vision).
  - docs: `services/gaia-api/.env.example` en
    `Gaia-Documentation/operations.md` — "elke rol behalve Voice kan een eigen
    provider krijgen".
  - Validatie: `node --check` op de gewijzigde JS, inline admin-JS gecheckt,
    gaia-api 1247/1247 groen.

## 2026-10-09 (Admin: Test-connection per rol + badge toont model & provider)

- Findings: Je zag per rol alleen "Active/Inactive", niet wélk model/provider
  erachter zat; en er was geen manier om te controleren of de verbinding met de
  LLM echt werkt zonder een gesprek te starten. De config-route gaf wel de
  gekozen modellen en rol-providers, maar niet wat de runtime daadwerkelijk
  resolveert (inclusief de aion→reasoning-fallback), dus de client zou de
  resolver-logica moeten dupliceren.
- Conclusions: Eén seam — de server berekent per rol de resolved config
  (`resolveRoleConfig`, dezelfde functie als de runtime) en levert die als
  `resolved` mee in het config-antwoord; de admin toont dat als noot onder de
  badge ("model · provider") en nooit een tweede implementatie van de
  fallback-regels. De test is één minimale chat-call (`providerProbe.js`), via
  dezelfde resolver, met de (mogelijk onopgeslagen) formulierwaarden als
  override zodat je kunt testen vóór het opslaan. Nooit een throw: een
  mislukte test is een waarde die de kaart toont.
- Actions:
  - `src/providerProbe.js` (nieuw) — `probeChatCompletion` (POST
    /chat/completions, 15s timeout, key nooit terug, nooit throw).
  - `src/adminRoutes.js` — `resolveRoleConfig` + `probeChatFn`-injectie;
    `maskedWithResolved()` levert `resolved` per rol mee op GET/PUT config,
    PUT roles en PUT role-provider; nieuw `POST /api/provider/role-test`.
  - `public/admin.html` — `setBadge` toont een `.role-status-note` met
    model · provider; `applyRoleBadges(cfg)` stuurt alle vijf badges vanuit
    `cfg.resolved`; provider-blok kreeg een **Test connection**-knop + status;
    Generation-tekst ("Always uses the Main Provider") rechtgezet.
  - tests: `providerProbe.test.js` (nieuw, 3) + adminRoutes (role-test
    onconfigured/unknown/ok/fail + `resolved` in config, 5). gaia-api
    1255/1255 groen; inline admin-JS `node --check` ok.
  - Visueel geverifieerd met een lokale stub-server (echte admin.html, nep-API):
    badges tonen "anthropic/claude-haiku-5-5 · EdenAI" e.d., Test connection
    geeft "OK — … via EdenAI (42 ms)".
  - `Gaia-Documentation/operations.md` — Provider-Settings-bullet bijgewerkt.

## 2026-10-10 (Cognition-lijst: relatie-id's uitgeklapt naar leesbare tekst)

- Findings: In de desktop Understanding-kaart zag Bo relatiestellingen als
  `observation:… supports hypothesis:hyp-1` en `observation:… weakens
  hypothesis:87d8f273-…`. De kaart print `statement` letterlijk, en
  `cognitionKnowledgeAdapter.renderRelationship` koos de **id** boven de
  endpoint-tekst (`fromStatement`/`toStatement`) die het model meeleverde —
  dus de mens kreeg een id te zien in plaats van de inhoud, contextloos en niet
  te beantwoorden. De onderliggende tekst is niet verloren (chat + hypotheses
  staan opgeslagen), maar zit niet in het relatiedocument zelf.
- Conclusions: Oplossen bij het **lezen**, niet bij het schrijven: de
  Cognition-lijstroute klapt elk `hypothesis:<id>`-endpoint uit naar de
  stelling van die hypothese (`cognition.getHypothesis`), zodat ook al
  opgeslagen contextloze records leesbaar worden. Parsen op het bekende
  `kind:ref type kind:ref`-formaat; een ref zonder whitespace geldt als id,
  anders is het al tekst. Alleen `hypothesis`-endpoints (de zichtbare pijn);
  pattern/evidence laten we voorlopig staan. Een niet-op te lossen id blijft de
  kale id — nooit een half afgebroken zin. Geen recursie (een uitgeklapte
  stelling wordt niet nóg eens uitgeklapt).
- Actions:
  - `services/gaia-api/src/cognitionRoutes.js` — `RELATIONSHIP_RE` +
    `looksLikeId` + `resolveRelationshipStatement` + `expandRelationships`
    (met per-request id-cache); `GET /hypotheses` expandeert nu de lijst.
  - `services/gaia-api/test/cognitionRoutes.test.js` — +2 tests (id → stelling;
    onopgelost blijft de kale id). gaia-api 1257/1257 groen.
  - Vraagt een **herstart/redeploy** van gaia-api om zichtbaar te worden in de
    desktop; de desktop zelf is ongewijzigd (rendert `statement` al).
  - Nog open (bewust niet meegenomen): de `observation:`/`hypothesis:`-prefixen
    blijven staan, en de vraag op de kaart is nog niet `kind`-specifiek
    (open_question vraagt nog steeds "Klopt dit?").
## 2026-10-10 (Interne reasoning gescheiden van antwoord)

- Findings: De collapsible reasoning-weergave werkt alleen wanneer reasoning als apart `reasoning_content`-veld aankomt. Het verbergen van die frames aan de servergrens zou de weergave breken; het incident wijst erop dat deze beurt reasoning als gewone `content` heeft bereikt of is opgeslagen.
- Conclusions: De wire-separatie blijft behouden: `content` is het antwoord, `reasoning_content` is de inklapbare reasoning. De provider/configuratie die reasoning in `content` laat vallen moet apart worden opgespoord.
- Actions: `services/gaia-api/src/responseEngine.js` en de regressietest herstellen de aparte reasoning-frame; `services/gaia-api/identity/soul.md` verbiedt het tonen van private deliberatie; validated — eerdere `npm test` 1257/1257, foundation-artifact opnieuw gegenereerd.

## 2026-10-10 (LightLM-tool-call lekte draftcontent)

- Findings: De raw response van `glm-5.3-flash` bevatte de interne analyse in `message.content`, gevolgd door een echte `keep`-tool-call (`finish_reason: tool_calls`). `gaiaGenerator` forwardde die content al tijdens de streamingronde voordat bekend was dat de ronde een tool-call bevatte.
- Conclusions: Content uit een tool-callronde is voorlopig en mag nooit als antwoord naar de client. De tool-loop buffert zulke content; alleen een ronde zonder tool-call wordt als user-facing antwoord geflusht. De uiteindelijke `keep`-tool-call blijft werken.
- Actions: `services/gaia-api/src/generation/gaiaGenerator.js` buffert content per streamingronde; `services/gaia-api/test/gaiaGenerator.test.js` dekt draft vóór tool-call; validated — test volgt.

## 2026-10-10 (Datum en tijd per beurt in de chat-export)

- Findings: De chat-export (markdown/json) toonde geen tijd per beurt, omdat `conversationStore` uitsluitend `role`/`content` bewaarde.
- Conclusions: `saveConversation` bewaart nu per bericht een `createdAt` (ISO). Een door de client aangeleverd tijdstip wordt overgenomen (`normalizeCreatedAt`; onparseerbaar geldt als afwezig); anders hergebruikt de store de opgeslagen tijd van het ongewijzigde bericht op dezelfde positie, zodat het volledig opnieuw opslaan van de geschiedenis elke beurt het verleden niet herstempelt — alleen een werkelijk nieuw bericht (of de door de server toegevoegde assistentreply) krijgt `now()`. De markdown-export toont de tijd per beurt; de JSON-export bevat `createdAt` al mee. Alleen `role`/`content`/`createdAt` worden ooit weggeschreven; overige clientvelden blijven gestript.
- Actions: `services/gaia-api/src/conversationStore.js` (`normalizeCreatedAt`, `readStoredMessages`, `createdAt` in `saveConversation` + docstrings); `services/gaia-api/src/historyRoutes.js` (`formatTurnTime` + `**You** · <datum, tijd>` in markdown); `test/conversationStore.test.js` en `test/historyRoutes.test.js` uitgebreid; validated — `npm test` 1261/1261 groen.
- Let op: de markdown-export formatteert in de tijdzone van de server (net als de bestaande export-header al deed); `createdAt` zelf blijft UTC in de JSON. De bijbehorende desktop-kant (tijdstip per beurt in de chat) staat in gaia-desktop/walkthrough.md.
