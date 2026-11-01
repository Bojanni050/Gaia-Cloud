'use strict';

/**
 * Logos evaluation harness. Runs eva./logos-cases.js (synthetic,
 * see that file's own header) against reasonIQ.evaluate(), using
 * logosModelStub.js's deterministic stand-in reasoning model —
 * see eval/README.md for why: this sandbox has no live reasoning-model
 * credential to score against a real LLM.
 *
 * What this can honestly measure against a stub: reasoning-depth gating
 * accuracy, whether a hypothesis was formed when one was expected,
 * whether the expected evidence verdict appears somewhere in the result,
 * sufficiency/information-gap flagging, structured-output validity (did
 * the pipeline produce a well-formed ReasoningResult at all), citation
 * integrity (does every evidence verdict cite evidence that was actually
 * supplied for the turn — the one faithfulness failure detectable without
 * judging semantics), and the confidence distribution. What it cannot
 * honestly measure: semantic interpretation quality, hypothesis quality,
 * confidence calibration, or whether an adversarial false-memory turn is
 * semantically refused — those require a real reasoning model's judgment,
 * not a keyword stub, and are named explicitly as v0.2 work in the
 * implementation report.
 */

const { evaluate } = require('../src/logos/logos');
const { REASONER_VERSION } = require('../src/logos/logosSchema');

function hasVerdict(result, verdict) {
  return result.hypotheses.some((h) => h.evidenceAssessments.some((a) => a.verdict === verdict));
}

/**
 * @param {import('./logos-cases').CASES[number]} testCase
 * @param {object} model
 */
async function runCase(testCase, model) {
  const result = await evaluate(testCase.input, { model, silent: true });
  // The stub self-identifies as 'stub' (logosModelStub) — verdict-direction
  // expectations marked `stubVerdictUndecidable` are enforced only against a
  // live model (see logos-cases.js header).
  const isStub = Boolean(model && model.config && model.config.provider === 'stub');

  const checks = [];
  const exp = testCase.expect || {};

  if (exp.reasoningDepth) {
    checks.push({ name: 'reasoningDepth', pass: result.reasoningDepth === exp.reasoningDepth, got: result.reasoningDepth });
  }
  if (typeof exp.minHypotheses === 'number') {
    checks.push({ name: 'minHypotheses', pass: result.hypotheses.length >= exp.minHypotheses, got: result.hypotheses.length });
  }
  if (typeof exp.expectSufficient === 'boolean') {
    checks.push({ name: 'sufficientForConclusion', pass: result.sufficientForConclusion === exp.expectSufficient, got: result.sufficientForConclusion });
  }
  if (exp.expectGap) {
    checks.push({ name: 'informationGaps', pass: result.informationGaps.length > 0, got: result.informationGaps.length });
  }
  if (exp.expectVerdict) {
    if (isStub && exp.stubVerdictUndecidable) {
      checks.push({
        name: 'evidenceVerdict',
        skipped: true,
        reason: 'verdict direction marked stubVerdictUndecidable — a live-model criterion the keyword stub cannot judge',
      });
    } else {
      checks.push({ name: 'evidenceVerdict', pass: hasVerdict(result, exp.expectVerdict), got: result.hypotheses.flatMap((h) => h.evidenceAssessments.map((a) => a.verdict)) });
    }
  }

  const structurallyValid = result.schemaVersion === 'logos.v1'
    && typeof result.interpretation === 'string'
    && Array.isArray(result.hypotheses)
    && Array.isArray(result.evidence)
    && typeof result.confidence === 'number';
  checks.push({ name: 'structuredOutputValid', pass: structurallyValid, got: structurallyValid });

  // Citation integrity (structural faithfulness, see the header): a verdict
  // may only be grounded in evidence the turn actually received. This is the
  // one hallucination class the harness can catch without a real model — a
  // verdict whose evidence text appears nowhere in the supplied material is
  // fabrication whatever the semantics. A result with no assessments has
  // nothing cited and passes trivially.
  const suppliedEvidence = new Set(result.evidence.map((e) => String(e && e.content != null ? e.content : e).trim()));
  const citedEvidence = (result.hypotheses || [])
    .flatMap((h) => h.evidenceAssessments || [])
    .map((a) => a && a.evidence)
    .filter((s) => typeof s === 'string' && s.trim());
  checks.push({ name: 'citationIntegrity', pass: citedEvidence.every((c) => suppliedEvidence.has(c.trim())), got: citedEvidence.length });

  const degraded = Boolean(result.meta.fallbackReason);
  const allPassed = checks.every((c) => c.skipped || c.pass);

  return { case: testCase, result, checks, degraded, allPassed };
}

