# Voorstel — Main Document: Clients (hoofdstuk 5)

Conceptversie in de stijl van het Main Document, ter beoordeling. Gebaseerd op
de READMEs en code van `Gaia-Desktop` en `Gaia-Web`, en op
`docs/desktop-capability.md` en `docs/background-voice-cloud-spec.md`. Gelezen
uit bestanden, niet gedraaid.

---

# Clients — definitie

Een client is hoe Bo Gaia ontmoet. Hij toont, luistert en voert lokaal uit.
Hij denkt niet.

## 1. Eén regel

Een client bevat geen SOUL, geen redenering, geen geheugen en geen
tool-keuze. Hij stuurt de tekst van de persoon naar `gaia-api` en toont wat
terugkomt. Wat het antwoord betekent, wat er onthouden wordt en welke tool past,
wordt server-side beslist.

```
Desktop ─┐
         ├──▶ services/gaia-api (uniforme API) ──▶ Gaia-Cloud
Web ─────┘
```

Beide clients voldoen aan hetzelfde contract. De oude directe routes van Web
naar Hermes, Hindsight en Cognition zijn weg; alles loopt via `gaia-api`.

## 2. Gaia Desktop (Tauri)

Native client, voorlopig alleen Windows, zonder code signing.

| Deel | Wat |
| --- | --- |
| `desktop/` | eigen UI (Vite + React): zijbalk, gesprek, invoer, presence, instellingen |
| `src-tauri/` | Rust-schil |
| Communicatie (`ServerLink`) | de enige verbinding met `gaia-api` |
| Presence | lokale beschikbaarheid: alleen lokaal, verbinden, beschikbaar, losgekoppeld, stil. Nooit een uitspraak over Gaia's denken |
| Meldingen | OS-meldingen; wat aandacht verdient bepaalt Gaia |
| Spraak | TTS afspelen en STT versturen; spreken is altijd de laatste stap, na het antwoord |
| Audio | microfoon met hoofdschakelaar (uit bij elke start), wake word, VAD, push-to-talk, echo- en enrolment-onderdelen |
| MCP | lokale stdio-servers uitvoeren; welke tool en wat het resultaat betekent beslist de server |
| Capture | register van lokale bronnen; volgens de code nog zonder concrete engines |
| Bibliotheek | bestanden uploaden en ophalen via een eigen Rust-pad |

Desktop is de uitvoerder van acties op de eigen computer (`desktopActions.js`,
`src-tauri/src/mcp/`). Het beleid komt van de server; de client mag alleen
aanscherpen en meldt beslissing en resultaat terug.

Releases gaan via een versietag naar een conceptrelease (MSI en NSIS) die Bo
zelf publiceert.

## 3. Gaia Web

Dunne browserclient (React). Praat alleen met zijn eigen same-origin route
`/api/gaia/`; nginx zet de Bearer-token erop, zodat de browser hem nooit ziet.
`src/gaia/server/api.js` is de enige brug, en `useConversation` bezit geen
cognitie. Heeft dezelfde secties als Desktop voor gesprek, geschiedenis,
bibliotheek, instellingen, Kairos-episodes en de GaiaChat-review.

## 4. Bevestigen gebeurt in de client, beslissen niet

De mens bevestigt in de client (GaiaChat voor kennis, een kaart voor een
actie), maar de client maakt nooit zelf iets `confirmed`. Hij stuurt het
verzoek; Cognition legt het vast.

## 5. Gaia mag stil zijn

Zonder verbinding blijft de client bruikbaar als presentatie: hij meldt eerlijk
dat Gaia niet bereikbaar is en doet niet alsof. Presence beschrijft het
apparaat, niet Gaia.

---

## Open punten voor dit hoofdstuk

1. Het Web-README noemt nog `intentIQ/reasonIQ` en verwijst naar
   `docs/split-plan.md`, dat niet meer bestaat. Bijwerken.
2. Capture heeft in de code geen concrete bronnen; de ingestie voor capture-rs
   staat in `foundation ingestion capture-rs.md`. Wat is de huidige status?
3. Web mist (voor zover gezien) de acties op de eigen computer. Bewust?
4. macOS en Linux voor Desktop: gepland of niet?
5. Hoe komt een nieuwe client (telefoon) aan zijn token?
