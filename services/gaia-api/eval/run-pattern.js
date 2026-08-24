'use strict';

/**
 * PatternManager evaluation (ReasonIQ 0.4 brief §20) — deterministic,
 * model-free checks that pattern formation stays CONSERVATIVE:
 * false-positive patterns are worse than missed ones.
 *
 * Usage: node eval/run-pattern.js  (or: npm run eval:pattern)
 */

const { createPatternManager } = require('../src/reasoning/patternManager');

function H(id, statement, confidence, refs = [], status = 'testing', persistence = 'durable') {
  return { id, statement, confidence, evidenceFor: refs, status, persistence };
}

// Each case drives a fresh manager and asserts one conservative behavior.
const CASES = [
  {
    id: 'pat-01', behavior: 'two-supporting-durable -> candidate',
    run: () => {
      const m = createPatternManager();
      const hyps = {
        h1: H('h1', "Bo werkt 's avonds aan creatieve projecten.", 0.7, ['m1']),
        h2: H('h2', "Bo start 's avonds creatieve projecten.", 0.68, ['m2']),
      };
      const out = m.maybeFormPatterns({ hypotheses: Object.values(hyps), changedHypothesisIds: ['h1', 'h2'] });
      const ok = out.formed.length === 1 && out.formed[0].status === 'candidate';
      const detail = `formed=${out.formed.length} status=${out.formed[0] ? out.formed[0].status : 'none'} conf=${out.formed[0] ? out.formed[0].confidence : '-'}`;
      return { pass: ok, detail };
    },
  },
  {
    id: 'pat-02', behavior: 'shared-evidence trio -> no overconfident pattern',
    run: () => {
      const m = createPatternManager();
      const hyps = [
        H('h1', "Bo is 's avonds creatiever.", 0.85, ['same-ref']),
        H('h2', 'Bo werkt creatiever in de avond.', 0.85, ['same-ref']),
        H('h3', 'Avondelijke creativiteit.', 0.85, ['same-ref']),
      ];
      const out = m.maybeFormPatterns({ hypotheses: hyps, changedHypothesisIds: ['h1'] });
      const p = out.formed[0];
      return { pass: Boolean(p) && p.status === 'candidate' && p.confidence < 0.6, detail: p ? `${p.status}/${p.confidence}` : 'none' };
    },
  },
  {
    id: 'pat-03', behavior: 'support+contradiction -> uncertain candidate',
    run: () => {
      const m = createPatternManager();
      const res = m.register({
        hypothesisIds: ['a', 'b', 'k'],
        rationale: 'mixed',
        hypothesesById: {
          a: H('a', 'A-patroon.', 0.7, ['r1']),
          b: H('b', 'B-patroon.', 0.7, ['r2']),
          k: H('k', 'Tegenstrijdige lezing.', 0.4, [], 'rejected'),
        },
      });
      return { pass: res.pattern.status === 'candidate' && res.pattern.contradictingHypotheses.includes('k'), detail: `${res.pattern.status}/${res.pattern.confidence}` };
    },
  },
  {
    id: 'pat-04', behavior: 'unrelated durable hypotheses -> no pattern',
    run: () => {
      const m = createPatternManager();
      const out = m.maybeFormPatterns({
        hypotheses: [H('u1', 'De keukenrenovatie loopt achter.', 0.7, ['x1']), H('u2', 'Bo prefereert korte mails.', 0.7, ['x2'])],
        changedHypothesisIds: ['u1', 'u2'],
      });
      return { pass: out.formed.length === 0, detail: `formed=${out.formed.length}` };
    },
  },
  {
    id: 'pat-05', behavior: 'duplicate registration -> single pattern',
    run: () => {
      const m = createPatternManager();
      const map = { a: H('a', 'A.', 0.7, ['r1']), b: H('b', 'B.', 0.7, ['r2']) };
      m.register({ hypothesisIds: ['a', 'b'], hypothesesById: map });
      const second = m.register({ hypothesisIds: ['b', 'a'], rationale: 'again', hypothesesById: map });
      return { pass: second.duplicateOf === 'pattern-1' && m.list().length === 1, detail: `count=${m.list().length} dup=${second.duplicateOf}` };
    },
  },
  {
    id: 'per-06', behavior: 'ephemeral excluded / only durable considered',
    run: () => {
      const m = createPatternManager();
      const ephemeral = [
        H('e1', "Bo werkt 's avonds aan creatieve projecten.", 0.9, ['m1'], 'testing', 'ephemeral'),
        H('e2', "Bo start 's avonds creatieve projecten.", 0.9, ['m2'], 'testing', 'ephemeral'),
      ];
      const outE = m.maybeFormPatterns({ hypotheses: ephemeral, changedHypothesisIds: ['e1'] });
      const durable = [
        H('d1', "Bo werkt 's avonds aan creatieve projecten.", 0.7, ['m1']),
        H('d2', "Bo start 's avonds creatieve projecten.", 0.68, ['m2']),
      ];
      const outD = m.maybeFormPatterns({ hypotheses: [...ephemeral, ...durable], changedHypothesisIds: ['d1'] });
      return { pass: outE.formed.length === 0 && outD.formed.length === 1, detail: `ephemeral=${outE.formed.length} mixed=${outD.formed.length}` };
    },
  },
];

let passed = 0;
console.log('Pattern formation evaluation (ReasonIQ 0.4) — deterministic, conservative by design');
for (const c of CASES) {
  let result;
  try { result = c.run(); } catch (err) { result = { pass: false, detail: err.message }; }
  const pass = Boolean(result.pass);
  if (pass) passed += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.behavior}${pass ? '' : ` — ${result.detail}`}`);
}
console.log(`\ncases: ${CASES.length}  pass rate: ${(passed / CASES.length).toFixed(3)}`);
process.exitCode = passed === CASES.length ? 0 : 1;
