# Documents — what lives here, and which one wins

An index, not a second copy of anything. When a document's status changes, change its line
here in the same commit: an index that ages is the same problem it was written to solve
(`docs/advice.md` A8). The statuses below are what each document says about itself, not a
guess from its last-modified date — every file here shows 2026-11-11 because `docs/` was
deleted and reverted that day.

## Which document is authoritative for what

| question | look at |
| --- | --- |
| what is wired how (paths, routes, flags, stores, delivery) | `architecture.md` — and it is machine-checked |
| how a change is made here (the log, the audit, languages, what a merge does) | `CONVENTIONS.md` |
| what is open, with evidence and per-item status | `advice.md` |
| who she is, in her own terms | `identity.md` |
| the constitution, and her vocabulary | `principles.md`, `lexicon.md` |
| layout, commands, the live system, local traps (for an agent) | `AGENTS.md`, in the repository root |

One conflict worth naming: `AGENTS.md` carries blocks appended from other projects, and its
*walkthrough-protocol* block describes an older three-bullet entry. `CONVENTIONS.md` is the
maintained version and wins — four bullets plus `Open punt:`.

## The documents

| document | what it is | status |
| --- | --- | --- |
| `architecture.md` | code truth: paths, routes, flags, the three stores, the lifecycle, the HTTP surface | **active** — `Verified against code: d11abca` (2026-11-16), re-checked by `scripts/verify-architecture.js` in CI. The anchor is the commit the claims were *read* at, not the current tip. Runtime content |
| `identity.md` | what she knows about herself, in her own terms | active — handed to a turn that is about her; runtime content |
| `principles.md` | the constitution the rest is derived from | active — runtime content |
| `lexicon.md` | her vocabulary | active — runtime content |
| `evolution.md` | the history up to 2026-10-14 | **frozen** (`status: frozen`, 2026-11-11). Still bundled, no longer selected per turn; the dated log continues in the root's `walkthrough*.md` |
| `CONVENTIONS.md` | how a change is made here | active |
| `advice.md` | the audit of 2026-11-11 (against `5a9e1d9`): drift rows, A1-A8, C1-C12, with the status maintained in place | active — **its line numbers have drifted: re-verify a claim against the code before acting on it** |
| `architecture-graph.md` + `.html` | the visual map of the system | **stale — do not trust it yet**: still the 4-step deferred drawing, no Aion/Eleos, no `/memory`, `/eleos`, `/research` (`docs/advice.md` A4) |
| `memory-pipe.md` | the one path a turn reads long-term memory through and writes into it, as the code builds it | reference — the seams it names still exist, but it predates the 2026-10-23 recall split and the CortexIQ plan |
| `memory-pipe-issues.md` | a code review of that pipe, findings by severity | that review's findings; several were fixed since — check before acting |
| `desktop-capability.md` | the confirmation flow for working on the person's own computer | active — `architecture.md` points here |
| `desktop-client-task.md` | a task description for a session in the Gaia-Desktop repo | handoff to that repository |
| `background-voice-cloud-spec.md` | the cloud half of background voice | carries its own status line: C1 implemented on a branch, C2/C3 proposed |
| `skill-acquisition.md` | what Gaia may learn, and the phases of it | active — phase 0 and the measurement are built; phases 1 and 2 are not |
| `spike-cortexiq.md` | the CortexIQ spike: measurements, conclusion, order of steps | active decision material; nothing of it is built |
| `handover-2026-10-23-optie2.md` | the optie-2 handover with its open items | mostly executed; item 4's survey tool landed 2026-11-16 |
| `foundation ingestion capture-rs.md` | what does *not* happen between Foundation and Gaia | constraints and reference |
| `Epistemic Memory & Execution Rules .txt` | the one-way rule and the execution rules behind the derived store | principle text, reference |
| `Project Gaia/Project Gaia - Main Document.pdf` | the leidend document: the vision | tracked; its editable source and the sync database stay local (`.gitignore`) |
| `proposals/main-document-*.md` | chapter drafts for the Main Document | proposals — some carry a decision (afgeleide kennis: optie A, 2026-10-16) |

Two kinds of document are deliberately **not** here: the dated log (`walkthrough.md`,
`walkthrough2.md`) lives in the repository root, and the client-side documents live in the
client repositories (`gaia-desktop`, `gaia-web`).

## Loose ends in the root

`AGENTS.md` is the agent-facing entry and is maintained. Two files are leftovers from August
and September that belong to nothing current: `test_result.md` (a testing protocol for a
two-agent setup that no longer exists, 2026-08-06) and
`CONVERSATIONAL_GROUNDING_FIX_SUMMARY.md` (2026-09-02). Removing them is Bo's decision, not a
side effect of this index.
