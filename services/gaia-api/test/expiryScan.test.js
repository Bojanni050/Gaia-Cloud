'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCognitionSink } = require('../src/reasoning/cognitionSink');
const { createExpiryScan, DEFAULT_INTERVAL_MS } = require('../src/reasoning/expiryScan');
const { isExpirable, DEFAULT_EXPIRY_DAYS } = require('../src/reasoning/hypothesisManager');

const silent = { warn: () => {}, info: () => {}, error: () => {} };
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

/** Cognition's own table, so a verb the store would refuse fails here too. */
const VALID = {
  proposed: ['testing', 'confirmed', 'rejected', 'expired'],
  testing: ['corroborated', 'confirmed', 'rejected', 'proposed'],
  corroborated: ['confirmed', 'rejected', 'testing'],
  confirmed: [],
  rejected: [],
  expired: ['testing', 'confirmed', 'rejected', 'proposed'],
};

function fakeStore(rows) {
  const state = new Map(rows.map((row) => [row.id, { ...row }]));
  const calls = [];
  const queries = [];
  const synced = [];
  const behaviour = { failOn: null };
  return {
    state,
    calls,
    queries,
    synced,
    behaviour,
    listHypotheses: async (query = {}) => {
      queries.push(query);
      return [...state.values()].filter((row) => (!query.status || row.status === query.status)
        && (!query.kind || row.kind === query.kind));
    },
    getHypothesis: async (id) => {
      const row = state.get(id);
      if (!row) throw new Error('not found');
      return { ...row };
    },
    expireHypothesis: async (id) => {
      if (behaviour.failOn === id) throw new Error('boom');
      const row = state.get(id);
      if (!VALID[row.status].includes('expired')) {
        throw new Error(`invalid status transition: ${row.status} -> expired`);
      }
      row.status = 'expired';
      row.expired_at = new Date().toISOString();
      row.verwerp_bron = 'verlopen';
      calls.push(['expire', id]);
      return { ...row };
    },
  };
}

/** A hypothesis row the way Cognition sends it: snake_case, string timestamps. */
const row = (overrides = {}) => ({
  id: 'h-old',
  kind: 'hypothesis',
  statement: 'Bo prefers the shorter route.',
  status: 'proposed',
  confidence: '0.4000',
  evidence_for: [],
  evidence_against: [],
  counter_hypothesis: 'the longer route was simply not known yet',
  updated_at: daysAgo(20),
  ...overrides,
});

// --- the gate itself ----------------------------------------------------------

test('expiry gate: only an untouched, evidence-less proposal is expirable', () => {
  assert.equal(DEFAULT_EXPIRY_DAYS, 14);
  assert.equal(isExpirable(row()), true);
  assert.equal(isExpirable(row({ updated_at: daysAgo(1) })), false);
  assert.equal(isExpirable(row({ evidence_for: ['m1'] })), false);
  assert.equal(isExpirable(row({ kind: 'open_question' })), false);
  assert.equal(isExpirable(row({ kind: 'relationship' })), false);
  assert.equal(isExpirable(row({ status: 'testing' })), false);
  assert.equal(isExpirable(row({ expired_at: daysAgo(1) })), false);
  assert.equal(isExpirable(null), false);
});

test('expiry gate: it reads camelCase rows too and the term is policy', () => {
  const camel = {
    id: 'hyp-1', status: 'proposed', evidenceFor: [], evidenceAgainst: [], updatedAt: daysAgo(10),
  };
  assert.equal(isExpirable(camel), false); // 10 days < the 14-day default
  assert.equal(isExpirable(camel, { days: 7 }), true);
  assert.equal(isExpirable(camel, { days: 30 }), false);
});

// --- the pass -----------------------------------------------------------------

