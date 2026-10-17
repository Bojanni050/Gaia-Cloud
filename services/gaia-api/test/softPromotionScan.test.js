'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCognitionSink } = require('../src/reasoning/cognitionSink');
const { isSoftPromotable } = require('../src/reasoning/hypothesisManager');
const {
  createSoftPromotionScan,
  fromStoreRecord,
  DEFAULT_INTERVAL_MS,
} = require('../src/reasoning/softPromotionScan');

const silent = { warn: () => {}, info: () => {}, error: () => {} };

// Cognition's real table (services/cognition/src/hypotheses.js) — the fake
// store refuses what the real one refuses, so a wrong verb cannot pass.
const VALID = {
  proposed: ['testing', 'confirmed', 'rejected'],
  testing: ['corroborated', 'confirmed', 'rejected', 'proposed'],
  corroborated: ['confirmed', 'rejected', 'testing'],
  confirmed: [],
  rejected: [],
};

/**
 * A stateful stand-in for the Cognition client + store: rows in, snake_case
 * out, numeric confidence as a STRING (Postgres `numeric` comes back that way).
 */
function fakeStore(rows) {
  const state = new Map(rows.map((r) => [r.id, { ...r }]));
  const store = {
    state,
    calls: [],
    listCalls: 0,
    listHypotheses: async ({ status } = {}) => {
      store.listCalls += 1;
      return [...state.values()].filter((r) => !status || r.status === status);
    },
    getHypothesis: async (id) => {
      const row = state.get(id);
      if (!row) throw Object.assign(new Error('not found'), { status: 404 });
      return { ...row };
    },
    markTesting: async (id) => {
      const row = state.get(id);
      if (!VALID[row.status].includes('testing')) throw new Error(`invalid status transition: ${row.status} -> testing`);
      row.status = 'testing';
      store.calls.push(['test', id]);
      return { ...row };
    },
    markCorroborated: async (id) => {
      const row = state.get(id);
      if (!VALID[row.status].includes('corroborated')) throw new Error(`invalid status transition: ${row.status} -> corroborated`);
      row.status = 'corroborated';
      store.calls.push(['corroborate', id]);
      return { ...row };
    },
  };
  return store;
}

function micro(overrides = {}) {
  return {
    id: 'h-micro',
    statement: 'Prefers terse replies.',
    status: 'testing',
    confidence: '0.8500',
    scope: 'micro',
    evidence_for: ['m1'],
    evidence_against: [],
    ...overrides,
  };
}

// --- the gate, and the row shape it is fed ---------------------------------

test('isSoftPromotable: the one gate, in camelCase and snake_case, with a string confidence', () => {
  assert.equal(isSoftPromotable({ scope: 'micro', status: 'testing', confidence: 0.85, evidenceAgainst: [] }), true);
  assert.equal(isSoftPromotable({ scope: 'micro', status: 'testing', confidence: '0.8500', evidence_against: [] }), true);
  assert.equal(isSoftPromotable({ scope: 'macro', status: 'testing', confidence: 0.85, evidenceAgainst: [] }), false);
  assert.equal(isSoftPromotable({ scope: 'micro', status: 'proposed', confidence: 0.85, evidenceAgainst: [] }), false);
  assert.equal(isSoftPromotable({ scope: 'micro', status: 'testing', confidence: '0.7000', evidenceAgainst: [] }), false);
  assert.equal(isSoftPromotable({ scope: 'micro', status: 'testing', confidence: 0.85, evidence_against: ['m2'] }), false);
  assert.equal(isSoftPromotable(null), false);
});

