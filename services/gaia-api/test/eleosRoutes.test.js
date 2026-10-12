'use strict';

/**
 * The Eleos poll endpoint — how a client learns that Gaia has started a
 * conversation the person did not ask for, and acknowledges it exactly once.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createEleosIntentStore } = require('../src/eleosIntentStore');
const { createEleosRouter } = require('../src/eleosRoutes');

const auth = (req, res, next) => next();

function buildApp() {
  const store = createEleosIntentStore({
    intentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-eleos-routes-')),
  });
  const app = express();
  app.use(express.json());
  app.use('/eleos', createEleosRouter({ store, auth }));
  return { app, store };
}

test('GET /eleos/checkins separates pending from delivered-and-unseen', async () => {
  const { app, store } = buildApp();
  const pending = store.create({ conversationId: 'c1', kind: 'sadness', summary: 'a', dueAt: '2026-12-01T00:00:00Z' });
  const done = store.create({ conversationId: 'c2', kind: 'worry', summary: 'b', dueAt: '2026-10-01T00:00:00Z' });
  store.markDelivered(done.id, { deliveredConversationId: `eleos-${done.id}` });

  const res = await request(app).get('/eleos/checkins');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.pending.map((l) => l.id), [pending.id]);
  assert.deepEqual(res.body.delivered.map((l) => l.id), [done.id]);
  assert.equal(res.body.delivered[0].deliveredConversationId, `eleos-${done.id}`);
  // Metadata only — the check-in text lives in the new conversation.
  assert.equal(res.body.delivered[0].content, undefined);
});

test('POST /eleos/checkins/:id/ack marks a delivered check-in seen (once)', async () => {
  const { app, store } = buildApp();
  const loop = store.create({ conversationId: 'c1', summary: 'x', dueAt: '2026-10-01T00:00:00Z' });
  store.markDelivered(loop.id);

  const first = await request(app).post(`/eleos/checkins/${loop.id}/ack`);
  assert.equal(first.status, 204);

  const res = await request(app).get('/eleos/checkins');
  assert.deepEqual(res.body.delivered, []);
});

test('POST /eleos/checkins/:id/ack is 404 for an unknown check-in', async () => {
  const { app } = buildApp();
  const res = await request(app).post('/eleos/checkins/nope/ack');
  assert.equal(res.status, 404);
});
