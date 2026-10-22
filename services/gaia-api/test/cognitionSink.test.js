'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCognitionSink } = require('../src/reasoning/cognitionSink');

function fakeCognition() {
  const calls = [];
  let seq = 0;
  return {
    calls,
    proposeHypothesis: async (r) => { calls.push(['propose', r]); return { id: `c${++seq}`, ...r }; },
    updateHypothesis: async (id, p) => { calls.push(['patch', id, p]); return { id, ...p }; },
    applyEvidence: async (id, e) => { calls.push(['evidence', id, e]); return { id }; },
    markTesting: async (id) => { calls.push(['test', id]); return { id, status: 'testing' }; },
    markCorroborated: async (id) => { calls.push(['corroborate', id]); return { id, status: 'corroborated' }; },
    rejectHypothesis: async (id, o) => { calls.push(['reject', id, o]); return { id, status: 'rejected' }; },
    reopenHypothesis: async (id, o) => { calls.push(['reopen', id, o]); return { id, status: 'testing' }; },
    getHypothesis: async (id) => ({ id }),
    createPattern: async (r) => { calls.push(['createPattern', r]); return { id: `p${++seq}`, ...r }; },
    updatePattern: async (id, p) => { calls.push(['updatePattern', id, p]); return { id, ...p }; },
  };
}

test('saveHypothesis proposes into Cognition with the manager fields and mirrors', async () => {
  const cognition = fakeCognition();
  const synced = [];
  const sink = createCognitionSink({ cognition, sync: { syncHypothesis: async (r) => synced.push(r) } });

  await sink.hypothesis.save({
    id: 'hyp-1', statement: 'x', confidence: 0.6,
    evidenceFor: ['m1'], evidenceAgainst: [], persistence: 'durable', method: 'derived',
  });

  assert.equal(cognition.calls[0][0], 'propose');
  assert.deepEqual(cognition.calls[0][1].evidence_for, ['m1']);
  assert.equal(cognition.calls[0][1].persistence, 'durable');
  assert.equal(cognition.calls[0][1].method, 'derived');
  assert.equal(synced.length, 1);
});

test('saveHypothesis keeps the words behind the citations, and only those', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition, sync: null });

  await sink.hypothesis.save(
    {
      id: 'hyp-1', statement: 'x', confidence: 0.6,
      evidenceFor: ['hindsight-1'], evidenceAgainst: ['turn-2'], persistence: 'durable', method: 'derived',
    },
    {
      evidence: [
        { id: 'hindsight-1', source: 'hindsight', content: 'They asked for short answers.' },
        { id: 'turn-2', source: 'conversation', content: 'They pasted a wall of text.' },
        { id: 'upload-9', source: 'upload', content: 'not cited by this record' },
      ],
    },
  );

  assert.deepEqual(cognition.calls[0][1].evidence_items, [
    { id: 'hindsight-1', source: 'hindsight', content: 'They asked for short answers.' },
    { id: 'turn-2', source: 'conversation', content: 'They pasted a wall of text.' },
  ]);
});

test('saveHypothesis sends no snapshot at all when the turn resolved none', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition, sync: null });

  // A promotion/expiry scan re-saves a record it did not derive: it has no
  // evidence in hand, and must not rewrite what the record already kept.
  await sink.hypothesis.save({ id: 'hyp-1', statement: 'x', evidenceFor: ['hindsight-1'] });

  assert.equal('evidence_items' in cognition.calls[0][1], false);
});

test('saveHypothesis keeps the store-side identity and the moment, not just the quote', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition, sync: null });

  await sink.hypothesis.save(
    { id: 'hyp-1', statement: 'x', evidenceFor: ['hindsight-1'] },
    {
      evidence: [{ id: 'hindsight-1', source: 'hindsight', sourceRef: 'fact-88', content: 'They asked for short answers.' }],
      observedAt: '2026-10-21T22:10:00.000Z',
    },
  );

  // The local id locates the quote, sourceRef says what it is about over time,
  // observedAt says when it was seen — a later pass needs all three.
  assert.deepEqual(cognition.calls[0][1].evidence_items, [{
    id: 'hindsight-1',
    source: 'hindsight',
    sourceRef: 'fact-88',
    observedAt: '2026-10-21T22:10:00.000Z',
    content: 'They asked for short answers.',
  }]);
});

