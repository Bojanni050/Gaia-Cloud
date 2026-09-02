# Conversational guidance: architecture decision

## Incident

A user said "Anton heeft van zich laten horen" (Anton got in touch). Gaia
responded with a specific, fabricated relational narrative about "Anton" and
"Thijs" and Thijs's parents — details that were never part of this
conversation or this user's history. See `CONVERSATIONAL_GROUNDING_FIX_SUMMARY.md`
for the incident detail.

The root cause was not a missing rule. It was a hardcoded "good example"
narrative — real prior-user details (names, places, relationships) baked into
`logos/conversationalOpportunity.js`'s "quality bar" text — that was injected
into the system prompt on nearly every turn. The model sometimes echoed those
literal example details as if they were facts about whoever it was currently
talking to.

## The broader question

Patching the specific names out of that example (which had already been done
once) does not fix the architecture — it fixes one instance of a structural
problem: the application was trying to *teach the LLM how to have a normal
conversation* through an ever-growing collection of good/bad response
examples, classification heuristics, and scoring, rather than trusting the
LLM's native conversational reasoning and giving it the right identity and
context instead.

## What was audited

`services/gaia-api/src/logos/conversationalOpportunity.js` (494 lines) and a
second, independent, duplicate system found during the audit,
`services/gaia-api/src/logos/conversationalState.js` (137 lines):

- `evaluateConversationalOpportunity()` — a hand-written heuristic classifier
  that decided, per turn, whether Gaia should show "curiosity", "celebration",
  "empathy", "reflection", or "acknowledgement", including a hardcoded
  `suggestedFollowUp` question string.
- `renderQualityBarLines()` — a ~70-line block of good/bad example phrasings
  ("Example bad: ...", "Example good: ...") teaching the model to avoid
  paraphrase, therapeutic language, and generic empathy — reasoning an LLM
  already does natively when told (once, briefly) what tone to use.
- `conversationalState.js` duplicated this: its own `inferInteractionType()`
  classifier (re-deriving signals IntentIQ already produced), its own
  hardcoded keyword/greeting lists, its own bespoke advisory prose, and it
  re-injected the *entire* quality bar from `conversationalOpportunity.js` on
  top, broadening the reach of the same example text to nearly every casual
  turn.
- Both were wired into `turn.js`'s system-prompt assembly as separate
  `system` messages, appended after SOUL, on every turn `reasonIQ` processed.

A repo-wide search found no other duplicate of this pattern outside these two
files. `services/gaia-api/identity/soul.md` already carries the durable,
identity-level version of the actual fix ("Factual Grounding & Relational
Context" — added 2026-08-23, before this audit): explicit instructions, in
Gaia's own voice, to distinguish stated facts from assumptions and to ask
rather than invent when a statement is ambiguous. That section already
governs the "Anton" scenario; the per-turn classifier and quality bar were
redundant with it, and vulnerable in a way SOUL is not: examples baked into
a heuristics file can (and did) leak real content into the general case.

## Decision

**CURRENT (before this change):**

```
User message
  → intentIQ (intent classification)
  → reasonIQ → evaluateConversationalOpportunity() (heuristic: naturalResponse, suggestedFollowUp)
  → turn.js assembles system prompt:
      SOUL + capability/memory/mentalModel/pattern context
      + renderOpportunityGuidance()   (opportunity-specific advisory + full quality bar)
      + renderConversationalState()   (own classifier + own advisory + quality bar again)
  → LLM
```

**PROPOSED / IMPLEMENTED:**

```
User message
  → current conversation context
  → relevant memory (Hindsight recall)
  → Gaia SOUL / identity (includes factual-grounding guidance)
  → relevant tools/context (capability, mental model, pattern, attachment blocks)
  → LLM (does the conversational reasoning: tone, empathy, follow-up judgment)
  → response
```

`intentIQ` and `reasonIQ`'s actual reasoning (hypotheses, evidence,
contradictions) are unchanged and stay — that is genuine application-level
orchestration (routing, evidence provenance, structured state) that an LLM
call should not silently redo per turn. What was removed is only the layer
that tried to pre-decide *how to sound* and *what to notice* in ordinary
conversation.

## What changed

- **Removed** — `services/gaia-api/src/logos/conversationalOpportunity.js` and
  `services/gaia-api/src/logos/conversationalState.js`, in full. Their exports
  (`evaluateConversationalOpportunity`, `renderOpportunityGuidance`,
  `renderQualityBar`, `inferInteractionType`, `renderConversationalState`) are
  gone, along with the `ConversationalOpportunity` typedef and
  `CONVERSATIONAL_RESPONSES`/`isValidNaturalResponse` in `reasonModels.js`,
  the call site and fallback in `reasonIQ.js`, the field logged in
  `reasonLog.js`, and the two system-message injections in `turn.js`.
- **Fixed** — a live twin of the same leftover-example bug in
  `services/gaia-api/src/logos/intentIQ.js`'s `isVolunteeredPersonalSharing()`:
  its personal-marker regex still hardcoded `papegaai`/`Ierland`/`Maarn` from
  the original incident's narrative (not yet triggered, but the same category
  of defect). Replaced with generic Dutch relationship/family markers.
- **Kept** — `intentIQ.js`'s actual intent taxonomy and routing (needed for
  tool/capability selection — application-level, not conversational style),
  `reasonIQ.js`'s evidence/hypothesis reasoning (unrelated, unaffected), all
  memory retrieval and rendering (`memory.js`), capability/mental-model/
  pattern context blocks, and SOUL itself (`identity/soul.md`) — where the
  durable version of the actual guidance now lives.
- **Not replaced with a new prompt.** No new heuristic classifier, keyword
  list, or example block was added. SOUL's existing factual-grounding section
  already covers the behavior the removed code was trying to hand-simulate.

## Regression risk

Losing the removed code's most specific behaviors (e.g. "ask 'what brings
you there?' after a location answer") is intentional and expected — those
were exactly the kind of prescriptive, example-driven conversational
micromanagement this change moves away from. The LLM, given SOUL and the
actual conversation, can already produce natural acknowledgements, curiosity,
and follow-up without being told the specific phrasing to use.

The residual risk is a regression toward more generic or repetitive
responses if SOUL's guidance proves insufficient in practice. If that shows
up, the fix belongs in SOUL (a small, durable, identity-level addition — no
examples with real names) or in a narrow, deterministic mechanism — not in
a new per-turn classifier.

See `services/gaia-api/test/conversationalGrounding.test.js` for the
regression coverage: the Anton case no longer produces any of the original
leaked narrative fragments, and memory retrieval for genuinely established
context (e.g. "weet je nog wie Anton is?") still reaches the prompt normally.
