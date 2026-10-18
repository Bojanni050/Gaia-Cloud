'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHindsightClient } = require('../src/hindsightClient');

function clientWith(fetchImpl) {
  return createHindsightClient({ baseUrl: 'http://hs.test', bankId: 'bank', fetchImpl });
}
const ok = (json) => async () => ({ ok: true, status: 200, json: async () => json });
const status = (code) => async () => ({ ok: false, status: code, json: async () => ({}) });
const down = async () => { throw new Error('connect ECONNREFUSED'); };

test('a throwing call says what it was and why it failed', async () => {
  await assert.rejects(clientWith(down).recall('q'), /hindsight recall unreachable: connect ECONNREFUSED/);
  await assert.rejects(clientWith(status(500)).recall('q'), /hindsight recall responded 500/);
  await assert.rejects(clientWith(status(503)).listMemories({}), /hindsight memories\/list responded 503/);
  await assert.rejects(clientWith(status(400)).patchMemoryState('m1', 'valid'), /hindsight memory patch responded 400/);
  await assert.rejects(clientWith(down).getKnowledgeTree(), /hindsight knowledge tree unreachable/);
  await assert.rejects(clientWith(status(404)).deleteKnowledgeNode('n1'), /hindsight knowledge node delete responded 404/);
});

test('the soft reads answer null instead of throwing', async () => {
  assert.equal(await clientWith(down).getMentalModel('mm'), null);
  assert.equal(await clientWith(status(404)).getMentalModel('mm'), null);
  assert.equal(await clientWith(down).getMemory('m1'), null);
  assert.equal(await clientWith(status(500)).getKnowledgePage('p1'), null);
});

test('a soft read still treats the generating placeholder as no content', async () => {
  assert.equal(await clientWith(ok({ id: 'mm', content: 'Generating content...' })).getMentalModel('mm'), null);
});

test('the async retain sends no abort signal, the sync retain a long one', async () => {
  const seen = [];
  const client = clientWith(async (url, options) => { seen.push(options); return { ok: true, json: async () => ({}) }; });
  await client.reflect({ summary: 's' });
  await client.retainSync({ content: 'c' });
  assert.equal(seen[0].signal, undefined, 'the async retain is not cut off by the call timeout');
  assert.ok(seen[1].signal, 'the sync retain carries a signal');
  assert.equal(JSON.parse(seen[0].body).async, true);
  assert.equal(JSON.parse(seen[1].body).async, false);
});

test('a call without a body sends none', async () => {
  let options;
  const client = clientWith(async (url, o) => { options = o; return { ok: true, json: async () => ({ items: [] }) }; });
  await client.listMemories({});
  assert.equal(options.method, 'GET');
  assert.equal('body' in options, false);
});
