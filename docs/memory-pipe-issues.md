# The memory pipe — problems and fragile points

Findings from a code review of the memory pipe (`docs/memory-pipe.md` maps the
pipeline itself). Ordered by severity, each with its evidence in the code.
Some are genuine defects, some are deliberate trade-offs that remain fragile.

## Real problems

### 1. Silent recall failure becomes an honest lie

`recallRelevantContext` swallows every error into `[]` (`src/memory.js`), and
the cross-bank client does `catch(() => [])` per bank
(`src/hindsightClient.js`). A slow or unreachable bank is therefore
*imperceptibly absent*. Gaia then honestly denies a memory she does have —
exactly what happened live with the Yassine conversation (21 turns, gate
shut, "ik heb niets over Yassine" while eleven valid items sat in her own
bank). The `hindsight.call_failed` log line makes the drop visible to an
operator, but nothing in the turn prompt says "this recall may be
incomplete". The capability claim makes it worse: `turn.js` claims the
`hindsight` capability as soon as `recall` is a function — even when all
three banks just fell over.

Fix direction: propagate a skip/fail signal on the recall return path into
the prompt (e.g. a line "recall was incomplete, bank X dropped"), so she can
say "I cannot consult my memory right now" instead of "I have nothing".

### 2. The score tail of `mergeBankSlices` reintroduces the old problem

The per-bank quota reserve (`CROSS_BANK_QUOTA = 3`) is the measured answer
to incomparable bank scores, but everything after the quota rounds is flat
sorted on `scores.final` — precisely the flat sort that was proven to let
one bank's noise beat another bank's true statements. As soon as a bank has
more than 3 relevant items (or `MEMORY_MAX_LINES` goes up), the noise
returns. Fix direction: make the tail round-robin per bank too, not
score-ordered.

### 3. The lexical gate is a patch-per-incident list

`src/memoryPolicy.js` grows one signal per hole, each closed after a live
failure ("wat weet je over" after Yassine, then "geheugen"). Every next
paraphrase ("ken je nog", "hoe zat het ook alweer met") is a new hole. The
designed answers exist — IntentIQ and `pastReference` can open the gate, and
the `search_memory` tool is the explicit escape hatch — but the default
remains: one missed cue costs the entire recall on a turn that asked for
it.

### 4. Gate and retrieval read different text

The gate judges the question as written; retrieval receives
`distillQuery(query)`. That is motivated (whole sentences pushed the right
fact to rank 38), but the distillation can drop the very word that opened
the gate — or the entity recall needs. Nothing checks that the distilled
query still carries the person or subject of the question.

### 5. No auth on Hindsight

`src/hindsightClient.js` states it explicitly: Tailscale membership is the
only access control, on all three banks — including `gaia`, her own,
human-side bank. Every node on the tailnet can read and write the full
memory (recall, patch, invalidate). The other services share the posture,
but here `PATCH state=invalidated` and `DELETE` sit within reach with no
identity of their own.

### 6. `reflect` without a timeout

The async retain deliberately sends no abort signal (`timeout: null`)
because extraction takes 10–20 s. But "no limit" is not the same as "a
generous limit": a hanging Hindsight leaves an open socket and promise per
turn, invisible because fire-and-forget. A generous cap (e.g. 60 s) costs
nothing and closes the leak.

## Deliberate trade-offs that stay fragile

### 7. Double retention across banks

The same event can land as a conversation reflection in `bojan` and as a
hypothesis mirror in `gaia-logos`. Dedupe happens only at render time and
only on exact-line match (`condenseMemoryEntries` in `src/memory.js`). One
rephrasing and the same statement appears twice, in two epistemic guises.

### 8. Version maps live in memory only

`src/reasoning/cognitionSync.js` acknowledges it: the version/status maps
are in-process, seeded from Hindsight on first use. If the seed fails
(Hindsight briefly unreachable), the next change looks like version 1 — a
second active unit is retained and the old one is never invalidated. A
correctly-by-construction design with a close-race edge case.

### 9. Timeout headroom

After the Jina rerank switch, `bojan` measures ~1.9 s against a 4 s default
cap. One Jina rate-limit (degrade to RRF) plus some load and the richest
bank drops again — the outage this path already had once, in a new coat.

## Overall

The architecture is sound — gates, provenance, best-effort and one-way flow
are applied consistently — but the best-effort philosophy has a blind spot:
failure is invisible to Gaia herself. Priority one is the skip/fail signal
into the prompt; priority two is the round-robin tail.
