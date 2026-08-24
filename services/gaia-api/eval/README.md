# Logos evaluation harnesses

Three IntentIQ harnesses and one ReasonIQ harness live here. They don't
share cases or scoring: each answers a different question
(architecture.md §4.2) and is evaluated separately.

# IntentIQ evaluation harness

Runs `eval/cases.js` — a **synthetic design/evaluation set**, not real user
data — against the current `src/logos/intentIQ.js` classifier and reports
coherence, not just accuracy.

```bash
npm run eval:intent
```

## What this checks

- **accuracy** — status/intent matched what a case expected (or one of its
  `acceptableAlternatives`).
- **unknown rate / ambiguous rate** — how often IntentIQ declines to force
  a classification. Neither rate is a bug by itself; a taxonomy this new
  should produce real unknowns and real ambiguity on the harder cases.
- **confidence distribution** — min/max/avg confidence across accepted
  cases. Confidence is capped at 0.95 in the classifier itself (never
  reported as certainty); this stat is here to catch a classifier that's
  systematically over- or under-confident, not to chase a single number.
- **confusion** — for each case's expected outcome, which actual outcomes
  it produced. Read this before the accuracy number — it shows *which*
  intents get confused with which, not just how often something was wrong.
- **mismatches** — the literal list of cases that didn't match, with why.

## What this is not

Not a training set, not a benchmark to optimize against by adding more
keyword patterns until every case passes, and not evidence about real
Gaia users — see `eval/cases.js`'s own header comment. Its job is to keep
the taxonomy and the classifier honest against each other as both evolve.

## Updating

- Add cases as real usage surfaces gaps — mark anything still invented
  clearly, the way the existing set does.
- If a mismatch reveals the *taxonomy* is wrong (not just the classifier),
  that is a taxonomy change, and belongs back in the design report's
  review process — not a quiet edit to `expectedIntent` here to make the
  harness pass.

---

# IntentIQ 2.3 evaluation runner + feedback analyzer

The 2.3 layer makes the runtime feedback seam (`src/logos/intentFeedback.js`)
and the decision logs systematically analyzable:

```bash
npm run eval:intent-eval            # heuristic-only (semantic metrics N/A)
npm run eval:intent-eval -- --mock  # with the deterministic fixture semantic model
```

- `eval/intent-eval.json` — 96 synthetic cases across every intent family,
  plus follow-up, ambiguous, source-of-truth, reference-resolution, bare
  interrogative ("why?" with/without context), personhood, explanation-frame
  and documented heuristic-conflict ("trap") cases whose expectations state
  the TRUE intent, so a heuristic-only mismatch is itself the finding.
  Grown from the measured 2.3 findings: every new rule carries positive,
  negative, contextual and follow-up coverage.
- `eval/evaluationRunner.js` — loads the dataset, runs the full cascade
  (`interpret()` over `classify()`), and reports: accuracy, an
  expected-x-predicted confusion matrix, confidence calibration bands,
  over/underconfidence findings, semantic-call efficiency
  (`semanticValueRate`, with confirmations-that-reduced-uncertainty counted
  separately), heuristic/semantic conflict statistics, and
  reference-resolution statistics. Always prints the calibration config it
  ran under and ends with recommendations that are strings for humans —
  nothing is ever applied automatically.
- `src/logos/intentFeedbackAnalyzer.js` — the pure analysis core. Consumes
  'intentiq.feedback' + 'intentiq.decision' records (joined on
  correlationId), produces statistics only. No I/O except loadRecords(),
  no decisions, no self-tuning: the calibration loop is
  feedback → offline analysis → human-reviewed change → evaluation →
  release, deliberately with no online shortcut.

The `--mock` model is a fixture (like reasoningModelStub.js for ReasonIQ):
its numbers say "the pipeline behaves sanely", never "the semantic model is
good". Point `runEvaluation(dataset, { model })` at a real configured
model to measure the actual tier.

---

# ReasonIQ evaluation harness

Runs `eval/reason-cases.js` — also a **synthetic design/evaluation set** —
against `src/logos/reasonIQ.js`.

```bash
npm run eval:reason
```

## The honesty problem this harness has to admit up front

This sandbox has **no live reasoning-model credential**. `npm run
eval:reason` scores ReasonIQ's pipeline against
`src/logos/reasoningModelStub.js` — a deterministic, keyword-overlap
stand-in that is explicitly **not a real reasoning model** (see that
file's own header comment). The harness is genuinely useful for what it
*can* check without semantic understanding — reasoning-depth gating,
whether a hypothesis gets formed, structured-output validity, sufficiency
and information-gap flagging, confidence bounds — but a passing or
failing `evidenceVerdict` check often just reflects the stub's crude
negation/word-overlap heuristic, not ReasonIQ's actual reasoning quality.
Treat the pass rate as "does the pipeline behave sanely end-to-end,"
never as "ReasonIQ reasons correctly." That second question needs a real
configured `REASONIQ_MODEL_*` model and is v0.2 work — see the ReasonIQ
v0.1 implementation report.

## What this checks

- **structured output valid rate** — did the pipeline produce a
  well-formed `ReasoningResult` at all (schema shape, required fields).
- **degraded (fallback) rate** — how often the model call failed or
  returned unusable output and ReasonIQ fell back to an honest, empty
  result instead of guessing. Against the stub this should be ~0; a
  nonzero rate here usually means a bug in the stub or the prompt/parse
  contract, not a reasoning failure.
- **shallow / deep rate** — how often ReasonIQ decided the reasoning
  model wasn't warranted at all (§6 of the brief).
- **hypothesis formation rate** — how often a hypothesis was formed when
  the case supplied evidence to reason over.
- **sufficiency rate** — how often ReasonIQ judged the available
  information sufficient for a conclusion.
- **confidence distribution** — bounded below 0.95 by construction
  (`reasonValidate.js`); this stat catches a systematically mis-tuned
  case set, not model quality.
- **failures** — the literal list of cases whose expectations didn't
  hold, with which specific check failed.

## What this is not

Not a benchmark for the stub, not evidence ReasonIQ reasons well, and not
real user data. Its job — same as the IntentIQ harness — is to keep the
pipeline honest about its own contract (never a training target).
