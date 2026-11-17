# scripts/

Operational tools, run by hand. None of them is part of the running service; one of them is
part of the image build. Four have an `npm run` alias so the ones you reach for most are
discoverable, and the rest is listed here — which is the point of this file: a dozen scripts
nobody could find were a dozen scripts nobody used (`docs/advice.md` C11).

| script | what it does | when to run it | writes | touches |
| --- | --- | --- | --- | --- |
| `generate-build-meta.js` | writes `build-meta.json`, the image's build stamp | never by hand — `Dockerfile:28` and `deploy.yml:113` call it | `build-meta.json` | nothing |
| `why-recall.js` — `npm run why:recall` | for a given message, which recall paths the live turn opens and which gate stayed shut. Same modules the turn uses; no server, no Hindsight | when you wonder why a memory did or did not show up | nothing | nothing |
| `summarize-logos-gate.js` — `npm run why:logos-gate` | the depth-gate cost monitor: how often a turn went `deep`, per UTC hour and per reason, so "what does the gate cost?" is a number | after touching the gate, or when the bill moves | nothing | a decision log file or directory |
| `summarize-turn-timing.js` | per-stage latency (count / mean / p50 / p95 / max) from the `turn.done` lines in a log | when a turn feels slow and you want the stages rather than a guess | nothing | a logfile or stdin |
| `survey-legacy-hypotheses.js` — `npm run survey:legacy-hypotheses` | surveys the pre-015 `proposed` residue and says which are worth settling; `--apply` lapses them | once, to decide what to do with that residue | only with `--apply` | `COGNITION_URL` |
| `reconcile-hindsight-tags.js` — `npm run reconcile:hindsight` | brings every derived record into the single `gaia:*` namespace; `--apply` re-pushes from Cognition, `--apply --clear` invalidates the old units first | after a tagging change, or when recall still answers in the old scheme | only with `--apply` | `HINDSIGHT_URL`, `COGNITION_URL` |
| `provision-knowledge-pages.js` | creates the initial Knowledge Page tree; idempotent — checks name and parent, fills in what is missing and PATCHes a page whose `source_query` drifted | once on a fresh bank, or when the page definitions change | yes | `HINDSIGHT_URL` |
| `provision-mental-models.js` | creates the seven standing mental models. `MENTAL_MODEL_IDS` in `src/memory.js` must match the ids made here | when that set changes | yes | `HINDSIGHT_URL` |
| `migrate-knowledge-pages-2026-08-29.js` | the one-off structural move of the `Communication` page (`User/Communication` → `Projects/Gaia/Communication`) | once, at that migration | yes | `HINDSIGHT_URL` |
| `validate-memory-worthiness.js` | runs the seven specified turns through the **real** streaming turn against a capturing fake Hindsight and reports every memory decision and its score | when you change the memoryworthiness gate | nothing | nothing |
| `validate-pattern-awareness.js` | the same, for pattern recall, against a faithful fake of Hindsight's HTTP surface | when you change pattern retrieval | nothing | a local http server it starts itself |
| `_scan-mojibake.js` | scans the files you name for BOMs, U+FFFD and cp1252 double-encodings, verifying each hit by round-tripping it | when text looks wrong in a file that was edited from Windows | nothing | the paths you pass as arguments |

Two things that are easy to get wrong.

**Safe by default.** The two `--apply` scripts survey and print first; nothing is written,
invalidated or retained without the flag. Keep that when you extend them: a script that writes
to a live store on a bare invocation is a script nobody dares run twice.

**A one-time script is not a safe script.** The dated migration and both provisioners write
records into a live store, so run them from a machine that can reach it (Tailscale, or the VPS
itself) and know what the store already holds. The store URLs default to the VPS's Tailscale
address (`100.65.0.15`) for Hindsight; Cognition follows `COGNITION_URL`, the same variable the
service reads.
