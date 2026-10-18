'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adoptDocumentFacts } = require('../src/reasoning/hindsightFacts');

test('returns the facts as soon as Hindsight has extracted them', async () => {
  let calls = 0;
  const client = { listMemories: async () => { calls += 1; return calls < 3 ? [] : [{ id: 'f1' }]; } };
  const facts = await adoptDocumentFacts(client, 'doc-1', 3, 1);
  assert.deepEqual(facts, [{ id: 'f1' }]);
  assert.equal(calls, 3);
});

test('gives up after the given attempts and returns the empty answer', async () => {
  let calls = 0;
  const client = { listMemories: async () => { calls += 1; return []; } };
  assert.deepEqual(await adoptDocumentFacts(client, 'doc-1', 2, 1), []);
  assert.equal(calls, 2);
});

test('asks for the document\'s world facts', async () => {
  let seen;
  const client = { listMemories: async (q) => { seen = q; return [{ id: 'x' }]; } };
  await adoptDocumentFacts(client, 'doc-9');
  assert.deepEqual(seen, { documentId: 'doc-9', type: 'world' });
});
