# gaia-api

The Gaia API — the server-side seam every first-class client (Desktop,
later Web) talks to. This is where Gaia's server-side turn orchestration
begins: it loads SOUL (identity), generates her reply through the
configured primary/backup provider, and returns a plain reply. Clients
never see a model name, a provider, or a status code
they didn't cause themselves.

## Contract

Kept in lockstep with the desktop's seam (`desktop/src/state/contract.js`):

| Method | Path                              | Auth | Body / Result |
|--------|-----------------------------------|------|---------------|
| GET    | `/health` (and `/`)               | none | `{ ok: true, soulVersion: string }` |
| GET    | `/soul`                           | none | `{ version: string }` — identity version only, no prompt content |
| POST   | `/conversation/turn`              | Bearer | in: `{ messages: [{ role, content }], attachmentIds?: string[], conversationId?: string }` → out: `{ reply: string }` |
| GET    | `/conversations/:id/export/json`  | Bearer | JSON file download |
| GET    | `/conversations/:id/export/markdown` | Bearer | Markdown file download |

`attachmentIds` names files already uploaded to the library (`/library/files`) — never file bytes. `library.js`'s `resolveAttachmentsForPrompt` reads each one server-side and inlines it into the system prompt as attached context (`turn.js`'s `renderAttachmentContext`): text files verbatim, images via `ocrResolver.js`'s vision-model step (disclaimer-prefixed — a description is an inference, not a transcript), everything else (PDFs, other binaries — no extraction pipeline for those yet) noted as attached but not read. This resolution happens entirely *before* `performTurn`/Logos ever see the turn — Logos reasons over what it's given, it never fetches or transforms a raw attachment itself. Omitting `attachmentIds` produces byte-identical behavior to before this existed — Desktop's contract stays additive, never modified underneath existing callers.

Image OCR uses the unified provider's `vision` role (Main Provider, `/admin` role card), falling back to the `reasoning` role — if that model isn't multimodal, or isn't configured, image attachments degrade to "not read" exactly like before this existed.