test('expiry: an evidence-less proposal past the term lapses through the store', async () => {
  const cognition = fakeStore([
    row(),
    row({ id: 'h-fresh', updated_at: daysAgo(1) }),
    row({ id: 'h-backed', evidence_for: ['m1'] }),
    row({ id: 'q-open', kind: 'open_question' }),
  ]);
  const sink = createCognitionSink({ cognition, sync: { syncHypothesis: async (r) => cognition.synced.push(r) } });
  const scan = createExpiryScan({ cognition, sink: sink.hypothesis, env: {}, logger: silent });

  const result = await scan.runOnce();

  assert.equal(result.examined, 3); // the open question is not even asked for
  assert.equal(result.expired, 1);
  assert.deepEqual(result.ids, ['h-old']);
  assert.equal(cognition.state.get('h-old').status, 'expired');
  assert.equal(cognition.state.get('h-old').verwerp_bron, 'verlopen');
  assert.equal(cognition.state.get('h-fresh').status, 'proposed');
  assert.equal(cognition.state.get('h-backed').status, 'proposed');
  assert.equal(cognition.state.get('q-open').status, 'proposed');
  assert.deepEqual(cognition.calls, [['expire', 'h-old']]);
  assert.equal(cognition.synced.length, 1, 'the lapse is mirrored to Hindsight');
});

test('expiry: the pass asks Cognition for proposals only', async () => {
  const cognition = fakeStore([row()]);
  const scan = createExpiryScan({
    cognition,
    sink: createCognitionSink({ cognition }).hypothesis,
    env: {},
    logger: silent,
  });

  await scan.runOnce();

  assert.deepEqual(cognition.queries, [{ status: 'proposed', kind: 'hypothesis' }]);
});

test('expiry: one failing record is counted and skipped, the rest still lapse', async () => {
  const cognition = fakeStore([row({ id: 'h-good' }), row({ id: 'h-bad' })]);
  cognition.behaviour.failOn = 'h-bad';
  const scan = createExpiryScan({
    cognition,
    sink: createCognitionSink({ cognition }).hypothesis,
    env: {},
    logger: silent,
  });

  const result = await scan.runOnce();

  assert.equal(result.expired, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.ids, ['h-good']);
  assert.equal(cognition.state.get('h-bad').status, 'proposed');
});

test('expiry: a store that is down is reported, never thrown', async () => {
  const cognition = fakeStore([]);
  cognition.listHypotheses = async () => { throw new Error('cognition down'); };
  const scan = createExpiryScan({
    cognition,
    sink: createCognitionSink({ cognition }).hypothesis,
    env: {},
    logger: silent,
  });

  assert.deepEqual(await scan.runOnce(), { error: 'cognition down' });
});

test('expiry: the term comes from the environment, and the pass can be turned off', async () => {
  const cognition = fakeStore([row({ updated_at: daysAgo(10) })]);
  const sink = createCognitionSink({ cognition }).hypothesis;

  const off = createExpiryScan({ cognition, sink, env: { GAIA_HYPOTHESIS_EXPIRY: 'false' }, logger: silent });
  assert.equal(off, null);

  const week = createExpiryScan({ cognition, sink, env: { GAIA_HYPOTHESIS_EXPIRY_DAYS: '7' }, logger: silent });
  const result = await week.runOnce();
  assert.equal(result.expired, 1);
  assert.equal(cognition.state.get('h-old').status, 'expired');
});

test('expiry: it never starts without Cognition or a sink', () => {
  assert.equal(createExpiryScan({ env: {}, logger: silent }), null);
  assert.equal(createExpiryScan({ cognition: fakeStore([]), env: {}, logger: silent }), null);
  assert.equal(DEFAULT_INTERVAL_MS, 15 * 60 * 1000);
});

test('expiry: start runs once immediately, is idempotent, and stop clears the timer', async () => {
  const cognition = fakeStore([]);
  const scan = createExpiryScan({
    cognition,
    sink: createCognitionSink({ cognition }).hypothesis,
    env: {},
    intervalMs: 60 * 60 * 1000,
    logger: silent,
  });

  scan.start();
  scan.start();
  await new Promise((resolve) => setImmediate(resolve));
  scan.stop();

  assert.equal(cognition.queries.length, 1);
});
