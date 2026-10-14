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
    reopenHypothesis: async (id, o) => { calls.push(['reopen', id, o]); return { id, status: 'testing', rejection_reason: null }; },
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

test('POST confirm on an already confirmed statement answers with it, not with a transition error', async () => {
  const cognition = fakeCognition();
  const mirrored = [];
  cognition.getHypothesis = async (id) => { cognition.calls.push(['get', id]); return { id, status: 'confirmed', scope: 'macro', statement: 'settled' }; };

  const res = await request(appWith({ cognition, sync: { syncHypothesis: async (r) => mirrored.push(r) } }))
    .post('/cognition/hypotheses/h2/confirm').send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.hypothesis.status, 'confirmed');
  assert.deepEqual(res.body.superseded, []);
  assert.ok(!cognition.calls.some((c) => c[0] === 'confirm'));
  assert.equal(mirrored.length, 0);
});

test('POST reopen refuses a missing reason (human action must state why)', async () => {
  const cognition = fakeCognition();
  const res = await request(appWith({ cognition })).post('/cognition/hypotheses/h1/reopen').send({});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /reason/);
  assert.ok(!cognition.calls.some((c) => c[0] === 'reopen'));
});

test('POST reopen lifts the quarantine and mirrors the record', async () => {
  const cognition = fakeCognition();
  const mirrored = [];
  const res = await request(appWith({ cognition, sync: { syncHypothesis: async (r) => mirrored.push(r) } }))
    .post('/cognition/hypotheses/h1/reopen').send({ reason: 'the disproof was retracted' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'testing');
  const reopenCall = cognition.calls.find((c) => c[0] === 'reopen');
  assert.equal(reopenCall[2].reason, 'the disproof was retracted');
  assert.equal(mirrored.length, 1);
});

test('POST test opens active testing', async () => {
  const cognition = fakeCognition();
  const res = await request(appWith({ cognition })).post('/cognition/hypotheses/h1/test');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'testing');
});

test('GET /cognition/hypotheses expands a relationship hypothesis id into its statement', async () => {
  const cognition = fakeCognition();
  cognition.listHypotheses = async () => ([
    { id: 'r1', kind: 'relationship', status: 'proposed', statement: 'observation:the user linked tracking to patterns. supports hypothesis:hyp-1' },
    { id: 'h1', kind: 'hypothesis', status: 'proposed', statement: 'Concurrent cancellation causes the streaming race.' },
  ]);
  cognition.getHypothesis = async (id) => {
    assert.equal(id, 'hyp-1');
    return { id, statement: 'Concurrent cancellation causes the streaming race.' };
  };

  const res = await request(appWith({ cognition })).get('/cognition/hypotheses');
  assert.equal(res.status, 200);
  const rel = res.body.hypotheses.find((h) => h.id === 'r1');
  assert.equal(
    rel.statement,
    'observation:the user linked tracking to patterns. supports hypothesis:Concurrent cancellation causes the streaming race.'
  );
  // the untouched hypothesis record is returned as it was
  assert.equal(res.body.hypotheses.find((h) => h.id === 'h1').statement, 'Concurrent cancellation causes the streaming race.');
});

test('an unresolved relationship id stays as the bare id, never a broken half', async () => {
  const cognition = fakeCognition();
  cognition.listHypotheses = async () => ([
    { id: 'r2', kind: 'relationship', status: 'proposed', statement: 'observation:x weakens hypothesis:missing' },
  ]);
  cognition.getHypothesis = async () => { throw new Error('cognition get 404'); };

  const res = await request(appWith({ cognition })).get('/cognition/hypotheses');
  assert.equal(res.body.hypotheses[0].statement, 'observation:x weakens hypothesis:missing');
});

// === v1.2 — the shape an open question is answered with ====================

test('GET sends the shape along, and reads it off a question written before it existed', async () => {
  const cognition = fakeCognition();
  cognition.listHypotheses = async () => ([
    { id: 'q1', kind: 'open_question', status: 'proposed', statement: 'Zal Bo het bestand gebruiken (openen/inhouden)?' },
    { id: 'q2', kind: 'open_question', status: 'proposed', statement: 'Klopt dit verband?', question_shape: 'yes_no', question_options: [] },
    { id: 'q3', kind: 'open_question', status: 'proposed', statement: 'Is dit nog open?', question_shape: 'open' },
  ]);

  const res = await request(appWith({ cognition })).get('/cognition/hypotheses');
  assert.equal(res.status, 200);
  // No stored shape (a record written before v1.2): derived from the statement.
  assert.equal(res.body.hypotheses.find((h) => h.id === 'q1').question_shape, 'choice');
  assert.deepEqual(res.body.hypotheses.find((h) => h.id === 'q1').question_options, ['openen', 'inhouden']);
  // A stored shape is never overwritten.
  assert.equal(res.body.hypotheses.find((h) => h.id === 'q3').question_shape, 'open');
});

test('GET leaves an answered question out of the review list', async () => {
  const cognition = fakeCognition();
  cognition.listHypotheses = async () => ([
    { id: 'q1', kind: 'open_question', status: 'proposed', statement: 'Is dit nog open?' },
    { id: 'q2', kind: 'open_question', status: 'proposed', statement: 'Is dat nog open?', answer: 'ja', answered_at: '2026-10-14T09:00:00Z' },
  ]);

  const res = await request(appWith({ cognition })).get('/cognition/hypotheses');
  assert.deepEqual(res.body.hypotheses.map((h) => h.id), ['q1']);
});

test('POST answer records the human answer and does not mirror it', async () => {
  const cognition = fakeCognition();
  cognition.answerHypothesis = async (id, o) => {
    cognition.calls.push(['answer', id, o]);
    return { id, kind: 'open_question', status: 'proposed', answer: o.answer, answered_at: '2026-10-14T09:00:00Z' };
  };
  const mirrored = [];
  const res = await request(appWith({ cognition, sync: { syncHypothesis: async (r) => mirrored.push(r) } }))
    .post('/cognition/hypotheses/q1/answer').send({ answer: 'openen' });

  assert.equal(res.status, 200);
  assert.equal(res.body.answer, 'openen');
  assert.equal(cognition.calls.at(-1)[2].answer, 'openen');
  // Answering is not a confirmation: the statement keeps its status, and the
  // person's own answer is not quietly turned into a mirrored fact.
  assert.equal(res.body.status, 'proposed');
  assert.equal(mirrored.length, 0);
});

test('POST answer refuses an empty answer', async () => {
  const cognition = fakeCognition();
  cognition.answerHypothesis = async () => { throw new Error('must not be called'); };

  for (const body of [{}, { answer: '   ' }]) {
    const res = await request(appWith({ cognition })).post('/cognition/hypotheses/q1/answer').send(body);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /answer is required/);
  }
});