`conversationId` (the client's own thread id — Desktop already generates one per thread) triggers a fire-and-forget save of the full transcript, including the reply, after a successful turn (`conversationStore.js`). This is deliberately **not** Hindsight: architecture.md is explicit that Hindsight stores reflections, never the raw transcript — chat history is the literal log a person reopens to keep reading, a different job with its own store. Omitting `conversationId` skips saving entirely; the reply is unaffected either way.

## GaiaChat review surface (human Absolute Override)

The derived statements Logos is still weighing live in `services/cognition`. The client moves one forward or lets it go — the only pathway to `confirmed`:

| Method | Path                                  | Auth   | Body / Result |
|--------|---------------------------------------|--------|----------------|
| GET    | `/cognition/hypotheses`               | Bearer | `{ hypotheses: [...] }` (optional `?status=`) |
| POST   | `/cognition/hypotheses/:id/test`      | Bearer | open active testing |
| POST   | `/cognition/hypotheses/:id/reject`    | Bearer | `{ reason }` → `verwerp_bron: "mens"` |
| POST   | `/cognition/hypotheses/:id/confirm`   | Bearer | `{ supersedes?: [ids], rationale? }` → sets `confirmed`, mirrors `gaia:confirmed_fact`, supersedes the named older statements (`verwerp_bron: "consolidatie"`) |

`confirm` is the human **Absolute Override**: no automated step (model confidence, corroboration) ever reaches `confirmed`.

## Chat history

A separate surface (`conversationStore.js`, `historyRoutes.js`) from the library — same one-directory-per-item layout (`meta.json` + `messages.json`, no shared index), but read/delete only; writing only ever happens as the side effect described above, never by direct client upload:

| Method | Path                              | Auth   | Body / Result |
|--------|-----------------------------------|--------|----------------|
| GET    | `/conversations`                  | Bearer | `{ conversations: [{ id, title, createdAt, updatedAt, messageCount }] }`, newest first |
| GET    | `/conversations/:id`              | Bearer | `{ meta, messages: [{ role, content }] }` |
| GET    | `/conversations/:id/export/json`  | Bearer | JSON file download with `exportedAt` timestamp and conversation data |
| GET    | `/conversations/:id/export/markdown` | Bearer | Markdown file download, human-readable format with role labels |
| DELETE | `/conversations/:id`              | Bearer | 204 |

`id` is the client-supplied `conversationId`, validated against a strict allowlist (`[A-Za-z0-9_-]{1,128}`) before ever touching the filesystem — it's used directly as a directory name, so a malformed or path-traversal id is rejected (404), never silently sanitized. Title is derived once, from the first user message, and stays stable across later turns.

Export routes (`/export/json` and `/export/markdown`) return the conversation as a downloadable file. JSON export includes the raw data with an `exportedAt` timestamp for backup/import purposes. Markdown export formats the conversation with role labels (`**You**` / `**Gaia**`) for human readability. Both routes require auth and return 404 for unknown conversation ids.

Non-streaming in this phase. The streaming variant grows behind the same
path (SSE/WebSocket) — clients were built with that seam ready.

Also part of the client contract, a **file library** (`library.js`,
`libraryRoutes.js`) — storage and browsing only in this phase, nothing
here feeds Logos, Hermes, or Hindsight yet:

| Method | Path                  | Auth   | Body / Result |
|--------|-----------------------|--------|----------------|
| POST   | `/library/files`      | Bearer | multipart, field `file` → `{ id, filename, mimeType, size, uploadedAt }` |
| GET    | `/library/files`      | Bearer | `{ files: [...] }` |
| GET    | `/library/files/:id`  | Bearer | raw file bytes, `Content-Type`/`Content-Disposition` from stored metadata |
| DELETE | `/library/files/:id`  | Bearer | 204 |

Files persist on disk under `LIBRARY_PATH` (default `data/library/`,
same persistent volume as the provider store's admin config — see
`docker-compose.yml`). One directory per file (`meta.json` + `blob`), no
shared index to corrupt under concurrent writes. Capped at
`LIBRARY_MAX_FILE_SIZE_MB` (default 25MB) per upload.

Separately, an **operator-only admin surface** (never part of the client
contract above, never reachable from Gaia Desktop or Gaia Web in the
normal sense — see `adminRoutes.js`):

| Method | Path                          | Auth   | Body / Result |
|--------|-------------------------------|--------|----------------|
| GET    | `/admin`                      | none   | the static operator page (`public/admin.html`) — provider, roles, TTS, decision log |

## Boundaries

- **Identity is server-side, and owned here.** SOUL is loaded from this
  service's own canonical `identity/soul.md` (baked into the image;
  `SOUL_PATH` overrides) — centralized out of the web client in
  `e200903` (see `docs/evolution.md`). It carries a `version` field
  (currently `1.1.0`) that `/health` and `/soul` surface, so clients can
  observe which identity they're talking to. No SOUL, no start.
- **No provider leakage.** Hermes' URL, model and token live in this
  service's environment. Error responses are calm sentences, not stack
  traces or upstream status codes.
- **Fail closed.** Without `GAIA_API_TOKEN` every authenticated route
  returns 503; wrong tokens get 401.

## Logos.IntentIQ (v0.1)

`src/logos/intentIQ.js` — Gaia's first real IntentIQ, living in Gaia Cloud
per architecture.md rather than as a client-side heuristic. It answers
exactly one question, "what is the user trying to achieve?", against the
approved Intent Taxonomy v0.1 (`src/logos/intentTaxonomy.js`), and returns
a structured `IntentDecision` (`schemaVersion: "intentiq.v1"`). It never
calls Hermes, chooses a model/provider, executes a capability, or writes
memory — see `test/intentIQ.test.js`'s boundary tests, which assert this
directly rather than just documenting it.

Wired into `performStreamingTurn` (turn.js) as an **observe-and-log seam
only** — every streaming turn is classified and the decision is dev-logged
(`src/logos/intentLog.js`), but nothing about document selection, recall,
or the Hermes call changes based on it yet. This matches how Logos's
earlier client-side intentIQ/reasonIQ were introduced (evolution.md,
Milestone 7b) — establish the seam, observe it, wire it into a real
decision later once there's a Gaia-side decision layer to consume it.