test('observe keeps a one-turn claim as raw material, not as a statement', async () => {
  const cognition = fakeCognition();
  cognition.createObservation = async (r) => { cognition.calls.push(['observation', r]); return { id: 'o1', ...r }; };
  const sink = createCognitionSink({ cognition, sync: null });

  await sink.hypothesis.observe(
    { statement: 'They want the answer, not the reasoning.', evidenceFor: ['hindsight-1'], evidenceAgainst: [] },
    {
      evidence: [{ id: 'hindsight-1', source: 'hindsight', sourceRef: 'fact-88', content: 'Asked to skip the explanation.' }],
      observedAt: '2026-10-22T09:15:00.000Z',
      conversationId: 'conv-7',
    },
  );

  const [, record] = cognition.calls[0];
  assert.equal(record.statement, 'They want the answer, not the reasoning.');
  assert.equal(record.conversation_id, 'conv-7');
  assert.equal(record.observed_at, '2026-10-22T09:15:00.000Z');
  assert.deepEqual(record.evidence_items, [{
    id: 'hindsight-1',
    source: 'hindsight',
    sourceRef: 'fact-88',
    observedAt: '2026-10-22T09:15:00.000Z',
    content: 'Asked to skip the explanation.',
  }]);
});

test('saveHypothesis carries the counter-hypothesis and scope into Cognition', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition, sync: null });

  await sink.hypothesis.save({
    id: 'hyp-1', statement: 'x', confidence: 0.6, scope: 'micro',
    counterHypothesis: 'the opposite reading', evidenceFor: [], evidenceAgainst: [],
  });

  assert.equal(cognition.calls[0][1].counter_hypothesis, 'the opposite reading');
  assert.equal(cognition.calls[0][1].scope, 'micro');
});

test('updateHypothesis patches a late-arriving counter-hypothesis', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition, sync: null });

  await sink.hypothesis.update('c1',
    { id: 'c1', status: 'testing', counterHypothesis: 'the opposing reading', evidenceFor: [], evidenceAgainst: [] },
    { id: 'c1', status: 'testing', counterHypothesis: null, evidenceFor: [], evidenceAgainst: [] });

  const patch = cognition.calls.find((c) => c[0] === 'patch');
  assert.equal(patch[2].counter_hypothesis, 'the opposing reading');
});

test('updateHypothesis sends evidence verdicts and the lifecycle verb, never confirmed', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition, sync: null });

  await sink.hypothesis.update('c9', {
    id: 'c9', status: 'testing', evidenceFor: ['m1'], evidenceAgainst: ['m2'], confidence: 0.5,
  }, {
    id: 'c9', status: 'proposed', evidenceFor: [], evidenceAgainst: [], confidence: 0.5,
  });

  const verbs = cognition.calls.map((c) => c[0]);
  assert.ok(verbs.includes('evidence'));
  assert.ok(verbs.includes('test'));
  assert.ok(!verbs.includes('confirm'), 'confirmed is never auto-mirrored');
  const supportCall = cognition.calls.find((c) => c[0] === 'evidence' && c[2].relation === 'supports');
  const contradictCall = cognition.calls.find((c) => c[0] === 'evidence' && c[2].relation === 'contradicts');
  assert.equal(supportCall[2].evidenceId, 'm1');
  assert.equal(contradictCall[2].evidenceId, 'm2');
});

test('updateHypothesis hands each new citation the words that came with it', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition, sync: null });

  await sink.hypothesis.update('c9', {
    id: 'c9', status: 'testing', evidenceFor: [], evidenceAgainst: ['turn-2'], confidence: 0.4,
  }, {
    id: 'c9', status: 'testing', evidenceFor: [], evidenceAgainst: [], confidence: 0.5,
  }, {
    evidence: [{ id: 'turn-2', source: 'conversation', content: 'They said the opposite yesterday.' }],
  });

  const contradictCall = cognition.calls.find((c) => c[0] === 'evidence' && c[2].relation === 'contradicts');
  assert.deepEqual(contradictCall[2].evidenceItem, {
    id: 'turn-2', source: 'conversation', content: 'They said the opposite yesterday.',
  });
});

test('updateHypothesis patches a statement change and a persistence change', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition });

  await sink.hypothesis.update('c1', { id: 'c1', statement: 'new', persistence: 'durable', status: 'proposed' },
    { id: 'c1', statement: 'old', persistence: 'ephemeral', status: 'proposed' });

  const patch = cognition.calls.find((c) => c[0] === 'patch');
  assert.equal(patch[2].statement, 'new');
  assert.equal(patch[2].persistence, 'durable');
});

