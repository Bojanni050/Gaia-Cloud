'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { createMemoryRouter } = require('../src/memoryRoutes');

// A bank that behaves like the Hindsight client for the three verbs a
// retraction uses, and records what it was asked and told.
function fakeBank(name, items) {
  const calls = { queries: [], patched: [], kept: [] };
  return {
    name,
    calls,
    client: {
      async listMemories(query) { calls.queries.push(query); return items; },
      async patchMemoryState(id, state, reason) { calls.patched.push({ id, state, reason }); },
      async retainSync(payload) { calls.kept.push(payload); },
    },
  };
}

function appWith(deps) {
  const app = express();
  app.use(express.json());
  app.use('/memory', createMemoryRouter(deps));
  return app;
}

test('POST /memory/retract without a quote is a bad request, and touches nothing', async () => {
  const bank = fakeBank('bojan', []);
  const res = await request(appWith({ banks: [bank] })).post('/memory/retract').send({ quote: '   ' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'quote is required');
  assert.deepEqual(bank.calls.patched, []);
});

test('POST /memory/retract answers 503 when no bank is wired, rather than pretending', async () => {
  const res = await request(appWith({ banks: [] })).post('/memory/retract').send({ quote: 'iets' });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'memory retraction is not available');
});

test('POST /memory/retract takes the memory back and reports it in the same words the tool uses', async () => {
  const bank = fakeBank('bojan', [{ id: 'f1', text: 'Yassine is een vriend van je', state: 'valid' }]);
  const res = await request(appWith({ banks: [bank], home: bank }))
    .post('/memory/retract')
    .send({ quote: 'Yassine is een vriend van je' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'retracted');
  assert.match(res.body.message, /^Taken back: "Yassine is een vriend van je"$/m);
  assert.equal(res.body.retracted.bank, 'bojan');
  assert.deepEqual(bank.calls.patched, [{
    id: 'f1',
    state: 'invalidated',
    reason: 'the person said this is not correct',
  }]);
});

test('POST /memory/retract carries the correction through as the true version', async () => {
  const bank = fakeBank('bojan', [{ id: 'f1', text: 'Yassine is een vriend van je', state: 'valid' }]);
  const res = await request(appWith({ banks: [bank], home: bank }))
    .post('/memory/retract')
    .send({ quote: 'Yassine is een vriend van je', correction: '  Yassine is een kennis  ' });

  assert.equal(res.status, 200);
  assert.match(res.body.message, /Kept instead: "Yassine is een kennis"/);
  assert.equal(bank.calls.kept.length, 1);
  assert.equal(bank.calls.kept[0].content, 'Yassine is een kennis');
  assert.deepEqual(bank.calls.kept[0].tags, ['gaia:confirmed_fact', 'gaia:correction']);
  assert.equal(bank.calls.kept[0].metadata.gaia_corrected_from, 'f1');
});

test('POST /memory/retract retires the derived statement too when the memory came from one', async () => {
  const bank = fakeBank('bojan', [{
    id: 'f1',
    text: 'Yassine is een vriend van je',
    state: 'valid',
    metadata: { gaia_hypothesis_id: 'a9eeb399' },
  }]);
  const rejected = [];
  const mirrored = [];
  const res = await request(appWith({
    banks: [bank],
    home: bank,
    cognition: { rejectHypothesis: async (id, o) => { rejected.push([id, o]); return { id, status: 'rejected' }; } },
    sync: { syncHypothesis: async (record) => { mirrored.push(record); } },
  }))
    .post('/memory/retract')
    .send({ quote: 'Yassine is een vriend van je' });

  assert.equal(res.status, 200);
  assert.deepEqual(rejected, [['a9eeb399', { reason: 'the person said this is not correct', verwerpBron: 'mens' }]]);
  assert.deepEqual(mirrored, [{ id: 'a9eeb399', status: 'rejected' }]);
  assert.equal(res.body.source.status, 'rejected');
  assert.match(res.body.message, /The statement it came from is rejected too/);
});

test('POST /memory/retract asks which one when more than one memory fits, and touches nothing', async () => {
  const first = fakeBank('bojan', [{ id: 'f1', text: 'Yassine is een vriend van je', state: 'valid' }]);
  const second = fakeBank('gaia-logos', [{ id: 'f2', text: 'Yassine schaakt graag op zondag', state: 'valid' }]);
  const res = await request(appWith({ banks: [first, second] }))
    .post('/memory/retract')
    .send({ quote: 'Yassine' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ambiguous');
  assert.deepEqual(res.body.candidates.map((c) => c.bank), ['bojan', 'gaia-logos']);
  assert.match(res.body.message, /^More than one memory matches/);
  assert.deepEqual(first.calls.patched, []);
  assert.deepEqual(second.calls.patched, []);
});

test('POST /memory/retract takes back every copy of the claim, in every bank that holds it', async () => {
  const first = fakeBank('bojan', [{ id: 'f1', text: 'Yassine is een vriend van je', state: 'valid' }]);
  const second = fakeBank('gaia-logos', [{ id: 'f2', text: 'Yassine is een vriend van je', state: 'valid' }]);
  const res = await request(appWith({ banks: [first, second], home: first }))
    .post('/memory/retract')
    .send({ quote: 'Yassine is een vriend van je' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'retracted');
  assert.equal(res.body.retracted.id, 'f1');
  assert.deepEqual(res.body.alsoRetracted.map((c) => c.id), ['f2']);
  assert.deepEqual(first.calls.patched.map((p) => p.id), ['f1']);
  assert.deepEqual(second.calls.patched.map((p) => p.id), ['f2']);
  assert.match(res.body.message, /The same thing was kept in 1 more place — taken back too/);
});

test('POST /memory/retract says plainly when nothing matches', async () => {
  const bank = fakeBank('bojan', [{ id: 'f1', text: 'Bo drinkt graag koffie in de ochtend', state: 'valid' }]);
  const res = await request(appWith({ banks: [bank] }))
    .post('/memory/retract')
    .send({ quote: 'Yassine is een vriend van je' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'not_found');
  assert.equal(res.body.candidates.length, 0);
  assert.equal(res.body.message, 'Nothing in memory matches that closely enough to take back.');
  assert.deepEqual(bank.calls.patched, []);
});

test('POST /memory/retract never throws at the client when a store is down', async () => {
  const bank = {
    name: 'bojan',
    client: { async listMemories() { throw new Error('down'); } },
  };
  const res = await request(appWith({ banks: [bank] }))
    .post('/memory/retract')
    .send({ quote: 'iets' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'not_found');
});

test('the route is behind the bearer guard when one is given', async () => {
  const bank = fakeBank('bojan', [{ id: 'f1', text: 'iets', state: 'valid' }]);
  const guard = (req, res, next) => (req.headers.authorization === 'Bearer good' ? next() : res.status(401).json({ error: 'nope' }));

  const app = appWith({ banks: [bank], auth: guard });
  assert.equal((await request(app).post('/memory/retract').send({ quote: 'iets' })).status, 401);
  assert.equal((await request(app).post('/memory/retract').set('Authorization', 'Bearer good').send({ quote: 'iets' })).status, 200);
});

test('POST /memory/forget takes the memory out without judging it, and keeps nothing', async () => {
  const bank = fakeBank('bojan', [{ id: 'f1', text: 'Bo deed op 4 juli 2026 een afscheidsritueel met Luca', state: 'valid' }]);
  const res = await request(appWith({ banks: [bank], home: bank }))
    .post('/memory/forget')
    .send({ quote: 'Bo deed op 4 juli 2026 een afscheidsritueel met Luca' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'forgotten');
  assert.match(res.body.message, /^Forgotten: "Bo deed op 4 juli 2026 een afscheidsritueel met Luca"$/m);
  assert.equal(res.body.message.includes('Kept instead'), false);
  assert.deepEqual(bank.calls.patched, [{
    id: 'f1',
    state: 'invalidated',
    reason: 'the person asked for this to be forgotten',
  }]);
  assert.deepEqual(bank.calls.kept, []);
});

test('POST /memory/forget without a quote is a bad request, and 503 when no bank is wired', async () => {
  const bank = fakeBank('bojan', []);
  const missing = await request(appWith({ banks: [bank] })).post('/memory/forget').send({ quote: '  ' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'quote is required');
  assert.deepEqual(bank.calls.patched, []);

  const unwired = await request(appWith({ banks: [] })).post('/memory/forget').send({ quote: 'iets' });
  assert.equal(unwired.status, 503);
  assert.equal(unwired.body.error, 'memory forgetting is not available');
});

test('POST /memory/forget asks which one when more than one memory fits, and touches nothing', async () => {
  const first = fakeBank('bojan', [{ id: 'f1', text: 'Yassine is een vriend van je', state: 'valid' }]);
  const second = fakeBank('gaia-logos', [{ id: 'f2', text: 'Yassine schaakt graag op zondag', state: 'valid' }]);
  const res = await request(appWith({ banks: [first, second] }))
    .post('/memory/forget')
    .send({ quote: 'Yassine' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ambiguous');
  assert.match(res.body.message, /^More than one memory matches — say which one to forget:/);
  assert.deepEqual(first.calls.patched, []);
  assert.deepEqual(second.calls.patched, []);
});
