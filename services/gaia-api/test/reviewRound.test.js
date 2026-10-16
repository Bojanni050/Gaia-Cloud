'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { createReviewRound, isReviewEligible } = require('../src/reviewRound');
const { createCognitionRouter } = require('../src/cognitionRoutes');

let seq = 0;
function rec(overrides = {}) {
  seq += 1;
  return {
    id: `h${seq}`,
    kind: 'hypothesis',
    status: 'testing',
    scope: 'macro',
    confidence: 0.8,
    counter_hypothesis: null,
    updated_at: `2026-10-16T10:00:0${seq % 10}Z`,
    ...overrides,
  };
}

// --- eligibility ------------------------------------------------------------

test('eligible: a macro statement at or above the threshold', () => {
  assert.equal(isReviewEligible(rec({ scope: 'macro', confidence: 0.75 })), true);
  assert.equal(isReviewEligible(rec({ scope: 'macro', confidence: 0.9 })), true);
});

test('not eligible: below the threshold, however weighty', () => {
  assert.equal(isReviewEligible(rec({ scope: 'macro', confidence: 0.74 })), false);
  assert.equal(isReviewEligible(rec({ scope: 'micro', confidence: 0.6, counter_hypothesis: 'the opposite' })), false);
});

test('not eligible: a micro statement without a counter-hypothesis never reaches the person', () => {
  assert.equal(isReviewEligible(rec({ scope: 'micro', confidence: 0.9 })), false);
  assert.equal(isReviewEligible(rec({ scope: 'micro', confidence: 0.9, counter_hypothesis: '   ' })), false);
});

test('eligible: a micro statement that carries a counter-hypothesis', () => {
  assert.equal(isReviewEligible(rec({ scope: 'micro', confidence: 0.8, counter_hypothesis: 'the opposite reading' })), true);
});

test('an unclassified scope is macro (the safe default)', () => {
  assert.equal(isReviewEligible(rec({ scope: undefined, confidence: 0.8 })), true);
});

test('an open question is always eligible — it needs an answer, not confidence', () => {
  assert.equal(isReviewEligible(rec({ kind: 'open_question', scope: 'micro', confidence: 0 })), true);
});

test('a settled statement is never eligible', () => {
  assert.equal(isReviewEligible(rec({ status: 'confirmed' })), false);
  assert.equal(isReviewEligible(rec({ status: 'rejected' })), false);
});

// --- the round --------------------------------------------------------------

const inRound = (list) => list.filter((r) => r.in_round).map((r) => r.id);

test('a round holds at most `size` statements — the most confident ones', () => {
  const round = createReviewRound({ size: 3 });
  const list = [0.76, 0.9, 0.8, 0.95, 0.85].map((confidence) => rec({ confidence }));
  const out = round.apply(list);
  // The three most confident (0.95, 0.9, 0.85), whatever order the list came in.
  assert.deepEqual(inRound(out).sort(), [list[3].id, list[1].id, list[4].id].sort());
  // The others are eligible but wait for a later round.
  assert.equal(out.filter((r) => r.review_eligible && !r.in_round).length, 2);
});

test('settled statements pass through untouched', () => {
  const round = createReviewRound();
  const confirmed = rec({ status: 'confirmed' });
  const [out] = round.apply([confirmed]);
  assert.deepEqual(out, confirmed);
});

test('the round is fixed: a new, more confident statement does not jump in', () => {
  const round = createReviewRound({ size: 2 });
  const a = rec({ confidence: 0.8 });
  const b = rec({ confidence: 0.78 });
  round.apply([a, b]);
  const late = rec({ confidence: 0.99 });
  const out = round.apply([a, b, late]);
  assert.deepEqual(inRound(out).sort(), [a.id, b.id].sort());
  assert.equal(out.find((r) => r.id === late.id).in_round, false);
});

test('the next round starts only once every statement in the round is dealt with', () => {
  const round = createReviewRound({ size: 2 });
  const a = rec({ confidence: 0.9 });
  const b = rec({ confidence: 0.85 });
  const c = rec({ confidence: 0.8 });
  round.apply([a, b, c]);

  // a is confirmed; b is still waiting -> c must not enter yet.
  let out = round.apply([{ ...a, status: 'confirmed' }, b, c]);
  assert.deepEqual(inRound(out), [b.id]);

  // b is rejected too -> the round is empty -> c is next.
  out = round.apply([{ ...a, status: 'confirmed' }, { ...b, status: 'rejected' }, c]);
  assert.deepEqual(inRound(out), [c.id]);
});

test('"Test" defers a statement: it leaves the round and stays out until its record changes', () => {
  const round = createReviewRound({ size: 1 });
  const a = rec({ confidence: 0.9, status: 'proposed' });
  const b = rec({ confidence: 0.8 });
  round.apply([a, b]);

  // The person pressed Test on a: still under review, but touched.
  const aTested = { ...a, status: 'testing', updated_at: '2026-10-16T11:00:00Z' };
  let out = round.apply([aTested, b]);
  assert.deepEqual(inRound(out), [b.id]); // a did NOT come straight back

  // b dealt with; a is still deferred, so the round is empty rather than a again.
  out = round.apply([aTested, { ...b, status: 'confirmed' }]);
  assert.deepEqual(inRound(out), []);

  // New evidence changes a's record -> it is a candidate again.
  out = round.apply([{ ...aTested, updated_at: '2026-10-16T12:00:00Z' }, { ...b, status: 'confirmed' }]);
  assert.deepEqual(inRound(out), [a.id]);
});

test('a statement that disappears from the list leaves the round', () => {
  const round = createReviewRound({ size: 2 });
  const a = rec({ confidence: 0.9 });
  const b = rec({ confidence: 0.8 });
  round.apply([a, b]);
  const out = round.apply([b]);
  assert.deepEqual(inRound(out), [b.id]);
});

// --- the route --------------------------------------------------------------

function appWith(records) {
  const calls = [];
  const cognition = { listHypotheses: async (q) => { calls.push(q); return records; } };
  const app = express();
  app.use(express.json());
  app.use('/cognition', createCognitionRouter({ cognition, reviewRound: createReviewRound({ size: 1 }) }));
  return { app, calls };
}

test('GET /cognition/hypotheses marks eligibility and the round', async () => {
  const strong = rec({ confidence: 0.9 });
  const soft = rec({ scope: 'micro', confidence: 0.9 });
  const done = rec({ status: 'confirmed' });
  const { app } = appWith([strong, soft, done]);
  const res = await request(app).get('/cognition/hypotheses');
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.body.hypotheses.map((h) => [h.id, h]));
  assert.equal(byId[strong.id].in_round, true);
  assert.equal(byId[soft.id].review_eligible, false);
  assert.equal(byId[soft.id].in_round, false);
  assert.equal('in_round' in byId[done.id], false);
});

test('GET with a status filter is served as it is — a partial list never starts a round', async () => {
  const strong = rec({ confidence: 0.9 });
  const { app, calls } = appWith([strong]);
  const res = await request(app).get('/cognition/hypotheses?status=confirmed');
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], { status: 'confirmed' });
  assert.equal('in_round' in res.body.hypotheses[0], false);
});
