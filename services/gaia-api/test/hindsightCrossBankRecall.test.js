'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHindsightClient, createCrossBankRecallClient, mergeBankSlices, quotaForBankCount, CROSS_BANK_QUOTA } = require('../src/hindsightClient');

function fakeClient(name, results, bankId = name) {
  const calls = [];
  return {
    name,
    bankId,
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

test('the tail is round-robin too: two rich banks beyond their quota both keep their turn (docs/memory-pipe-issues.md #2)', async () => {
  // Three banks, quota 3 (the default): `poor` only has one item, so the
  // guaranteed-fair phase hands back just 1 + 3 + 3 = 7 lines, two short of a
  // 9-line budget. `rich1` and `rich2` both have more than 3 relevant items —
  // exactly the "as soon as a bank has more than 3 relevant items" case the
  // issue names. The old flat-sort tail let whichever bank's 4th-best item
  // scored higher claim BOTH of the two remaining slots; round-robin gives
  // each rich bank exactly one of them instead.
  const poor = fakeClient('poor', [unit('p1', 0.9)]);
  // rich1's 4th and 5th best outscore rich2's, so a flat sort of the tail
  // would hand rich1 both remaining slots and rich2 none.
  const rich1 = fakeClient('rich1', [unit('r1a', 0.8), unit('r1b', 0.79), unit('r1c', 0.78), unit('r1d', 0.60), unit('r1e', 0.59)]);
  const rich2 = fakeClient('rich2', [unit('r2a', 0.7), unit('r2b', 0.69), unit('r2c', 0.68), unit('r2d', 0.50), unit('r2e', 0.49)]);
  const client = createCrossBankRecallClient(poor, rich1, rich2);

  const merged = await client.recall('q');

  // Fair phase (3 rounds, bank order poor/rich1/rich2): p1, r1a, r2a, r1b,
  // r2b, r1c, r2c — 7 lines, poor exhausted after round 1. The continued
  // round-robin then gives rich1 its 4th item AND rich2 its 4th item, in
  // that order — not r1d followed by r1e, which a flat score sort would have
  // produced (0.60 and 0.59 both beat r2's 0.50).
  assert.deepEqual(
    merged.slice(0, 9).map((u) => u.id),
    ['p1', 'r1a', 'r2a', 'r1b', 'r2b', 'r1c', 'r2c', 'r1d', 'r2d']
  );
});

test('one bank failing drops only its slice (best-effort per bank)', async () => {
  const app = fakeClient('app', [unit('a', 0.3)]);
  const logos = fakeClient('logos', new Error('down'));
  const client = createCrossBankRecallClient(app, logos);

  assert.deepEqual((await client.recall('q')).map((u) => u.id), ['a']);
});

// --- recallWithStatus: the side channel that tells a caller WHICH bank, if
// any, silently dropped out this turn (docs/memory-pipe-issues.md #1) -------

test('recallWithStatus reports every bank ok when all answer', async () => {
  const app = fakeClient('app', [unit('a', 0.3)]);
  const logos = fakeClient('logos', [unit('b', 0.5)]);
  const client = createCrossBankRecallClient(app, logos);

  const { items, bankStatus } = await client.recallWithStatus('q');

  // mergeBankSlices takes a round in bank order, not global score order
  // (same rule proven by the other merge tests above).
  assert.deepEqual(items.map((u) => u.id), ['a', 'b']);
  assert.deepEqual(bankStatus, { app: { status: 'ok' }, logos: { status: 'ok' } });
});

test('recallWithStatus marks a failed bank by its bankId, with a reason, and keeps the other slice', async () => {
  const app = fakeClient('app', [unit('a', 0.3)]);
  const logos = fakeClient('logos', new Error('hindsight recall unreachable: timeout'));
  const client = createCrossBankRecallClient(app, logos);

  const { items, bankStatus } = await client.recallWithStatus('q');

  assert.deepEqual(items.map((u) => u.id), ['a']);
  assert.deepEqual(bankStatus, {
    app: { status: 'ok' },
    logos: { status: 'failed', reason: 'unreachable' },
  });
});

test('recall() itself stays a bare array even when a bank fails — recallWithStatus is strictly additive', async () => {
  const app = fakeClient('app', [unit('a', 0.3)]);
  const logos = fakeClient('logos', new Error('down'));
  const client = createCrossBankRecallClient(app, logos);

  const items = await client.recall('q');
  assert.deepEqual(items.map((u) => u.id), ['a']);
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

// --- 18-10-2026: her own bank leaves the recall, so the quota has to divide ---

test('the quota divides the line budget over the banks that answered', () => {
  // Three banks and nine lines: unchanged from before. Two banks: five and
  // four, so the freed lines do not go to the globally best leftovers.
  assert.equal(quotaForBankCount(3), 3);
  assert.equal(quotaForBankCount(2), 5);
  assert.equal(quotaForBankCount(1), 9);
  assert.equal(quotaForBankCount(0), CROSS_BANK_QUOTA);
  assert.equal(quotaForBankCount(2, 6), 3);
});

test('a recall over two banks takes five lines from one and three from the other', async () => {
  const app = fakeClient('app', [unit('a1', 0.9), unit('a2', 0.88), unit('a3', 0.86), unit('a4', 0.84), unit('a5', 0.82), unit('a6', 0.8)]);
  const logos = fakeClient('logos', [unit('l1', 0.5), unit('l2', 0.48), unit('l3', 0.46)]);
  const client = createCrossBankRecallClient(app, logos);

  const merged = await client.recall('wat weet je over Yassine?');
  assert.deepEqual(merged.map((u) => u.id), ['a1', 'l1', 'a2', 'l2', 'a3', 'l3', 'a4', 'a5', 'a6']);

  // A caller may ask for a different division: one line each, then the rest.
  const forced = await client.recall('x', { quota: 1 });
  assert.deepEqual(forced.slice(0, 3).map((u) => u.id), ['a1', 'l1', 'a2']);
});

test('the quota is not forwarded to the banks themselves', async () => {
  const app = fakeClient('app', [unit('a1', 0.9)]);
  const seen = [];
  const spy = { ...app, recall: async (query, options) => { seen.push(options); return [unit('a1', 0.9)]; } };
  const client = createCrossBankRecallClient(spy);
  await client.recall('iets', { quota: 2, budget: 'mid' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].quota, undefined);
  assert.equal(seen[0].budget, 'mid');
});
