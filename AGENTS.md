# Gaia Cloud — notes for an agent

Gaia's server side. The clients (Desktop, Web) are separate repositories and speak only to
`services/gaia-api`; the API contract must stay additive, and no reply may leak a provider or
model name.

`docs/architecture.md` is the authority on *what is wired how*; `docs/CONVENTIONS.md` is the
authority on *how a change is made here*. Both are enforced (see below). Read them before
proposing a structure.

## Layout

- `services/gaia-api/` — the one backend: turn orchestration, SOUL (`identity/soul.md`),
  Logos, Kairos, Eleos, speech, library, `/admin` provider store. `README.md` in that
  directory documents the routes per surface — read it before touching a route.
- `services/cognition/` — derived-knowledge store (Postgres), owns the lifecycle and the SQL
  migrations.
- `proxy/` — nginx that injects the Hermes token.
- `docs/`, `scripts/` — docs, the architecture guard and the foundation bundler.
- `walkthrough.md` / `walkthrough2.md` — the dated log, in the **root**, not under `docs/`.

No root manifest: each service has its own `package.json` and `package-lock.json`, and there is
no build, lint, formatter or typecheck step. Verification is the two test suites.

## Commands

```bash
cd services/gaia-api && npm test                 # ~1770 tests, ~10 s, pure (no DB, no network)
cd services/cognition && npm test                # ~82 tests, pure (fake pools)
cd services/gaia-api && node --test test/speech/mistralTts.test.js   # one file
node scripts/verify-architecture.js              # after touching docs, routes, flags, capabilities
node scripts/build-foundation-artifact.js        # after editing a runtime document
```

CI uses Node 22; the suites are hermetic, so run them freely and quote the real count in the
walkthrough entry.

## Merging is deploying

| workflow | triggers on push to main touching | does |
| --- | --- | --- |
| `deploy.yml` | `services/gaia-api/**`, `services/cognition/**` | `git reset --hard origin/main` in `/root/gaia`, rebuilds **both** containers, runs migrations |
| `publish-foundation.yml` | `docs/**`, `identity/soul.md` | publishes `foundation-artifact.json`, triggers a Gaia-Web rebuild |
| `verify-architecture.yml` | `docs/**`, `services/**`, `scripts/**` | the docs-drift guard |

On a pull request these run tests only and skip the deploy job — green on the PR does not prove
the deploy. A change that touches only the root (e.g. `walkthrough2.md`) triggers nothing at all.

## Rules that bite

- **Flags.** Every boolean flag goes through `services/gaia-api/src/flags.js`
  (`flag(env, name, { default })`); never `env.GAIA_X === 'true'`. Defaults and read sites are
  the *Switches* table in `docs/architecture.md`.
- **Migrations are immutable.** `schema_migrations` keys on the filename, so renaming an
  applied migration re-runs it on a live Postgres. New files take the next free number; the two
  historical `010_` files stay as they are (`test/migrations.test.js` guards both halves).
- **Docs are runtime content.** `soul.md`, `principles.md`, `lexicon.md`, `architecture.md`,
  `evolution.md`, `identity.md` are bundled and shipped to clients; `DOCUMENTS` in
  `scripts/build-foundation-artifact.js` is the list. Editing them changes what Gaia reads about
  herself.
- **The architecture document is machine-checked.** A claim the repo cannot verify must be
  marked *(external)* or *(deployment)* on its line, and the
  `Verified against code: commit <sha>` header is updated when claims are re-read.
- **The log.** After a significant change, append one entry to the running `walkthrough*.md` in
  the root: `## <date> (<title>)` with `Findings:` / `Conclusions:` / `Actions:` (every file,
  ending in `Validated:` with real counts) / `Deployment:`, plus `Open punt:` when something
  genuinely remains. At ~1000 lines start `walkthrough3.md`. `walkthrough.md` is closed.

## Live system

- VPS: `ssh contabo` (100.65.0.15, Tailscale; public SSH is closed). Deploy directory
  `/root/gaia` — **the deploy does `reset --hard`, so a hand edit there disappears on the next
  merge**; change it in the repo.
- `/admin` config wins over the environment: saved providers, keys, models and voices live in
  `services/gaia-api/data/provider-config.json` (mounted at `/app/data`, gitignored). Editing
  `GAIA_TTS_*`, `GAIA_NATIVE_*` and friends in `.env` changes nothing while the store has a
  value. `get /speech/info` and `/speech/stt-info` tell you which provider is actually live.
- Auth is the bearer token from `GAIA_API_TOKEN` (503 when unset, so a misconfigured container
  looks like an outage). Everything is tailnet-only by design.
