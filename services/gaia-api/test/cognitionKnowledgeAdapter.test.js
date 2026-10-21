'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCognitionKnowledgeAdapter } = require('../src/reasoning/cognitionKnowledgeAdapter');

function fakeCognition() {
  const calls = [];
  return {
    calls,
    proposeHypothesis: async (r) => { calls.push(['propose', r]); return { id: 'c1', ...r }; },
    createObservation: async (r) => { calls.push(['observation', r]); return { id: 'o1', ...r }; },
  };
}

function fakeFoundation() {
  const calls = [];
  return {
    calls,
    submitObservation: async (entry) => { calls.push(entry); return true; },
  };
}

const turn = {
  evidence: [
    { id: 'hindsight-1', source: 'hindsight', sourceRef: 'fact-88', content: 'They asked for short answers.' },
    { id: 'turn-2', source: 'conversation', content: 'They pasted a wall of text.' },
  ],
  conversationId: 'conv-7',
  observedAt: '2026-10-22T09:15:00.000Z',
};

test('retainObservation keeps the raw record in Foundation and a linked one in Cognition', async () => {
  const cognition = fakeCognition();
  const foundation = fakeFoundation();
  const adapter = createCognitionKnowledgeAdapter({ cognition, foundation, sync: null });

  await adapter.retainObservation(
    { statement: 'They prefer short answers.', evidence: [{ id: 'hindsight-1', source: 'hindsight' }] },
    turn,
  );

  assert.deepEqual(foundation.calls[0], {
    content: 'They prefer short answers.',
    source: 'gaia-observation',
    tags: ['gaia-observation'],
  });
  // The linked copy carries only the evidence the observation actually cited,
  // with the two fields that outlive the turn.
  assert.deepEqual(cognition.calls[0][1].evidence_items, [{
    id: 'hindsight-1',
    source: 'hindsight',
    sourceRef: 'fact-88',
    observedAt: '2026-10-22T09:15:00.000Z',
    content: 'They asked for short answers.',
  }]);
  assert.equal(cognition.calls[0][1].conversation_id, 'conv-7');
  assert.equal(cognition.calls[0][1].observed_at, '2026-10-22T09:15:00.000Z');
});

test('retainObservation gives an invented citation nothing to stand on', async () => {
  const cognition = fakeCognition();
  const adapter = createCognitionKnowledgeAdapter({ cognition, foundation: fakeFoundation(), sync: null });

  await adapter.retainObservation(
    { statement: 'A claim with a made-up source.', evidence: [{ id: 'hindsight-99', source: 'hindsight' }] },
    turn,
  );

  assert.equal('evidence_items' in cognition.calls[0][1], false);
});

test('retainObservation survives a store that cannot take the linked copy', async () => {
  const cognition = { createObservation: async () => { throw new Error('cognition down'); } };
  const foundation = fakeFoundation();
  const adapter = createCognitionKnowledgeAdapter({ cognition, foundation, sync: null });

  const outcome = await adapter.retainObservation({ statement: 'x', evidence: [] }, turn);

  // The raw moment is already safe; the working set is best-effort.
  assert.equal(foundation.calls.length, 1);
  assert.equal(outcome.submitted, true);
});
