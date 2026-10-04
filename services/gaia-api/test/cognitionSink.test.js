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

test('updateHypothesis patches a statement change and a persistence change', async () => {
  const cognition = fakeCognition();
  const sink = createCognitionSink({ cognition });

  await sink.hypothesis.update('c1', { id: 'c1', statement: 'new', persistence: 'durable', status: 'proposed' },
    { id: 'c1', statement: 'old', persistence: 'ephemeral', status: 'proposed' });

  const patch = cognition.calls.find((c) => c[0] === 'patch');
  assert.equal(patch[2].statement, 'new');
  assert.equal(patch[2].persistence, 'durable');
});

test('a confirmed status change is not mirrored but the record still syncs', async () => {
  const cognition = fakeCognition();
  const synced = [];
  const sink = createCognitionSink({ cognition, sync: { syncHypothesis: async (r) => synced.push(r) } });

  await sink.hypothesis.update('c1', { id: 'c1', status: 'confirmed' }, { id: 'c1', status: 'corroborated' });

  assert.ok(!cognition.calls.some((c) => c[0] === 'confirm'));
  assert.equal(synced.length, 1, 'the record is still synced to Hindsight');
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
