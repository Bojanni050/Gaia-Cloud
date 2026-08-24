#!/usr/bin/env node
'use strict';

/**
 * CLI entry for the IntentIQ evaluation harness.
 * Usage: node eval/run.js  (or: npm run eval:intent)
 *
 * Runs against classify() only (the heuristic tier) — no semantic model is
 * configured in this environment (GAIA_INTENT_BASE_URL unset), so the 2.2
 * "would this turn have called the semantic tier" metrics below are
 * computed from needsSemanticCheck/status alone, not a live semantic call.
 * That is an honest, still-useful number (it's exactly interpret()'s own
 * cascade condition), but actual heuristic/semantic *agreement* is not
 * measurable without a configured model — reported as N/A rather than
 * guessed.
 */

const { CASES, CASES_2_2 } = require('./cases');
const { runEvaluation } = require('./harness');

function printReport(label, report) {
  console.log(`\n=== ${label} ===`);
  console.log(`classifier:              ${report.classifierVersion}`);
  console.log(`cases:                   ${report.total}`);
  console.log(`accuracy:                ${report.accuracy}`);
  console.log(`accepted rate:           ${report.acceptedRate}`);
  console.log(`unknown rate:            ${report.unknownRate}`);
  console.log(`ambiguous rate:          ${report.ambiguousRate}`);
  console.log(`confidence:              min=${report.confidenceStats.min} max=${report.confidenceStats.max} avg=${report.confidenceStats.avg}`);
  console.log(`needsSemanticCheck rate: ${report.needsSemanticCheckRate}`);
  console.log(`would-escalate rate:     ${report.wouldEscalateToSemanticRate}  (status!=='accepted' || needsSemanticCheck — interpret()'s own cascade condition)`);
  console.log(`confidenceLevel counts:  ${JSON.stringify(report.confidenceLevelCounts)}`);
  console.log(`insufficient_context:    ${report.insufficientContextRate}`);

  if (report.mismatches.length) {
    console.log(`mismatches (${report.mismatches.length}):`);
    for (const m of report.mismatches) {
      console.log(`  [${m.id}] "${m.input}" — ${m.why}`);
    }
  } else {
    console.log('no mismatches');
  }
}

console.log('IntentIQ — synthetic evaluation report');
console.log('(design/evaluation cases, not real user data)');
console.log('heuristic tier only — no GAIA_INTENT_BASE_URL configured in this run, so semantic-tier agreement/unresolved-reference metrics are N/A, not simulated.');

const base = runEvaluation(CASES);
printReport('IntentIQ v0.1/2.0 base set (accuracy regression)', base.report);

const v22 = runEvaluation(CASES_2_2);
printReport('IntentIQ 2.2 calibration set', v22.report);

console.log('\nconfusion (v0.1/2.0 base set, expected -> {observed: count}):');
for (const [expected, observed] of Object.entries(base.report.confusion)) {
  console.log(`  ${expected}: ${JSON.stringify(observed)}`);
}
