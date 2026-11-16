# Spike: CortexIQ als geheugenlaag

Gemeten op 16 november 2026 tegen de productie-instance van CortexIQ (strato-vps, image `ghcr.io/bojanni050/cortexiq:0.1.88`, REST op host-poort `127.0.0.1:18101`, in de container `9090`). Aanleiding: het idee om Hindsight te vervangen door CortexIQ, en de vraag of dat de terugkijk-route ("wat deed ik gisteren") makkelijker maakt.

## Wat er in de instance zit

- 16.701 entries, 2.997 facts, 136 MB; oudste entry 7 oktober 2026, nieuwste vandaag.
- 31 namespaces, waaronder `/projects/gaia`, `/projects/castborg`, `/projects/mindstack`, `/clients/white-vision` en `/self`.
- Gevuld door de OpenCode-sessies, niet door Gaia. Dat betekent: dezelfde onderwerpen, andere bron. Een echte A/B op inhoud kan pas na een import.

## 1. De tijdas: Hindsight rankt, CortexIQ filtert

Drie synthetische episodes in `/spike/kairos` met `occurred_at` op 13 nov, 5 nov en 20 okt, plus een vierde op 15 nov.

| Query | Venster | Resultaat |
|---|---|---|
| "spike testnotitie kairos" | geen | 5 hits, alle datums |
| idem | `from=2026-11-13`, `to=2026-11-14` | **1 hit**, precies de 13e |
| idem | `from=2026-11-01T00:00:00+01:00`, `to=2026-11-16T00:00:00+01:00` | **3 hits**, 20 okt valt weg |
| "wat deed ik gisteren met de spike" | geen, geen datum in de body | **1 hit**, de 15e |
| "wat deed ik vorige week met de spike" | geen | 2 hits: 13 en 15 nov |

Dezelfde test op Hindsight (bank `gaia-logos`, tag `gaia:kairos_episode`, venster 13 nov) gaf 54 resultaten, inclusief 5 en 9 november. Hindsight's `temporal_window` is expliciet een ranking-arm, geen filter; `memories/list` heeft helemaal geen datumparameter.

Dat is het beslissende verschil. Een dagoverzicht of terugkijk-vraag vraagt om *selecteren*, niet om *omhoog stemmen*.

Het tweede dat opvalt: de Nederlandse datumherkenning werkt over de **REST-API**, niet alleen in CLI en MCP. `from`/`to` hoef je dus niet zelf te parsen; "gisteren" en "vorige week" worden in de query herkend en als filter toegepast.

## 2. Scoping: `namespaces` filtert, `namespace` niet

Dit is een val om te kennen:

- `namespaces: ["/spike/kairos"]` — harde filter. Een Castborg-query gaf 0 resultaten, een query in `/projects/gaia` gaf alleen namespace 12.
- `namespace: "/spike"` — geen filter, alleen een zetje in de ranking. Dezelfde query gaf facts uit `/projects/castborg` terug.

Voor Gaia moet de recall dus altijd `namespaces: [...]` gebruiken, en nooit de enkelvoudige vorm.

## 3. Wat `remember` accepteert — en wat het laat vallen

Geaccepteerd en bewaard: `content`, `namespace`, `tags`, `occurred_at`, `external_key`, `external_refs`, `importance`.

- **`external_key` geeft echte idempotentie.** Twee keer schrijven met dezelfde sleutel en dezelfde inhoud geeft de tweede keer `{"id":988,"message":"Memory already up to date","unchanged":true}` — zelfde rij, geen duplicaat. Andere inhoud onder een bestaande sleutel wordt geweigerd, tenzij `supersedes: true`, en dan wordt de oude rij met de nieuwe verbonden en sluiten de facts die alleen daarop rustten. Dat is precies de seam die een spiegel nodig heeft: `external_key = gaia:kairos:<episode_id>`.
- **`external_refs` overleeft en komt terug.** `["commit:9243fbe","foundation:abc-123"]` kwam letterlijk terug bij recall; facts die eruit volgen erven de refs. Let op: de REST-API wil een **array**, de MCP-tool een kommagescheiden string — een string naar REST geeft `cannot unmarshal string into Go struct field .external_refs of type []string`.
- **`metadata` wordt stil weggegooid.** Vrije metadata (`{gaia_kairos_episode_primary_app, sources}`) kwam terug als `{}`; gebruik daarvoor `external_refs` of een tag. Zonder `external_key` dedupliceert CortexIQ niet: dezelfde payload twee keer gaf twee rijen (986 en 987).

