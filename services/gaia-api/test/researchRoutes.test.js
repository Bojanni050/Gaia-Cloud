'use strict';

/**
 * The research poll endpoint — how a client finds out that something it was
 * not waiting for has finished, and acknowledges it exactly once.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createResearchJobStore } = require('../src/researchJobStore');
const { createResearchRouter } = require('../src/researchRoutes');

const auth = (req, res, next) => next();

function buildApp() {
  const store = createResearchJobStore({
    jobsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-research-routes-')),
  });
  const app = express();
  app.use('/research', createResearchRouter({ store, auth }));
  return { app, store };
}

test('GET /research/jobs separates running from finished-but-unseen', async () => {
  const { app, store } = buildApp();
  const running = store.create({ conversationId: 'c1', skillId: 'grounded-citations', question: 'a', runId: 'run_1' });
  const done = store.create({ conversationId: 'c1', skillId: 'grounded-citations', question: 'b', runId: 'run_2' });
  store.update(done.id, { status: 'done', resultText: 'bevindingen', messageSaved: true });

  const res = await request(app).get('/research/jobs');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.running.map((j) => j.id), [running.id]);
  assert.deepEqual(res.body.finished.map((j) => j.id), [done.id]);
  // Metadata only: the findings themselves live in the conversation.
  assert.equal(res.body.finished[0].resultText, undefined);
  assert.equal(res.body.finished[0].messageSaved, true);
  assert.equal(res.body.finished[0].conversationId, 'c1');
});

test('a document travels as a reference, not as bytes', async () => {
  const { app, store } = buildApp();
  const job = store.create({ conversationId: 'c1', skillId: 'grounded-citations', question: 'a', runId: 'run_1' });
  store.update(job.id, { status: 'done', file: { fileId: 'file_7', filename: 'rapport.pdf', mimeType: 'application/pdf', bytes: 10 } });

  const res = await request(app).get('/research/jobs');

  assert.deepEqual(res.body.finished[0].file, {
    id: 'file_7',
    filename: 'rapport.pdf',
    mimeType: 'application/pdf',
  });
});

test('ack marks a job seen exactly once, and 404s on an unknown id', async () => {
  const { app, store } = buildApp();
  const job = store.create({ conversationId: 'c1', skillId: 'grounded-citations', question: 'a', runId: 'run_1' });
  store.update(job.id, { status: 'done' });

  assert.equal((await request(app).post(`/research/jobs/${job.id}/ack`)).status, 204);
  assert.deepEqual((await request(app).get('/research/jobs')).body.finished, []);
  assert.equal((await request(app).post('/research/jobs/rj_nope/ack')).status, 404);
});