test('fromStoreRecord: a store row becomes the shape the gate and the sink understand', () => {
  const h = fromStoreRecord({ id: 'h-1', statement: 'x', status: 'testing', confidence: '0.8500', scope: 'micro', evidence_for: ['m1'], evidence_against: ['m2'] });
  assert.deepEqual(h, {
    id: 'h-1', statement: 'x', kind: undefined, status: 'testing', confidence: 0.85, scope: 'micro',
    evidenceFor: ['m1'], evidenceAgainst: ['m2'], updatedAt: null, expiredAt: null,
  });
  // Missing/odd columns degrade to empty lists, never to a crash.
  const bare = fromStoreRecord({ id: 'h-2', status: 'testing', confidence: null, scope: 'micro' });
  assert.equal(bare.confidence, null);
  assert.deepEqual(bare.evidenceFor, []);
  assert.deepEqual(bare.evidenceAgainst, []);
  // The expiry gate's own inputs ride along: the kind, and the timestamps the
  // lapse rule reads, in whichever spelling the row carries.
  const lapsed = fromStoreRecord({
    id: 'h-3', status: 'proposed', kind: 'hypothesis',
    updated_at: '2026-10-01T00:00:00.000Z', expired_at: null,
  });
  assert.equal(lapsed.kind, 'hypothesis');
  assert.equal(lapsed.updatedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(lapsed.expiredAt, null);
});

// --- the scan --------------------------------------------------------------

test('scan promotes the stranded micro statements and leaves the rest alone', async () => {
  const cognition = fakeStore([
    micro(),
    micro({ id: 'h-macro', statement: 'Ship the rewrite.', confidence: '0.9000', scope: 'macro' }),
    micro({ id: 'h-low', statement: 'Maybe later.', confidence: '0.7000' }),
    micro({ id: 'h-against', statement: 'Argued against.', confidence: '0.9000', evidence_against: ['m2'] }),
  ]);
  const synced = [];
  const sink = createCognitionSink({ cognition, sync: { syncHypothesis: async (r) => synced.push(r) } }).hypothesis;

  const scan = createSoftPromotionScan({ cognition, sink, env: {}, logger: silent });
  const result = await scan.runOnce();

  assert.equal(result.examined, 4);
  assert.equal(result.skipped, 3);
  assert.equal(result.promoted, 1);
  assert.deepEqual(result.ids, ['h-micro']);
  assert.equal(cognition.state.get('h-micro').status, 'corroborated');
  assert.equal(cognition.state.get('h-macro').status, 'testing', 'macro always waits for the person');
  assert.equal(cognition.state.get('h-low').status, 'testing');
  assert.equal(cognition.state.get('h-against').status, 'testing');
  assert.equal(synced.length, 1, 'the promoted record still mirrors to Hindsight');
  // No patch and no evidence churn: the only store writes are the lifecycle verb.
  assert.deepEqual(cognition.calls, [['corroborate', 'h-micro']]);
});

test('scan only promotes records the store already holds as testing', async () => {
  const cognition = fakeStore([micro({ id: 'h-fresh', status: 'proposed' })]);
  const queries = [];
  cognition.listHypotheses = async (q) => { queries.push(q); return [...cognition.state.values()]; };
  const sink = createCognitionSink({ cognition, sync: null }).hypothesis;

  const result = await createSoftPromotionScan({ cognition, sink, env: {}, logger: silent }).runOnce();

  assert.deepEqual(queries, [{ status: 'testing' }], 'the scan asks the store for testing records only');
  assert.equal(result.promoted, 0);
  assert.equal(cognition.state.get('h-fresh').status, 'proposed', 'a record that never left proposed is not promoted');
  assert.deepEqual(cognition.calls, [], 'and nothing is written');
});

test('scan: one failing record is logged and skipped, the others still promote', async () => {
  const cognition = fakeStore([micro({ id: 'h-bad' }), micro({ id: 'h-good' })]);
  const original = cognition.markCorroborated;
  cognition.markCorroborated = async (id) => {
    if (id === 'h-bad') throw new Error('boom');
    return original(id);
  };
  const warnings = [];
  const sink = createCognitionSink({ cognition, sync: null }).hypothesis;

  const result = await createSoftPromotionScan({ cognition, sink, env: {}, logger: { ...silent, warn: (m) => warnings.push(m) } }).runOnce();

  assert.equal(result.failed, 1);
  assert.equal(result.promoted, 1);
  assert.deepEqual(result.ids, ['h-good']);
  assert.match(warnings.join('\n'), /soft-promotion failed for h-bad: boom/);
});

test('scan: an unreachable store yields an error result, never a throw', async () => {
  const cognition = fakeStore([]);
  cognition.listHypotheses = async () => { throw new Error('cognition down'); };
  const errors = [];
  const sink = createCognitionSink({ cognition, sync: null }).hypothesis;

  const result = await createSoftPromotionScan({ cognition, sink, env: {}, logger: { ...silent, error: (m) => errors.push(m) } }).runOnce();

  assert.equal(result.error, 'cognition down');
  assert.match(errors.join('\n'), /scan failed: cognition down/);
});

// --- gating and lifecycle --------------------------------------------------

test('scan does not start when it is switched off or a dependency is missing', () => {
  const cognition = fakeStore([]);
  const sink = { update: async () => {} };

  assert.equal(createSoftPromotionScan({ cognition, sink, env: { GAIA_HYPOTHESIS_SCAN: 'false' }, logger: silent }), null);
  assert.equal(createSoftPromotionScan({ sink, env: {}, logger: silent }), null);
  assert.equal(createSoftPromotionScan({ cognition, env: {}, logger: silent }), null);

  const scan = createSoftPromotionScan({ cognition, sink, env: {}, logger: silent });
  assert.equal(scan.enabled, true);
  assert.equal(DEFAULT_INTERVAL_MS, 15 * 60 * 1000);
  assert.equal(Number(process.env.GAIA_HYPOTHESIS_SCAN_INTERVAL_MS) || DEFAULT_INTERVAL_MS, DEFAULT_INTERVAL_MS);
});

test('scan starts once, runs immediately, and stops cleanly', async () => {
  const cognition = fakeStore([micro()]);
  const sink = createCognitionSink({ cognition, sync: null }).hypothesis;
  const scan = createSoftPromotionScan({ cognition, sink, env: {}, intervalMs: 60000, logger: silent });

  scan.start();
  scan.start(); // idempotent: a second start must not add a second timer
  await new Promise((resolve) => setImmediate(resolve));
  scan.stop();

  assert.equal(cognition.listCalls, 1, 'exactly one immediate pass');
  assert.equal(cognition.state.get('h-micro').status, 'corroborated');
});