/**
 * @param {Array<object>} cases
 * @param {object} model reasoning model to evaluate against (defaults to the labeled stub)
 */
async function runEvaluation(cases, model) {
  const results = [];
  for (const c of cases) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runCase(c, model));
  }

  const total = results.length;
  const passed = results.filter((r) => r.allPassed).length;
  const degradedCount = results.filter((r) => r.degraded).length;
  const shallowCount = results.filter((r) => r.result.reasoningDepth === 'shallow').length;
  const deepCount = results.filter((r) => r.result.reasoningDepth === 'deep').length;
  const withHypotheses = results.filter((r) => r.result.hypotheses.length > 0).length;
  const sufficientCount = results.filter((r) => r.result.sufficientForConclusion).length;
  const structuredValidCount = results.filter((r) => r.checks.find((c) => c.name === 'structuredOutputValid')?.pass).length;

  const confidences = results.map((r) => r.result.confidence);
  const confidenceStats = confidences.length
    ? {
      min: Math.min(...confidences),
      max: Math.max(...confidences),
      avg: Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100,
    }
    : { min: null, max: null, avg: null };

  const failures = results.filter((r) => !r.allPassed).map((r) => ({
    id: r.case.id,
    input: r.case.input.text,
    failedChecks: r.checks.filter((c) => !c.pass && !c.skipped),
  }));

  // Keep the stub-skip VISIBLE, never silent: these cases still carry their
  // verdict expectation for a live-model scoring run (provider not 'stub').
  const stubSkippedCount = results.filter((r) => r.checks.some((c) => c.skipped)).length;

  // Category stats: adversarial cases carry their own `category` (see
  // logos-cases.js) so their pass rate can be tracked — and later re-scored
  // against a live reasoning model — without the general set diluting it.
  const categoryBuckets = {};
  for (const r of results) {
    const cat = r.case.category || 'general';
    if (!categoryBuckets[cat]) categoryBuckets[cat] = { total: 0, passed: 0 };
    categoryBuckets[cat].total += 1;
    if (r.allPassed) categoryBuckets[cat].passed += 1;
  }
  const categoryStats = Object.fromEntries(Object.entries(categoryBuckets).map(([name, bucket]) => [
    name,
    { total: bucket.total, passRate: Math.round((bucket.passed / bucket.total) * 1000) / 1000 },
  ]));

  const citationValidCount = results.filter((r) => r.checks.find((c) => c.name === 'citationIntegrity')?.pass).length;

  const report = {
    reasonerVersion: REASONER_VERSION,
    total,
    passRate: Math.round((passed / total) * 1000) / 1000,
    structuredOutputValidRate: Math.round((structuredValidCount / total) * 1000) / 1000,
    citationIntegrityRate: Math.round((citationValidCount / total) * 1000) / 1000,
    degradedRate: Math.round((degradedCount / total) * 1000) / 1000,
    shallowRate: Math.round((shallowCount / total) * 1000) / 1000,
    deepRate: Math.round((deepCount / total) * 1000) / 1000,
    hypothesisFormationRate: Math.round((withHypotheses / total) * 1000) / 1000,
    sufficiencyRate: Math.round((sufficientCount / total) * 1000) / 1000,
    confidenceStats,
    categoryStats,
    stubSkippedVerdictCases: stubSkippedCount,
    failures,
  };

  return { results, report };
}

module.exports = { runCase, runEvaluation };
