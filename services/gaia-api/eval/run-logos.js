#!/usr/bin/env node
'use strict';

/**
 * CLI entry for the Logos evaluation harness.
 * Usage: node eval/run-reason.js  (or: npm run eval:reason)
 */

const { CASES } = require('./logos-cases');
const { runEvaluation } = require('./logos-harness');
const { createLogosModelStub } = require('../src/logos/logosModelStub');

const model = createLogosModelStub();

runEvaluation(CASES, model).then(({ report, results }) => {
  console.log('Logos v0.1 — synthetic evaluation report');
  console.log('(design/evaluation cases, scored against the deterministic logosModelStub — NOT a real reasoning model)\n');
  console.log(`reasoner:                  ${report.reasonerVersion}`);
  console.log(`cases:                     ${report.total}`);
  console.log(`pass rate:                 ${report.passRate}`);
  console.log(`structured output valid:   ${report.structuredOutputValidRate}`);
  console.log(`degraded (fallback) rate:  ${report.degradedRate}`);
  console.log(`shallow rate:              ${report.shallowRate}`);
  console.log(`deep rate:                 ${report.deepRate}`);
  console.log(`hypothesis formation rate: ${report.hypothesisFormationRate}`);
  console.log(`sufficiency rate:          ${report.sufficiencyRate}`);
  console.log(`confidence:                min=${report.confidenceStats.min} max=${report.confidenceStats.max} avg=${report.confidenceStats.avg}`);

  if (report.failures.length) {
    console.log(`\nfailures (${report.failures.length}):`);
    for (const f of report.failures) {
      console.log(`  [${f.id}] "${f.input}"`);
      for (const c of f.failedChecks) {
        console.log(`      ${c.name}: got ${JSON.stringify(c.got)}`);
      }
    }
  } else {
    console.log('\nno failures');
  }
});
