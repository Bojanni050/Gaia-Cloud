'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBeliefFormationScan } = require('../src/reasoning/beliefFormationScan');

const NOW = Date.parse('2026-10-22T12:00:00Z');

function observation(overrides = {}) {
  return {
    id: 'o1',
    statement: 'They prefer short answers.',
    conversation_id: 'conv-a',
    observed_at: '2026-10-20T10:00:00Z',
    evidence_items: [
      { id: 'hindsight-1', source: 'hindsight', sourceRef: 'fact-88', observedAt: '2026-10-20T10:00:00Z', content: 'They asked for short answers.' },
    ],
    ...overrides,
  };
}

function harness({ observations = [], hypotheses = [] } = {}) {
  const calls = { saved: [], consumed: [] };
  const cognition = {
    listObservations: async () => observations,
    listHypotheses: async () => hypotheses,
    markObservationsConsumed: async (payload) => { calls.consumed.push(payload); return { consumed: payload.ids.length }; },
  };
  const sink = {
    save: async (hypothesis, context) => {
      calls.saved.push({ hypothesis, context });
      return { id: `cog-${calls.saved.length}` };
    },
  };
  const scan = createBeliefFormationScan({
    cognition,
    sink,
    env: {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { scan, calls };
}

test('the same ground in two conversations forms one statement', async () => {
  const { scan, calls } = harness({
    observations: [
      observation({ id: 'o1', conversation_id: 'conv-a' }),
      observation({
        id: 'o2',
        conversation_id: 'conv-b',
        statement: 'They want the answer, not the reasoning.',
        observed_at: '2026-10-21T09:00:00Z',
        evidence_items: [
          { id: 'hindsight-4', source: 'hindsight', sourceRef: 'fact-88', observedAt: '2026-10-21T09:00:00Z', content: 'Asked to skip the explanation.' },
        ],
      }),
    ],
  });

  const result = await scan.runOnce();

  assert.equal(result.formed, 1);
  assert.equal(calls.saved.length, 1);
  // The wording is the machine's own newest words — no model call.
  assert.equal(calls.saved[0].hypothesis.statement, 'They want the answer, not the reasoning.');
  // Grounded in two moments, so it starts at the review threshold.
  assert.equal(calls.saved[0].hypothesis.confidence, 0.75);
  assert.equal(calls.saved[0].hypothesis.scope, 'macro');
  assert.equal(calls.saved[0].hypothesis.persistence, 'durable');
  // One capture per ground: the same fact seen later replaces the earlier
  // wording rather than appearing twice on the card.
  assert.deepEqual(calls.saved[0].context.evidenceItems.map((i) => i.id), ['hindsight-4']);
  // The observations fed exactly this statement.
  assert.deepEqual(calls.consumed[0], { ids: ['o1', 'o2'], hypothesisId: 'cog-1' });
});

test('twice in one conversation proves nothing', async () => {
  const { scan, calls } = harness({
    observations: [
      observation({ id: 'o1' }),
      observation({ id: 'o2', observed_at: '2026-10-21T09:00:00Z' }),
    ],
  });

  const result = await scan.runOnce();

  assert.equal(result.formed, 0);
  assert.equal(result.singleConversation, 1);
  assert.equal(calls.saved.length, 0);
});

test('an observation without a sourceRef has no ground to share', async () => {
  const { scan, calls } = harness({
    observations: [
      observation({ id: 'o1', evidence_items: [{ id: 'hindsight-1', source: 'hindsight', content: 'no ref' }] }),
      observation({ id: 'o2', conversation_id: 'conv-b', evidence_items: [] }),
    ],
  });

  const result = await scan.runOnce();

  assert.equal(result.formed, 0);
  assert.equal(calls.saved.length, 0);
});

test('a statement the store already holds is not formed twice', async () => {
  const { scan, calls } = harness({
    observations: [
      observation({ id: 'o1' }),
      observation({ id: 'o2', conversation_id: 'conv-b', statement: 'they prefer short answers' }),
    ],
    hypotheses: [{ id: 'h1', statement: 'They prefer short answers' }],
  });

  const result = await scan.runOnce();

  assert.equal(result.formed, 0);
  assert.equal(result.duplicate, 1);
  assert.equal(calls.saved.length, 0);
});

test('material older than the term is left alone', async () => {
  const { scan } = harness({
    observations: [
      observation({ id: 'o1', observed_at: '2026-09-01T10:00:00Z' }),
      observation({ id: 'o2', conversation_id: 'conv-b', observed_at: '2026-09-02T10:00:00Z' }),
    ],
  });

  const result = await scan.runOnce();

  assert.equal(result.examined, 0);
  assert.equal(result.formed, 0);
});

test('a formed belief is handed to the caller so the live view stays current', async () => {
  const formed = [];
  const cognition = {
    listObservations: async () => [
      observation({ id: 'o1' }),
      observation({ id: 'o2', conversation_id: 'conv-b' }),
    ],
    listHypotheses: async () => [],
    markObservationsConsumed: async () => ({ consumed: 2 }),
  };
  const scan = createBeliefFormationScan({
    cognition,
    sink: { save: async () => ({ id: 'cog-1', statement: 'They prefer short answers.' }) },
    env: {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
    onFormed: (record) => formed.push(record),
  });

  await scan.runOnce();

  assert.equal(formed.length, 1);
  assert.equal(formed[0].id, 'cog-1');
});

test('the pass is off when the environment says so', () => {
  const scan = createBeliefFormationScan({ cognition: {}, sink: {}, env: { GAIA_BELIEF_FORMATION: 'false' } });
  assert.equal(scan, null);
});
