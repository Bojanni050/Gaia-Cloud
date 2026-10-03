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
 * the pipeline produce a well-formed ReasoningResult at all), and the
 * confidence distribution. What it cannot honestly measure: semantic
 * interpretation quality, hypothesis quality, or confidence calibration
 * — those require a real reasoning model's judgment, not a keyword stub,
 * and are named explicitly as v0.2 work in the implementation report.
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
    checks.push({ name: 'evidenceVerdict', pass: hasVerdict(result, exp.expectVerdict), got: result.hypotheses.flatMap((h) => h.evidenceAssessments.map((a) => a.verdict)) });
  }

  const structurallyValid = result.schemaVersion === 'logos.v1'
    && typeof result.interpretation === 'string'
    && Array.isArray(result.hypotheses)
    && Array.isArray(result.evidence)
    && typeof result.confidence === 'number';
  checks.push({ name: 'structuredOutputValid', pass: structurallyValid, got: structurallyValid });

  const degraded = Boolean(result.meta.fallbackReason);
  const allPassed = checks.every((c) => c.pass);

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
    failedChecks: r.checks.filter((c) => !c.pass),
  }));

  const report = {
    reasonerVersion: REASONER_VERSION,
    total,
    passRate: Math.round((passed / total) * 1000) / 1000,
    structuredOutputValidRate: Math.round((structuredValidCount / total) * 1000) / 1000,
    degradedRate: Math.round((degradedCount / total) * 1000) / 1000,
    shallowRate: Math.round((shallowCount / total) * 1000) / 1000,
    deepRate: Math.round((deepCount / total) * 1000) / 1000,
    hypothesisFormationRate: Math.round((withHypotheses / total) * 1000) / 1000,
    sufficiencyRate: Math.round((sufficientCount / total) * 1000) / 1000,
    confidenceStats,
    failures,
  };

  return { results, report };
}

module.exports = { runCase, runEvaluation };
