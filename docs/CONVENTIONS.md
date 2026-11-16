# Conventions

The rules a change in this repository follows. Every one of them exists because breaking it
cost something concrete. Where a rule has a single source of truth in the code, this file
points at it instead of repeating it — a second copy is a second thing that can drift.

## The log: `walkthrough*.md`

The log lives in the **repository root**, not under `docs/`. `walkthrough.md` is the closed
first volume (frozen at ~1043 lines); `walkthrough2.md` is the running one. Each volume opens
with a header naming its predecessor and repeating these rules.

- One entry per working session: `## <YYYY-MM-DD> (<short title>)`, in Dutch, chronological —
  oldest at the top, newest at the bottom.
- Four bullets, in this order: `- Findings:`, `- Conclusions:`, `- Actions:`,
  `- Deployment:`. Add `- Open punt:` whenever something is genuinely left open (an unbuilt
  phase, a knob nobody has judged yet) — that line is what the next reader needs most.
- `Actions:` names every file touched and ends with `Validated:` plus the **real** test
  counts. `Deployment:` says whether a container, a migration or an environment variable is
  involved; "geen migratie, geen nieuwe env" is a normal and useful line.
- At ~1000 lines a volume is closed and a new one starts (`walkthrough3.md`), so a git diff
  or an editor stays workable.
- A change that touches only `walkthrough*.md` triggers **no workflow at all**: the root is
  outside every path filter (`docs/**`, `services/**`, `scripts/**`). Expect no checks on
  such a pull request; merge on the API's `mergeable` state.

## The audit: `docs/advice.md`

The audit is findings with evidence plus the advice, and it is *not* frozen history: the cell
for an item is updated in place when the item is done, with the evidence.

- Its line numbers were read against an older commit and **have drifted**. Re-verify a claim
  against the code before acting on it, and act on what you find rather than on what the line
  says.
- When you deliberately deviate from the advice — it is sometimes wrong, and once was
  dangerous as written (C2, C6) — record the deviation *and the reason* in the same cell.
  Otherwise the next reader takes it for forgotten work.
- §5 (quick wins vs. larger work) and the chosen order are part of the bookkeeping: update
  them in the change that closes an item, or the advice ages against itself.

## Languages

Prose, docs and walkthroughs in Dutch. Code comments and commit bodies in English. A Dutch
commit subject with an English body is normal here.

## Documents that are runtime content

`soul.md`, `principles.md`, `lexicon.md`, `architecture.md`, `evolution.md` and `identity.md`
are bundled by `scripts/build-foundation-artifact.js` into `foundation-artifact.json`, which
clients pull and the container bakes in. Never delete, rename or move one of them apart from
`DOCUMENTS` in that script: the publish workflow fails hard and Gaia-Web's rebuild stops. A
change under `docs/` is a change in what she reads about herself.

## The architecture document is machine-checked

`node scripts/verify-architecture.js` re-reads the anchors out of `docs/architecture.md`
(repo paths, environment flags, capability ids, lifecycle terms, routes) and fails per anchor
with file and line. Two rules follow:

- A claim this repository cannot check must be marked *(external)* or *(deployment)* on its
  line. The guard skips marked lines, so an unmarked unverifiable claim is a red build.
- Update the `Verified against code: commit <sha>` header line whenever the claims are
  re-read. The guard prints the recorded commit, so a stale anchor is visible.

## Flags

Every boolean flag is read through `services/gaia-api/src/flags.js` (`flag(env, name,
{ default })`); never add a bare `env.GAIA_X === 'true'`. The contract, the per-flag defaults
and the non-booleans are in the *Switches* table of `docs/architecture.md`; the reason the
helper exists is `docs/advice.md` C4 — three default-on passes used to switch themselves off,
silently, on a documented value.

## Migrations are immutable once applied

`schema_migrations` keys on the **filename**, so renaming an applied migration makes it run
again on every existing store — and that store is a live Postgres, not a fixture. New
migrations take the next free ascending number; the two historical `010_` files stay exactly
as they are. `services/cognition/src/db/migrate.js` (header) and
`services/cognition/test/migrations.test.js` enforce both halves.

## Merging is deploying

Check the path filters before merging, and say the consequence:

| workflow | triggers on | consequence |
| --- | --- | --- |
| `deploy.yml` | push to main touching `services/gaia-api/**` or `services/cognition/**` | resets the VPS checkout to `origin/main` and rebuilds **both** services |
| `publish-foundation.yml` | `docs/**`, `services/gaia-api/identity/soul.md` | publishes `foundation-artifact.json` and triggers a Gaia-Web rebuild |
| `verify-architecture.yml` | `docs/**`, `services/**`, `scripts/**` | the docs-drift guard |

On a **pull request** these run their test jobs and skip the deploy job, so "green on the PR"
does not prove the deploy works. Read the merge commit's runs before calling anything live.
