'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHindsightClient, createCrossBankRecallClient } = require('../src/hindsightClient');

function fakeClient(name, results) {
  const calls = [];
  return {
    name,
    calls,
    async recall(query, options = {}) {
      calls.push({ query, options });
      if (results instanceof Error) throw results;
      return results;
    },
    async reflect() { return `${name}:reflect`; },
    async listMemories() { return [`${name}:list`]; },
  };
}

function unit(id, final) {
  return { id, text: id, scores: { final } };
}

test('recall fans out to every bank and merges by descending relevance score', async () => {
  const app = fakeClient('app', [unit('a', 0.4), unit('b', 0.9)]);
  const logos = fakeClient('logos', [unit('c', 0.7)]);
  const client = createCrossBankRecallClient(app, logos);

  const merged = await client.recall('who is Bo');

  assert.deepEqual(merged.map((u) => u.id), ['b', 'c', 'a']);
  assert.equal(app.calls.length, 1);
  assert.equal(logos.calls.length, 1);
  assert.equal(app.calls[0].query, 'who is Bo');
});

test('results without a relevance score sort last rather than crashing', async () => {
  const app = fakeClient('app', [unit('a', 0.2), { id: 'z', text: 'z', scores: { final: null } }]);
  const logos = fakeClient('logos', [unit('c', 0.5)]);
  const client = createCrossBankRecallClient(app, logos);

  assert.deepEqual((await client.recall('q')).map((u) => u.id), ['c', 'a', 'z']);
});

test('one bank failing drops only its slice (best-effort per bank)', async () => {
  const app = fakeClient('app', [unit('a', 0.3)]);
  const logos = fakeClient('logos', new Error('down'));
  const client = createCrossBankRecallClient(app, logos);

  assert.deepEqual((await client.recall('q')).map((u) => u.id), ['a']);
});

test('non-recall methods stay on the primary bank', async () => {
  const app = fakeClient('app', []);
  const logos = fakeClient('logos', []);
  const client = createCrossBankRecallClient(app, logos);

  assert.equal(await client.reflect(), 'app:reflect');
  assert.deepEqual(await client.listMemories(), ['app:list']);
});

test('the composed client hits both bank URLs through real clients', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ results: [] }) };
  };
  const app = createHindsightClient({ baseUrl: 'http://hs.test', bankId: 'gaia', fetchImpl });
  const logos = createHindsightClient({ baseUrl: 'http://hs.test', bankId: 'gaia-logos', fetchImpl });
  const client = createCrossBankRecallClient(app, logos);

  await client.recall('q');

  assert.deepEqual(urls.sort(), [
    'http://hs.test/v1/default/banks/gaia-logos/memories/recall',
    'http://hs.test/v1/default/banks/gaia/memories/recall',
  ]);
});
