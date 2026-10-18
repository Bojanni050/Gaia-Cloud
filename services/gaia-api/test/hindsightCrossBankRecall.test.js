'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHindsightClient, createCrossBankRecallClient, mergeBankSlices } = require('../src/hindsightClient');

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
  const app = fakeClient('app', [{ id: 'z', text: 'z', scores: { final: null } }]);
  const logos = fakeClient('logos', [unit('c', 0.5)]);
  const client = createCrossBankRecallClient(app, logos);

  const merged = await client.recall('q');

  assert.deepEqual(merged.map((u) => u.id), ['c', 'z']);
});

test('a bank scoring lower still gets its best lines in (measured 18-10-2026)', async () => {
  // Live, for "Wat weet je over Yassine?": bank bojan scored 0.695 at best
  // (average 0.535) while gaia reached 1.086 and gaia-logos 1.024. A flat score
  // sort therefore returned six lines from the other two banks and not one word
  // about Yassine, which is why she answered that she knew nothing about him.
  const bojan = fakeClient('bojan', [unit('friend', 0.695), unit('visit', 0.627)]);
  const logos = fakeClient('gaia-logos', [unit('logos-1', 1.024), unit('logos-2', 0.9)]);
  const gaia = fakeClient('gaia', [unit('gaia-1', 1.086), unit('gaia-2', 1.04)]);
  const client = createCrossBankRecallClient(bojan, logos, gaia);

  const merged = await client.recall('Wat weet je over Yassine?');

  assert.deepEqual(
    merged.slice(0, 6).map((u) => u.id),
    ['friend', 'logos-1', 'gaia-1', 'visit', 'logos-2', 'gaia-2']
  );
});

test('every bank speaks before any bank repeats, and nothing is dropped', async () => {
  const a = fakeClient('a', [unit('a1', 0.2), unit('a2', 0.19)]);
  const b = fakeClient('b', [unit('b1', 0.9)]);
  const c = fakeClient('c', [unit('c1', 0.5), unit('c2', 0.4), unit('c3', 0.3)]);
  const client = createCrossBankRecallClient(a, b, c);

  assert.deepEqual(
    (await client.recall('q')).map((u) => u.id),
    ['a1', 'b1', 'c1', 'a2', 'c2', 'c3']
  );
});

test('a single bank keeps its own ranking', async () => {
  const a = fakeClient('a', [unit('a2', 0.2), unit('a1', 0.9)]);
  const client = createCrossBankRecallClient(a);

  assert.deepEqual((await client.recall('q')).map((u) => u.id), ['a1', 'a2']);
});

test('mergeBankSlices tolerates a missing slice and a zero quota', () => {
  assert.deepEqual(mergeBankSlices([null, [unit('x', 1)]], 0).map((u) => u.id), ['x']);
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
