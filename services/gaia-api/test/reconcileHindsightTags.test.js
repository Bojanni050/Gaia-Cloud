'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runReconcile, parseArgs } = require('../scripts/reconcile-hindsight-tags');

function deps() {
  const reconcileCalls = [];
  return {
    reconcileCalls,
    hindsight: {
      listMemories: async () => [
        { id: 'u1', tags: ['gaia:hypothesis'] },
        { id: 'u2', tags: ['gaia:pattern'] },
      ],
      recall: async () => [{ id: 'legacy1' }, { id: 'legacy2' }],
    },
    cognition: {
      listHypotheses: async () => [{ id: 'h1' }, { id: 'h2' }],
      listPatterns: async () => [{ id: 'p1' }],
    },
    sync: {
      reconcile: async (opts) => {
        reconcileCalls.push(opts);
        return { hypothesesPushed: 2, patternsPushed: 1 };
      },
    },
  };
}

test('parseArgs: dry-run by default, --apply and --clear opt in', () => {
  assert.deepEqual(parseArgs([]), { apply: false, clear: false });
  assert.deepEqual(parseArgs(['--apply']), { apply: true, clear: false });
  assert.deepEqual(parseArgs(['--apply', '--clear']), { apply: true, clear: true });
});

test('dry run surveys counts but writes nothing', async () => {
  const d = deps();
  const logs = [];
  const out = await runReconcile({ argv: [], deps: d, log: (l) => logs.push(l) });

  assert.equal(out.result, null);
  assert.equal(d.reconcileCalls.length, 0);
  assert.equal(out.before.hindsight.activeGaiaHypotheses, 1);
  assert.equal(out.before.hindsight.activeGaiaPatterns, 1);
  assert.equal(out.before.hindsight.legacyFoundationFacts, 2);
  assert.equal(out.before.cognition.hypotheses, 2);
  assert.ok(logs.some((l) => /dry run/.test(l)));
});

test('--apply runs reconcile and --clear is forwarded', async () => {
  const d = deps();
  const out = await runReconcile({ argv: ['--apply', '--clear'], deps: d, log: () => {} });

  assert.equal(d.reconcileCalls.length, 1);
  assert.deepEqual(d.reconcileCalls[0], { clear: true });
  assert.deepEqual(out.result, { hypothesesPushed: 2, patternsPushed: 1 });
});