- `.env` files are gitignored and survive the deploy; `.env.example` per service documents every
  variable. Never commit real values or read them into the conversation.

## Language

Docs, walkthroughs and replies to Bo in Dutch; code comments and commit bodies in English. A
Dutch commit subject with an English body is normal.

## Two local traps

- `.gitignore` contains a template `agents.md` entry, which on a case-insensitive checkout also
  hides this file. Keep the `!AGENTS.md` exception below it.
- The checkout is on Windows with `core.autocrlf`; git warns "LF will be replaced by CRLF" on
  every text edit. Harmless, but do not let it turn into a whitespace-only diff.

### Context7 — Actuele library-documentatie
| Eigenschap | Waarde |
|---|---|
| Type | MCP-tool voor up-to-date library- en framework-documentatie |
| Gebruik | Raadplegen bij vragen over APIs, libraries, frameworks |

**Wanneer Context7 raadplegen:**
- Bij gebruik van een library of framework (Next.js, Drizzle, Zustand, Tailwind, AWS SDK, etc.)
- Wanneer je twijfelt over een API, functie-signatuur of configuratie-optie
- Bij het installeren of upgraden van een dependency
- Vóór je iets aanneemt op basis van trainingsdata — library-APIs veranderen

**Werkwijze:**
1. Zoek eerst de library ID op via `resolve-library-id`
2. Haal dan de relevante docs op via `get-library-docs`
3. Gebruik de actuele docs als leidraad — niet je trainingsdata

> Context7 heeft prioriteit boven aannames op basis van trainingskennis voor alles wat library-specifiek is.

### Gedragsregels voor de agent
- Als Bo zegt **"dat weet je toch"** of **"we hebben dit besproken"** → zoek in Hindsight 
- Vraag **niet** naar informatie die waarschijnlijk al in een eerdere sessie vastgesteld is (tech stack, provider keuzes, architectuurbeslissingen)
- Als iets inconsistent lijkt met bekende patronen → **flag het**, overschrijf het nooit stilzwijgend
- De memory-systemen zijn Bo's eigen infrastructuur — stel nooit voor ze te vervangen of te omzeilen
- Raadpleeg **Context7** voordat je library-specifieke code schrijft of een API aanroept

## Memory Protocol
Start session: use hindsight recall to load my profile and recent project context. Summarize what you know about me, then we begin.

Before answering, always recall relevant context using the hindsight MCP tool.
Query: current topic, project name, or user preferences.

After important decisions or changes, store a summary using hindsight retain.

## 📋 Walkthrough-protocol

Na elke significante wijziging wordt `walkthrough.md` bijgewerkt. Dit is verplicht. Maak na 1000 regels een nieuw walkthrough2.md aan, daarna eventueel walkthrough3.md enz.

### Format (oudste → nieuwste volgorde):

```markdown
## YYYY-MM-DD (Korte titel)

- Findings: [Wat was het probleem of de aanleiding?]
- Conclusions: [Waarom deze aanpak?]
- Actions: [Welke bestanden zijn gewijzigd en wat precies?]; validated.
```

### Regels:
- Voeg altijd toe aan het **einde** van het bestand (chronologisch)
- Beschrijf de *reden* van een keuze — niet alleen wat er is gedaan



## 🧩 Werkwijze & aanpak

### Hoe Bo werkt
- **Scaffolding** via bolt.new → download → lokaal verder in Visual Studio Code / Kilo Code
- **Iteratief**: architectuur vroeg valideren vóór grote build-out
- **Solo**: beslissingen worden snel genomen zodra opties helder zijn
- **Prompt-stijl**: werkt goed met kant-en-klare, gesegmenteerde prompts voor meerstaps-refactors

### Wat de agent moet doen
- **Wees proactief**: als je een probleem ziet dat niet gevraagd is, benoem het kort
- **Wees precies**: geef exacte bestandspaden, functienamen en regelnummers
- **Wees incrementeel**: één duidelijke taak per prompt — geen 10 dingen tegelijk
- **Bouw modules stap voor stap** via chat in plaats van alles in één grote prompt
- **Valideer altijd** met `npm run build` voor je een taak afsluit
- **Flag inconsistenties** in plaats van ze stilzwijgend te omzeilen

### Wat de agent NIET moet doen
- Niet vragen naar context die waarschijnlijk al bekend is
- Niet zelf architectuurbeslissingen nemen die niet gevraagd zijn
- Niet meerdere grote wijzigingen tegelijk doorvoeren
- Niet een nieuwe dependency installeren zonder het te benoemen en te vragen
- Niet de walkthrough overslaan na een significante wijziging
- Niet antwoorden in het Engels als de vraag in het Nederlands is gesteld