test('updateHypothesis maps a rejected→testing reopen to reopenHypothesis, never markTesting', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition, sync: null });

  await sink.hypothesis.update('c1',
    { id: 'c1', status: 'testing', evidenceFor: [], evidenceAgainst: [], history: [{ from: 'rejected', to: 'testing', rationale: 'human: the disproof was retracted' }] },
    { id: 'c1', status: 'rejected', evidenceFor: [], evidenceAgainst: [] });

  const reopen = cognition.calls.find((c) => c[0] === 'reopen');
  assert.ok(reopen, 'the store reopen verb was used');
  assert.equal(reopen[2].reason, 'human: the disproof was retracted');
  assert.ok(!cognition.calls.some((c) => c[0] === 'test'), 'markTesting would be refused by the store');
});

test('a confirmed status change is not mirrored but the record still syncs', async () => {
  const cognition = fakeCognition();
  const synced = [];
  const sink = createCognitionSink({ cognition, sync: { syncHypothesis: async (r) => synced.push(r) } });

  await sink.hypothesis.update('c1', { id: 'c1', status: 'confirmed' }, { id: 'c1', status: 'corroborated' });

  assert.ok(!cognition.calls.some((c) => c[0] === 'confirm'));
  assert.equal(synced.length, 1, 'the record is still synced to Hindsight');
});

test('updateHypothesis walks the store through testing to reach corroborated', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition, sync: null });

  // The store record is still `proposed` (created by save, never marked
  // testing): the machine tier is only reachable from testing.
  cognition.getHypothesis = async (id) => ({ id, status: 'proposed' });
  await sink.hypothesis.update('c1',
    { id: 'c1', status: 'corroborated', evidenceFor: [], evidenceAgainst: [] },
    { id: 'c1', status: 'proposed', evidenceFor: [], evidenceAgainst: [] });

  const verbs = cognition.calls.map((c) => c[0]).filter((v) => v === 'test' || v === 'corroborate');
  assert.deepEqual(verbs, ['test', 'corroborate']);
});

test('updateHypothesis does not re-mark a store record that is already testing', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition, sync: null });

  cognition.getHypothesis = async (id) => ({ id, status: 'testing' });
  await sink.hypothesis.update('c1',
    { id: 'c1', status: 'corroborated', evidenceFor: [], evidenceAgainst: [] },
    { id: 'c1', status: 'testing', evidenceFor: [], evidenceAgainst: [] });

  assert.ok(!cognition.calls.some((c) => c[0] === 'test'), 'markTesting would be a refused self-transition');
  assert.ok(cognition.calls.some((c) => c[0] === 'corroborate'));
});

test('updateHypothesis reaches corroborated through a store that enforces its own transitions', async () => {
  // A stateful fake with Cognition's real table: proposed → corroborated is
  // refused there, so this proves the walk really lands the record.
  const VALID = {
    proposed: ['testing', 'confirmed', 'rejected'],
    testing: ['corroborated', 'confirmed', 'rejected', 'proposed'],
    corroborated: ['confirmed', 'rejected', 'testing'],
    confirmed: [],
    rejected: [],
  };
  let status = 'proposed';
  const calls = [];
  const cognition = {
    getHypothesis: async () => ({ id: 'c1', status }),
    markTesting: async () => {
      assert.ok(VALID[status].includes('testing'), `store refused ${status} to testing`);
      status = 'testing';
      calls.push('test');
      return { id: 'c1', status };
    },
    markCorroborated: async () => {
      assert.ok(VALID[status].includes('corroborated'), `store refused ${status} to corroborated`);
      status = 'corroborated';
      calls.push('corroborate');
      return { id: 'c1', status };
    },
  };
  const sink = createCognitionSink({ cognition, sync: null });

  await sink.hypothesis.update('c1', { id: 'c1', status: 'corroborated' }, { id: 'c1', status: 'testing' });

  assert.equal(status, 'corroborated');
  assert.deepEqual(calls, ['test', 'corroborate']);
});

test('pattern sink creates and updates Cognition patterns', async () => {
  const cognition = fakeCognition();
  const synced = [];
  const sink = createCognitionSink({ cognition, sync: { syncPattern: async (r) => synced.push(r) } });

  await sink.pattern.save({ id: 'pattern-1', statement: 'late nights', status: 'candidate', confidence: 0.5, hypothesisIds: ['h1', 'h2'] });
  await sink.pattern.update('p9', { id: 'p9', statement: 'late nights', status: 'supported', confidence: 0.6, hypothesisIds: ['h1', 'h2'] });

  const create = cognition.calls.find((c) => c[0] === 'createPattern');
  assert.equal(create[1].content, 'late nights');
  assert.deepEqual(create[1].hypothesis_ids, ['h1', 'h2']);
  const upd = cognition.calls.find((c) => c[0] === 'updatePattern');
  assert.equal(upd[2].status, 'supported');
  assert.equal(synced.length, 2);
});