## 4. Consolidatie is snel, en dun

Binnen twee minuten na de spike-episodes stonden er facts in de database, onder meer:

> "In the kairos project, a SPIKE event took place on 15 November." — entity `SPIKE`, property `date`

Dat is dezelfde soort ruis als Hindsight's "Logos formed hypothesis: User received a promotional offer…". De migratie lost dat dus niet op. Het verschil is dat de consolidatie nu van Bo is: triage-model, critic-model, sociale filter en namespace-per-run zijn knoppen in plaats van een black box.

## 5. Purge-semantiek

- `DELETE /api/v1/episodes/:id` doet een **harde** purge en neemt de facts mee die eruit volgden (`removed: {episodes, facts, retractions, embeddings}`).
- Facts zijn niet los te verwijderen (`DELETE /facts/:id` → 404). Alleen via de episode waar ze uit komen.
- Namespaces zijn niet te verwijderen via REST (`DELETE /namespaces/:id` → 405). Een lege namespace blijft staan.

## 6. Kwaliteit op twintig Nederlandse vragen

Dezelfde twintig vragen (gisteren, vorige week, vorige maand, Castborg, White Vision, MelodIQ, capture-rs, ING-fraude, backups, Adlytica, muziekcatalogus, hypotheses, toon) door beide stores, top-5.

- **CortexIQ** (ongefilterd, 5 hits): mediaan **1.061 ms**. Top-1 is meestal technisch raak (Castborg-chunks, MelodIQ mp3-fallback, capture-rs logpad, de Adlytica-repo), maar vaak een **ruwe episode** in plaats van een geconsolideerd feit; scores lopen van 0,05 tot 0,77 en zijn slecht gekalibreerd.
- **Hindsight** (`bojan` + `gaia`, 5 hits): mediaan **1.372 ms**. Elke top-1 scoort rond 1,07 — de reranker normaliseert naar plafond — en de inhoud is vaak naast de vraag: "Gebruiker voelt zich trots op haar vermogen om zelfstandig te beoordelen…", "Bo en Luca deelden wederzijdse gevoelens…". De `gaia`-bank met emotionele herinneringen domineert de werkvragen.

Beide zijn dus matig, om verschillende redenen. CortexIQ's probleem is presentatie (ruwe episodes boven facts); Hindsight's probleem is inhoud (een bank die verzadigd is met iets anders dan waar je naar vraagt).

## Conclusie

De tijdas alleen al rechtvaardigt de overstap: Hindsight kan een datum niet selecteren, en elke terugkijk-vraag heeft dat nodig. Verder is de API klein en voorspelbaar, de latency gelijkwaardig, en is de consolidatie instelbaar in plaats van een zwarte doos.

Twee dingen om vooraf te regelen: **koppeling** (vrije `metadata` overleeft `remember` niet, dus de episode-id en de Foundation-refs gaan in `external_key` en `external_refs`) en **idempotentie** (die zit er, maar alleen als je `external_key` meegeeft — zonder sleutel schrijft elke ronde een nieuwe rij).

De kwaliteit van de recall is vandaag geen argument vóór of tegen: beide stores geven op deze twintig vragen vaak iets naasts. Wat verandert is dat de knoppen straks van Bo zijn.

## Aanbeveling

Houd de eerder voorgestelde volgorde aan, met de terugkijk-route als eerste echte cliënt:

1. `MemoryStore`-poort in gaia-api expliciet maken.
2. Terugkijk-route bouwen op CortexIQ, met `namespaces` + `from`/`to`. Nieuw code, niets te migreren.
3. `gaia-logos` rebuilden uit Cognition in plaats van migreren.
4. `bojan` en `gaia` exporteren en importeren, twee weken schaduwdraaien.
5. Hindsight read-only, dan weg, inclusief de nginx-proxy in gaia-web.

## Incident tijdens de spike

Bij het opruimen van de test-episodes heb ik één bestaande episode geraakt: **id 980**, "Mindstack 2026-11-16: frontend gemigreerd van CRA/craco naar Vite…". Oorzaak: ik filterde met `namespace: "/spike"`, wat geen filter is, en de purge-lus liep daarna over alles wat terugkwam. De afgeleide facts van die episode staan er nog (3170, 3172, 3173, 3174); alleen de ruwe tekst is weg. Te herstellen door dezelfde regel opnieuw te sturen vanuit de Mindstack-sessie.
