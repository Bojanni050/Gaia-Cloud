'use strict';

/**
 * IntentIQ evaluation harness.
 *
 * Runs a set of design/evaluation cases (eval/cases.js — synthetic, not
 * real user data) against the current classifier and reports coherence,
 * not just accuracy: unknown/ambiguous rates, confidence distribution,
 * and confusions between similar intents, because false confidence and
 * inappropriate forced classification matter as much as raw hit rate
 * (design report Phase 8, plus this module's own implementation brief).
 */

const { classify, CLASSIFIER_VERSION } = require('../src/logos/intentIQ');

/**
 * @param {import('./cases').CASES[number]} testCase
 * @returns {{ case: object, decision: object, outcome: 'match'|'mismatch', why: string }}
 */
function runCase(testCase) {
  const messages = [...(testCase.context || []), { role: 'user', content: testCase.input }];
  const decision = classify(messages, { silent: true });

  let outcome = 'mismatch';
  let why = '';

  if (testCase.expectUnknown) {
    outcome = decision.status === 'unknown' ? 'match' : 'mismatch';
    why = `expected unknown, got ${decision.status}`;
  } else if (testCase.expectAmbiguous) {
    outcome = decision.status === 'ambiguous' ? 'match' : 'mismatch';
    why = `expected ambiguous, got ${decision.status}`;
  } else {
    const acceptable = [testCase.expectedIntent, ...(testCase.acceptableAlternatives || [])];
    const matched = decision.status === 'accepted' && acceptable.includes(decision.intent);
    outcome = matched ? 'match' : 'mismatch';
    why = matched ? '' : `expected one of [${acceptable.join(', ')}], got ${decision.status}/${decision.intent}`;
  }

  return { case: testCase, decision, outcome, why };
}

/**
 * @param {Array<object>} cases
 * @returns {{ results: Array, report: object }}
 */
function runEvaluation(cases) {
  const results = cases.map(runCase);

  const total = results.length;
  const matches = results.filter((r) => r.outcome === 'match').length;
  const unknownCount = results.filter((r) => r.decision.status === 'unknown').length;
  const ambiguousCount = results.filter((r) => r.decision.status === 'ambiguous').length;
  const acceptedCount = results.filter((r) => r.decision.status === 'accepted').length;

  const confidences = results.filter((r) => r.decision.status === 'accepted').map((r) => r.decision.confidence);
  const confidenceStats = confidences.length
    ? {
      min: Math.min(...confidences),
      max: Math.max(...confidences),
      avg: Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100,
    }
    : { min: null, max: null, avg: null };

  // Confusion: expected intent (or 'ambiguous'/'unknown') -> observed outcome, counted.
  const confusion = {};
  for (const r of results) {
    const expectedKey = r.case.expectUnknown ? 'unknown' : r.case.expectAmbiguous ? 'ambiguous' : r.case.expectedIntent;
    const observedKey = r.decision.status === 'accepted' ? r.decision.intent : r.decision.status;
    confusion[expectedKey] = confusion[expectedKey] || {};
    confusion[expectedKey][observedKey] = (confusion[expectedKey][observedKey] || 0) + 1;
  }

  const mismatches = results.filter((r) => r.outcome === 'mismatch').map((r) => ({
    id: r.case.id,
    input: r.case.input,
    expected: r.case.expectUnknown ? 'unknown' : r.case.expectAmbiguous ? 'ambiguous' : r.case.expectedIntent,
    observedStatus: r.decision.status,
    observedIntent: r.decision.intent,
    why: r.why,
  }));

  // IntentIQ 2.2 — calibration metrics, additive to the accuracy report
  // above. `wouldEscalateCount` is what interpret()'s own cascade condition
  // (`status !== 'accepted' || needsSemanticCheck`) would trigger on this
  // set — i.e. the semantic-tier call rate a live deployment would see,
  // computed from the heuristic tier alone (this harness has no semantic
  // model configured; see eval/run.js's own note about that).
  const wouldEscalateCount = results.filter((r) => r.decision.status !== 'accepted' || r.decision.needsSemanticCheck).length;
  const needsSemanticCheckCount = results.filter((r) => r.decision.needsSemanticCheck).length;
  const confidenceLevelCounts = { high: 0, medium: 0, low: 0 };
  for (const r of results) {
    const level = r.decision.confidenceLevel;
    if (level && confidenceLevelCounts[level] !== undefined) confidenceLevelCounts[level] += 1;
  }
  const insufficientContextCount = results.filter((r) => r.decision.interpretationStatus === 'insufficient_context').length;

  const report = {
    classifierVersion: CLASSIFIER_VERSION,
    total,
    accuracy: Math.round((matches / total) * 1000) / 1000,
    unknownRate: Math.round((unknownCount / total) * 1000) / 1000,
    ambiguousRate: Math.round((ambiguousCount / total) * 1000) / 1000,
    acceptedRate: Math.round((acceptedCount / total) * 1000) / 1000,
    confidenceStats,
    confusion,
    mismatches,
    // 2.2 additions — heuristic-tier-only (no semantic model configured in
    // this harness); see eval/run.js for the honest caveat on what
    // "semantic call rate" means without one.
    needsSemanticCheckRate: Math.round((needsSemanticCheckCount / total) * 1000) / 1000,
    wouldEscalateToSemanticRate: Math.round((wouldEscalateCount / total) * 1000) / 1000,
    confidenceLevelCounts,
    insufficientContextRate: Math.round((insufficientContextCount / total) * 1000) / 1000,
  };

  return { results, report };
}

module.exports = { runCase, runEvaluation };
