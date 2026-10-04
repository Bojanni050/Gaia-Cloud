'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { createCognitionRouter } = require('../src/cognitionRoutes');

function fakeCognition() {
  const calls = [];
  return {
    calls,
    listHypotheses: async (q) => { calls.push(['list', q]); return [{ id: 'h1', status: 'testing' }]; },
    markTesting: async (id) => { calls.push(['test', id]); return { id, status: 'testing' }; },
    rejectHypothesis: async (id, o) => { calls.push(['reject', id, o]); return { id, status: 'rejected', verwerp_bron: o.verwerpBron }; },
    getHypothesis: async (id) => { calls.push(['get', id]); return { id, status: 'testing', scope: 'macro' }; },
    confirmHypothesis: async (id, o) => { calls.push(['confirm', id, o]); return { id, status: 'confirmed', statement: (o && o.statement) || 'statement' }; },
    supersedeHypothesis: async (id, o) => { calls.push(['supersede', id, o]); return { id, status: 'rejected', superseded_by_id: o.supersededById }; },
  };
}

function appWith({ cognition, sync }) {
  const app = express();
  app.use(express.json());
  app.use('/cognition', createCognitionRouter({ cognition, sync }));
  return app;
}

test('GET /cognition/hypotheses lists derived statements', async () => {
  const cognition = fakeCognition();
  const res = await request(appWith({ cognition })).get('/cognition/hypotheses');
  assert.equal(res.status, 200);
  assert.equal(res.body.hypotheses.length, 1);
  assert.equal(cognition.calls[0][0], 'list');
});

test('POST reject uses verwerp_bron mens and mirrors', async () => {
  const cognition = fakeCognition();
  const mirrored = [];
  const res = await request(appWith({ cognition, sync: { syncHypothesis: async (r) => mirrored.push(r) } }))
    .post('/cognition/hypotheses/h1/reject').send({ reason: 'not true' });

  assert.equal(res.status, 200);
  assert.equal(res.body.verwerp_bron, 'mens');
  assert.equal(mirrored.length, 1);
});

test('POST confirm is the human path and performs active supersession', async () => {
  const cognition = fakeCognition();
  const mirrored = [];
  const res = await request(appWith({ cognition, sync: { syncHypothesis: async (r) => mirrored.push(r) } }))
    .post('/cognition/hypotheses/h2/confirm').send({ supersedes: ['h1', 'h2'], rationale: 'newer value' });

  assert.equal(res.status, 200);
  assert.equal(res.body.hypothesis.status, 'confirmed');
  assert.deepEqual(res.body.superseded, ['h1']); // self is ignored
  const supersedeCall = cognition.calls.find((c) => c[0] === 'supersede');
  assert.equal(supersedeCall[1], 'h1');
  assert.equal(supersedeCall[2].supersededById, 'h2');
  // confirmed + the superseded old record are both mirrored
  assert.equal(mirrored.length, 2);
});

test('POST confirm refuses a macro statement without a rationale (server-side friction)', async () => {
  const cognition = fakeCognition();
  const res = await request(appWith({ cognition }))
    .post('/cognition/hypotheses/h2/confirm').send({ supersedes: [] });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /rationale/);
  assert.ok(!cognition.calls.some((c) => c[0] === 'confirm'));
});

test('POST confirm passes a human nuanced statement through', async () => {
  const cognition = fakeCognition();
  const res = await request(appWith({ cognition }))
    .post('/cognition/hypotheses/h2/confirm').send({ rationale: 'nuanced', statement: 'only late at night' });

  assert.equal(res.status, 200);
  const confirmCall = cognition.calls.find((c) => c[0] === 'confirm');
  assert.equal(confirmCall[2].statement, 'only late at night');
});

test('POST test opens active testing', async () => {
  const cognition = fakeCognition();
  const res = await request(appWith({ cognition })).post('/cognition/hypotheses/h1/test');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'testing');
});
