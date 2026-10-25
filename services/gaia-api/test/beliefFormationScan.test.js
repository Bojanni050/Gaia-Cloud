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

// --- Recall ground: the second axis for observations without a sourceRef ---

function harnessWithRecall({ observations = [], hypotheses = [], recall } = {}) {
  const calls = { saved: [], consumed: [], ground: [] };
  const cognition = {
    listObservations: async () => observations,
    listHypotheses: async () => hypotheses,
    markObservationsConsumed: async (payload) => { calls.consumed.push(payload); return { consumed: payload.ids.length }; },
    mergeObservationGround: async (id, unitIds) => { calls.ground.push({ id, unitIds }); return { merged: unitIds.length }; },
  };
  const sink = {
    save: async (hypothesis, context) => {
      calls.saved.push({ hypothesis, context });
      return { id: `cog-${calls.saved.length}` };
    },
  };
  const hindsight = {
    recall: recall || (async () => []),
  };
  const scan = createBeliefFormationScan({
    cognition,
    sink,
    hindsight,
    env: {},
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { scan, calls, hindsight };
}

const noRef = (overrides = {}) => observation({
  evidence_items: [{ id: 'model-1', source: 'hindsight', content: 'a standing summary, no store id' }],
  ...overrides,
});

test('recall ground connects two observations that never shared a sourceRef', async () => {
  // Both observations cite only a mental model (no sourceRef). Recall of each
  // statement returns an overlapping memory unit — the store says they are
  // about the same thing.
  const { scan, calls } = harnessWithRecall({
    observations: [
      noRef({ id: 'o1', conversation_id: 'conv-a' }),
      noRef({
        id: 'o2',
        conversation_id: 'conv-b',
        statement: 'They want the answer, not the reasoning.',
        observed_at: '2026-10-21T09:00:00Z',
      }),
    ],
    recall: async (query) => (query.includes('short answers')
      ? [{ id: 'unit-9', text: 'They asked for short answers.' }]
      : [{ id: 'unit-9', text: 'Asked to skip the explanation.' }]),
  });

  const result = await scan.runOnce();

  assert.equal(result.formed, 1);
  // The ground was stored on both observations before grouping read it.
  assert.deepEqual(calls.ground.map((g) => g.id).sort(), ['o1', 'o2']);
  assert.ok(calls.ground.every((g) => g.unitIds.includes('unit-9')));
  assert.equal(result.recallGround.stored, 2);
  assert.deepEqual(calls.consumed[0], { ids: ['o1', 'o2'], hypothesisId: 'cog-1' });
});

test('recall ground that does not overlap leaves the observations ungrouped', async () => {
  const { scan, calls } = harnessWithRecall({
    observations: [
      noRef({ id: 'o1', conversation_id: 'conv-a' }),
      noRef({
        id: 'o2',
        conversation_id: 'conv-b',
        statement: 'They want the answer, not the reasoning.',
        observed_at: '2026-10-21T09:00:00Z',
      }),
    ],
    recall: async (query) => (query.includes('short answers')
      ? [{ id: 'unit-a', text: 'x' }]
      : [{ id: 'unit-b', text: 'y' }]),
  });

  const result = await scan.runOnce();

  assert.equal(result.formed, 0);
  assert.equal(result.recallGround.stored, 2);
  assert.equal(calls.saved.length, 0);
});

test('an observation that already carries a sourceRef is not recalled again', async () => {
  const seen = [];
  const { scan, calls } = harnessWithRecall({
    observations: [
      observation({ id: 'o1', conversation_id: 'conv-a' }),
      observation({ id: 'o2', conversation_id: 'conv-b', observed_at: '2026-10-21T09:00:00Z' }),
    ],
    recall: async (query) => { seen.push(query); return [{ id: 'unit-9', text: 'x' }]; },
  });

  const result = await scan.runOnce();

  assert.equal(result.formed, 1);
  assert.equal(seen.length, 0, 'no recall for observations the narrow axis already sees');
  assert.equal(calls.ground.length, 0);
});

test('a failed recall is best-effort: the pass still groups what it has', async () => {
  const { scan, calls } = harnessWithRecall({
    observations: [
      observation({ id: 'o1', conversation_id: 'conv-a' }),
      observation({ id: 'o2', conversation_id: 'conv-b', observed_at: '2026-10-21T09:00:00Z' }),
      noRef({ id: 'o3', conversation_id: 'conv-c', observed_at: '2026-10-21T10:00:00Z' }),
    ],
    recall: async () => { throw new Error('hindsight recall unreachable: timeout'); },
  });

  const result = await scan.runOnce();

  assert.equal(result.formed, 1, 'the sourceRef pair still forms');
  assert.equal(result.recallGround.failed, 1);
  assert.equal(calls.ground.length, 0);
});

test('recall ground is off when the environment says so', async () => {
  const seen = [];
  const cognition = {
    listObservations: async () => [
      noRef({ id: 'o1', conversation_id: 'conv-a' }),
      noRef({ id: 'o2', conversation_id: 'conv-b', observed_at: '2026-10-21T09:00:00Z' }),
    ],
    listHypotheses: async () => [],
    markObservationsConsumed: async () => ({ consumed: 2 }),
    mergeObservationGround: async () => { throw new Error('must not be called'); },
  };
  const scan = createBeliefFormationScan({
    cognition,
    sink: { save: async () => ({ id: 'cog-1' }) },
    hindsight: { recall: async (q) => { seen.push(q); return []; } },
    env: { GAIA_BELIEF_RECALL_GROUND: 'false' },
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await scan.runOnce();

  assert.equal(result.formed, 0, 'no ground, no group');
  assert.equal(seen.length, 0, 'no recall call at all');
  assert.deepEqual(result.recallGround, { recalled: 0, stored: 0, failed: 0 });
});

test('recall ground without a hindsight client degrades to the narrow axis', async () => {
  const { scan, calls } = harness({
    observations: [
      observation({ id: 'o1' }),
      observation({ id: 'o2', conversation_id: 'conv-b', observed_at: '2026-10-21T09:00:00Z' }),
    ],
  });
  // No hindsight passed: the pass must still work on sourceRef alone.
  const result = await scan.runOnce();

  assert.equal(result.formed, 1);
  assert.deepEqual(result.recallGround, { recalled: 0, stored: 0, failed: 0 });
  assert.equal(calls.saved.length, 1);
});

test('the per-pass cap bounds how many observations get a recall', async () => {
  const seen = [];
  const many = Array.from({ length: 10 }, (_, i) => noRef({
    id: `o${i}`,
    conversation_id: `conv-${i}`,
    observed_at: '2026-10-21T09:00:00Z',
  }));
  const cognition = {
    listObservations: async () => many,
    listHypotheses: async () => [],
    markObservationsConsumed: async () => ({ consumed: 0 }),
    mergeObservationGround: async () => ({ merged: 0 }),
  };
  const scan = createBeliefFormationScan({
    cognition,
    sink: { save: async () => ({ id: 'cog-1' }) },
    hindsight: { recall: async (q) => { seen.push(q); return []; } },
    env: { GAIA_BELIEF_RECALL_GROUND_MAX_PER_PASS: '3' },
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await scan.runOnce();

  assert.equal(seen.length, 3);
  assert.equal(result.recallGround.recalled, 3);
});