Run the synthetic evaluation set: `npm run eval:intent` (see `eval/README.md`).

## Logos (V3 unified faculty)

`src/logos/logos.js` — Gaia's cognitive faculty: "what is the user trying
to achieve, what does this mean, what follows, what hypotheses are
plausible, how certain are we?" Intent interpretation and reasoning are
prompt-level faculties of one Logos pass (`src/logos/logosPrompt.js`),
not separate IntentIQ/ReasonIQ subsystems. An optional intent hint may be
supplied (tested, never trusted blindly, never required). Logos reasons
over explicitly-supplied text/context/evidence only (no memory, no
database, no tool access), and returns a structured `LogosResult`
(`schemaVersion: "logos.v1"`) distinguishing fact / inference /
hypothesis / unknown, with Stash-inspired evidence verdicts
(`supports`/`weakens`/`contradicts`/`irrelevant`) per hypothesis — see
`src/logos/logosSchema.js` for the full vocabulary.

Logos uses the **unified provider's `reasoning` role**
(`src/logos/logosModelClient.js`, `src/providerConfigResolver.js`,
`REASONIQ_MODEL_*` env vars as fallback) — deliberately not Hermes, not
a Gaia capability, and never selected by Gaia. It decides per turn
whether that model is even worth calling (`decideLogosDepth`): **only
when `evidence` was actually supplied** — intent and text length don't
factor in, since without evidence a model call can't produce anything
the cheap path doesn't already know. That cheap path isn't a
placeholder either — `shallowResult()` still reads the intent hint's
status and whether an evidence-dependent intent
(`EVIDENCE_DEPENDENT_INTENTS`: `inform.explain`, `create.transform`,
`decide.support`, `act.perform`) got any evidence, and reports honest
uncertainty/information-gaps and a correspondingly lower confidence from
that alone. With no model configured, or on an unreachable/malformed
response, Logos degrades to an honest, low-confidence result rather
than guessing or throwing into the turn. Logos never confirms or rejects
a hypothesis itself (Absolute Override: only a human confirms).

**Never in the live path** — `turn.js` runs direct generation only; the
background reflection (`runDeferredCognition`) calls Logos after the
reply is delivered, fire-and-forget, and the result feeds future turns
only via Hindsight recall. See `docs/architecture-v3.md` for the V3
status and open decisions.

Run the synthetic evaluation set: `npm run eval:logos` (see
`eval/README.md` — it runs against a labeled non-LLM stub, not a real
model; read that file before trusting the pass rate).

## Run (dev)

```bash
cd services/gaia-api
GAIA_API_TOKEN=dev-token HERMES_BASE_URL=http://localhost:11434/v1 \
HERMES_MODEL=llama3 npm start
```

## Deploy (VPS)

Same posture as Hindsight — Tailscale-only binding
(`100.65.0.15:8891`), token auth, `.env` untracked on the host.

```bash
cp .env.example .env   # fill in
docker compose up -d --build
```

Desktop clients then configure (Settings → Gaia Cloud):

- **Server URL:** `http://100.65.0.15:8891`
- **Auth token:** one of the `GAIA_API_TOKEN` values

## Reaching Hermes

`HERMES_BASE_URL` must point at hermes-agent **by container name**
(`http://hermes:8642/v1`). hermes-agent binds only to its own docker
network (`hermes-agent_default`); this service joins that network in
`docker-compose.yml` exactly like `gaia-hermes-proxy` does. The Tailscale
IP does **not** expose Hermes — don't use `100.65.0.15:8642`.

> **Shared secret — rotate in both places.** `HERMES_AUTH_TOKEN` is the
> same token `gaia-hermes-proxy` injects when *it* talks to hermes-agent
> (`proxy/templates/default.conf.template`). It lives untracked in two
> `.env` files on the VPS: `proxy/.env` and this service's `.env`. If you
> rotate it, update **both**, then restart `gaia-hermes-proxy` and
> `gaia-api` — otherwise one of them starts getting `401` from hermes.
