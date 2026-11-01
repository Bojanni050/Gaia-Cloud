# Evaluation harnesses

The Logos, hypothesis, pattern and memoryworthiness harnesses live here. They
don't share cases or scoring: each answers a different question
(architecture.md §4.2) and is evaluated separately.

# Logos evaluation harness

Runs `eval/logos-cases.js` — also a **synthetic design/evaluation set** —
against `src/logos/logos.js`.

```bash
npm run eval:logos
```

## The honesty problem this harness has to admit up front

This sandbox has **no live reasoning-model credential**. `npm run
eval:logos` scores Logos's pipeline against
`src/logos/logosModelStub.js` — a deterministic, keyword-overlap
stand-in that is explicitly **not a real reasoning model** (see that
file's own header comment). The harness is genuinely useful for what it
*can* check without semantic understanding — reasoning-depth gating,
whether a hypothesis gets formed, structured-output validity, sufficiency
and information-gap flagging, confidence bounds — but a passing or
failing `evidenceVerdict` check often just reflects the stub's crude
negation/word-overlap heuristic, not Logos's actual reasoning quality.
Treat the pass rate as "does the pipeline behave sanely end-to-end,"
never as "Logos reasons correctly." That second question needs a real
configured `REASONIQ_MODEL_*` model — see that file's own header comment.

## What this checks

- **structured output valid rate** — did the pipeline produce a
  well-formed `ReasoningResult` at all (schema shape, required fields).
- **citation integrity rate (faithfulness, structural)** — does every
  evidence verdict cite evidence that was actually supplied for the
  turn? A verdict grounded in evidence the turn never received is
  fabrication that no semantic judgment is needed to detect; this is
  the floor of the faithfulness question while the harness runs
  against the stub.
- **adversarial categories** — cases carry a `category`
  (`adversarial-false-memory`, `adversarial-vagueness`,
  `adversarial-overclaim`) and are scored separately in the report so
  the weakest-point pass rate is visible on its own and can be
  re-scored against a live reasoning model without the general set
  diluting it. Their rule: a user asserting a shared memory, an
  agreement, or a settled fact Logos has no record of must be
  refused, probed, or marked unverified — never silently accepted.
- **verdict checks skipped vs stub** — some verdict-direction
  expectations (`expect.stubVerdictUndecidable: true`) are criteria a
  live reasoning model must meet that the keyword stub cannot judge
  (e.g. "replies within minutes contradicts an async preference").
  Against the stub they are skipped, visibly counted in the report,
  and kept in the case so a live-model run enforces them.
- **degraded (fallback) rate** — how often the model call failed or
  returned unusable output and Logos fell back to an honest, empty
  result instead of guessing. Against the stub this should be ~0; a
  nonzero rate here usually means a bug in the stub or the prompt/parse
  contract, not a reasoning failure.
- **shallow / deep rate** — how often Logos decided the reasoning
  model wasn't warranted at all (§6 of the brief).
- **hypothesis formation rate** — how often a hypothesis was formed when
  the case supplied evidence to reason over.
- **sufficiency rate** — how often Logos judged the available
  information sufficient for a conclusion.
- **confidence distribution** — bounded below 0.95 by construction
  (`reasonValidate.js`); this stat catches a systematically mis-tuned
  case set, not model quality.
- **failures** — the literal list of cases whose expectations didn't
  hold, with which specific check failed.

## What this is not

Not a benchmark for the stub, not evidence Logos reasons well, and not
real user data. Its job — same as the Logos harness — is to keep the
pipeline honest about its own contract (never a training target).
