# Voorstel — Main Document: Gaia-Cloud + admin (hoofdstuk 4)

Conceptversie in de stijl van het Main Document, ter beoordeling. Gebaseerd op
`docs/architecture.md` en de code in `services/gaia-api` (`server.js`,
`turn.js`, `adminRoutes.js`, `providerStore.js`, `auth.js`, `desktopBroker.js`
en de routers). Gelezen uit bestanden, niet gedraaid.

---

# Gaia-Cloud — definitie

Gaia-Cloud is het harnas: de plek waar Gaia's identiteit, beurt-orkestratie en
afgeleide kennis wonen. Clients tonen en voeren lokaal uit; Cloud denkt,
onthoudt en beslist.

Foundation bewaart wat er is gebeurd; Hindsight helpt herinneren; Logos
onderzoekt; Gaia-Cloud brengt het samen tot één gesprek.

## 1. Eén API voor alle clients

`services/gaia-api` is de uniforme Gaia-API. Desktop en Web praten alleen met
deze service, nooit rechtstreeks met Hermes, Hindsight of Cognition.

| Route | Doel |
| --- | --- |
| `POST /conversation/turn` | één beurt: de kern van alles |
| `/conversations` | gespreksarchief: lijst, zoeken, export, verwijderen |
| `/cognition/*` | GaiaChat: voorstellen bekijken, testen, verwerpen, bevestigen |
| `/kairos/*` | narratieve episodes (alleen lezen) |
| `/eleos/*` | check-ins ophalen en afhandelen |
| `/research/*` | onderzoeksopdrachten en goedkeuring |
| `/desktop/actions/:id/*` | beslissing en resultaat voor acties op de eigen computer |
| `/library/files` | bestandsbibliotheek |
| `/speech`, `/speech/transcribe` | spraak uit tekst, tekst uit spraak |
| `/admin` | beheer (zie sectie 6) |
| `GET /health`, `GET /soul`, `GET /api/version` | gezondheid, SOUL-versie, buildinfo |

Alles behalve de gezondheids- en versieroutes vraagt een Bearer-token.

## 2. Identiteit woont op de server

SOUL (`identity/soul.md`, versie 1.8.0) wordt server-side geladen. Een client
bouwt nooit een eigen systeemprompt. Wie Gaia is, verandert op één plek en voor
alle clients tegelijk.

## 3. De beurt

```
bericht ──▶ valideren ──▶ SOUL + context ──▶ (poort) recall ──▶ één aanroep ──▶ Response Engine ──▶ antwoord
                                                                                         │
                                                                                         ▼
                                                                          achtergrondwerk (zie 4)
```

- Eén modelaanroep, met een back-up als de primaire mislukt.
- De Response Engine voert de tools van de beurt uit (`remember`,
  `search_memory`, `conversation_search`, onderzoek, desktop) tot maximaal
  `maxToolRounds`, standaard 3.
- Een aparte interpretatiestap vóór het antwoord is er niet; zie het
  Logos-hoofdstuk.

## 4. Wat na het antwoord gebeurt

Pas als het antwoord is afgeleverd start `runDeferredCognition`: observatie
registreren bij Foundation, memoryworthiness-poort, Logos-reflectie, schrijven
naar Cognition, reflectie naar Hindsight en de DecisionIQ-review (alleen
observatie). Niets hiervan kan het antwoord vertragen of wijzigen.

## 5. Cognition: de eigenaar van afgeleide kennis

`services/cognition` is een Postgres-service naast de API. Zij bezit de
levenscyclus van afgeleide objecten:

```
proposed ─▶ testing ─▶ corroborated ─▶ confirmed   (alleen een mens)
                          (machinaal)      └──▶ rejected
```

Logos stelt voor, Cognition administreert, en alleen een mens bevestigt, in
GaiaChat. Een spiegel schrijft de afgeleide uitspraken naar Hindsight
(`gaia-logos`) en is herbouwbaar.

## 6. Schakelaars

Optioneel gedrag staat bewust uit tot Bo het aanzet.

| Schakelaar | Standaard | Wat |
| --- | --- | --- |
| `GAIA_KAIROS_ENABLED` | uit | observaties tot episodes vouwen |
| `GAIA_ELEOS` | uit | zelf een check-in beginnen |
| `GAIA_DESKTOP` | uit | acties op de eigen computer |
| `GAIA_RESEARCH_REACH` | uit | onderzoek buiten de beurt |
| `GAIA_AION` | aan | eigen-geheugenmoment van Gaia |

(Uit `architecture.md`, sectie Switches; de standaardwaarden van de laatste vier
zijn niet opnieuw tegen de code gelegd.)

## 7. Het beheeroppervlak (`/admin`)

Een eigen oppervlak, los van het instellingenpaneel in Desktop, achter
Bearer-authenticatie.

- **Providers en modellen:** per rol een eigen provider en model. De rollen
  zijn `generation`, `reasoning`, `vision`, `kairos`, `aion` en `eleos`. Een
  model wisselen vraagt geen codewijziging.
- **Test per rol** (`role-test`) en een lijst met capabilities.
- **Spraak:** aparte instellingen voor TTS en STT (modellen, stemmen, log).
- **API-sleutels** gaan erin en komen nooit meer terug naar een client.

## 8. Toegang

Auth faalt dicht: zonder geldige token geen toegang, nooit anoniem. Tokens
komen uit omgevingsvariabelen (kommagescheiden, dus meerdere tegelijk). De
Hermes-token zit in een interne proxy (`proxy/`), zodat clients hem nooit
zien.

## 9. Acties op de eigen computer

Het beleid wordt op de server bepaald; de client mag het alleen aanscherpen.
Lezen en zoeken gaan automatisch, schrijven en commando's vragen bevestiging.
Bij twijfel faalt het dicht. Een actie doorloopt `awaiting_confirmation` →
`approved` → `completed`, `failed`, `denied` of `expired` (time-outs 120 s en
60 s). Zie `docs/desktop-capability.md`.

---

## Open punten voor dit hoofdstuk

1. De standaardwaarden van Desktop, Research en Aion in sectie 6 nog tegen de
   code leggen voor het hoofdstuk definitief is.
2. `/cognition/*` en `/kairos/*` bevatten leesroutes én schrijfroutes
   (bevestigen). Wil Bo die op termijn scheiden, zodat een client met alleen
   leesrechten kan bestaan?
3. Eén token geeft nu toegang tot alles. Is een onderscheid tussen
   client-token en beheer-token gewenst?
4. Backups en herstel van de Postgres-service staan nergens beschreven.
