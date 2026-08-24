#!/usr/bin/env node
'use strict';

/**
 * HypothesisManager lifecycle evaluation (ReasonIQ 0.3 brief §21).
 *
 * Usage: node eval/run-hypothesis.js  (or: npm run eval:hypothesis)
 *
 * Deliberately deterministic and model-free: each case drives the manager
 * seam directly (applyUpdate / evaluateTransition / propose) and asserts one
 * lifecycle behavior. This checks the STATE MACHINE, not reasoning quality —
 * reasoning quality is the reason-harness's job.
 */

const path = require('path');
const { createHypothesisManager } = require('../src/reasoning/hypothesisManager');

const CASES = require(path.join(__dirname, 'hypothesis-cases.json')).cases;

function runCase(kase) {
  const m = createHypothesisManager({
    ...(kase.setup.policy ? { policy: kase.setup.policy } : {}),
    hypotheses: kase.setup.hypotheses || [],
  });
  const a = kase.action;
  let outcome;
  if (a.type === 'applyUpdate') {
    outcome = m.applyUpdate({ ...a.update, hypothesisId: a.update.hypothesisId });
  } else if (a.type === 'evaluateTransition') {
    outcome = m.evaluateTransition(kase.setup.hypotheses[0].id, a.target, { rationale: a.rationale });
  } else if (a.type === 'propose') {
    outcome = m.propose(a.input);
  } else {
    return { id: kase.id, pass: false, why: `unknown action type ${a.type}` };
  }

  const exp = kase.expect || {};
  const hypId = kase.setup.hypotheses && kase.setup.hypotheses[0] ? kase.setup.hypotheses[0].id : null;
  const h = hypId ? m.get(hypId) : null;

  const checks = [];
  if ('accepted' in exp) checks.push([exp.accepted === Boolean(outcome.accepted !== false), `accepted=${outcome.accepted}`]);
  if ('ok' in exp) checks.push([exp.ok === Boolean(outcome.ok), `ok=${outcome.ok} (${outcome.reason || ''})`]);
  if ('duplicateOf' in exp) checks.push([outcome.duplicateOf === exp.duplicateOf, `duplicateOf=${outcome.duplicateOf}`]);
  if ('confidenceAfter' in exp) checks.push([h && h.confidence === exp.confidenceAfter, `confidence=${h ? h.confidence : null}`]);
  if ('statusAfter' in exp) checks.push([h && h.status === exp.statusAfter, `status=${h ? h.status : null}`]);
  if ('from' in exp && outcome.from !== undefined) checks.push([outcome.from === exp.from, `from=${outcome.from}`]);
  if ('to' in exp && outcome.to !== undefined) checks.push([outcome.to === exp.to, `to=${outcome.to}`]);
  if ('evidenceForContains' in exp) checks.push([h && h.evidenceFor.includes(exp.evidenceForContains), `evidenceFor=${JSON.stringify(h && h.evidenceFor)}`]);
  if ('evidenceAgainstContains' in exp) checks.push([h && h.evidenceAgainst.includes(exp.evidenceAgainstContains), `evidenceAgainst=${JSON.stringify(h && h.evidenceAgainst)}`]);
  if ('reasonMatches' in exp) checks.push([new RegExp(exp.reasonMatches).test(outcome.reason || ''), `reason=${outcome.reason}`]);

  const failed = checks.filter(([pass]) => !pass);
  return { id: kase.id, behavior: kase.behavior, pass: failed.length === 0, why: failed.map(([, msg]) => msg).join('; ') };
}

const results = CASES.map(runCase);
const passed = results.filter((r) => r.pass).length;

console.log('HypothesisManager lifecycle evaluation');
console.log('(deterministic state-machine checks — no model involved)');
console.log(`cases:                     ${CASES.length}`);
console.log(`pass rate:                 ${(Math.round((passed / CASES.length) * 1000) / 1000).toFixed(3)}`);
if (passed < CASES.length) {
  console.log(`failures (${CASES.length - passed}):`);
  for (const r of results.filter((r) => !r.pass)) console.log(`  [${r.id}] (${r.behavior}) — ${r.why}`);
}

process.exitCode = passed === CASES.length ? 0 : 1;
