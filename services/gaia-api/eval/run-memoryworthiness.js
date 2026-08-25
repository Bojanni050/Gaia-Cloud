'use strict';

/**
 * Memoryworthiness 0.1 evaluation — deterministic, model-free (spec §18).
 *
 * Usage: node eval/run-memoryworthiness.js  (or: npm run eval:memory)
 *
 * Reports retain accuracy, discard accuracy, false-retain, false-discard,
 * low-priority rate and the semantic-call rate — which is structurally 0:
 * the module performs no LLM calls at all in 0.1.
 */

const { evaluateMemoryWorthiness } = require('../src/memoryWorthiness');
const { CASES } = require('./memoryworthiness-cases');

function run() {
  let correct = 0;
  let retainExpected = 0; let retainCorrect = 0;
  let discardExpected = 0; let discardCorrect = 0;
  let lowPriorityExpected = 0; let lowPriorityCorrect = 0;
  let falseRetain = []; let falseDiscard = [];
  const latencies = [];

  for (const c of CASES) {
    const start = process.hrtime.bigint();
    const d = evaluateMemoryWorthiness({
      userInput: c.input,
      intent: c.intent || null,
      existingMemorySignals: c.existing || null,
    });
    latencies.push(Number(process.hrtime.bigint() - start) / 1e6);

    const ok = d.action === c.expected;
    if (ok) correct += 1;
    if (c.expected === 'retain') { retainExpected += 1; if (ok) retainCorrect += 1; }
    else if (c.expected === 'discard') { discardExpected += 1; if (ok) discardCorrect += 1; }
    else { lowPriorityExpected += 1; if (ok) lowPriorityCorrect += 1; }

    // False-retain: worthless turn kept as important memory.
    if (c.expected === 'discard' && d.action !== 'discard') {
      falseRetain.push({ id: c.id, category: c.category, input: c.input, got: `${d.action}(${d.score})` });
    }
    // False-discard: meaningful personal information lost entirely.
    if ((c.expected === 'retain' || c.expected === 'retain_low_priority') && d.action === 'discard') {
      falseDiscard.push({ id: c.id, category: c.category, input: c.input, expected: c.expected });
    }
  }

  const pct = (n, d) => (d === 0 ? 'n/a' : (n / d).toFixed(3));
  console.log('Memoryworthiness 0.1 evaluation (deterministic — no model involved)\n');
  console.log(`cases:                 ${CASES.length}`);
  console.log(`accuracy:              ${pct(correct, CASES.length)}`);
  console.log(`retain accuracy:       ${pct(retainCorrect, retainExpected)} (${retainCorrect}/${retainExpected})`);
  console.log(`discard accuracy:      ${pct(discardCorrect, discardExpected)} (${discardCorrect}/${discardExpected})`);
  console.log(`low-priority accuracy: ${pct(lowPriorityCorrect, lowPriorityExpected)} (${lowPriorityCorrect}/${lowPriorityExpected})`);
  console.log(`false-retain:          ${falseRetain.length}`);
  console.log(`false-discard:         ${falseDiscard.length}`);
  console.log(`semantic-call rate:    0.000 (structurally zero — deterministic module)`);
  console.log(`avg latency per check: ${(latencies.reduce((s, l) => s + l, 0) / latencies.length).toFixed(4)}ms`);

  if (falseRetain.length) {
    console.log('\nfalse-retains:');
    for (const f of falseRetain) console.log(`  [${f.id}] ${f.category}: "${f.input}" -> ${f.got}`);
  }
  if (falseDiscard.length) {
    console.log('\nfalse-discards:');
    for (const f of falseDiscard) console.log(`  [${f.id}] ${f.category}: "${f.input}" (expected ${f.expected})`);
  }

  const pass = correct === CASES.length;
  console.log(`\n${pass ? 'ALL CASES PASS' : `accuracy ${(correct / CASES.length).toFixed(3)} — see misses above`}`);
  return pass ? 0 : 1;
}

process.exitCode = run();
