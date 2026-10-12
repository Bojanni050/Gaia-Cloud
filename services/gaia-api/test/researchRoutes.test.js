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

test('a job waiting on a person carries the question and its choices', async () => {
  const { app, store } = buildApp();
  const job = store.create({ conversationId: 'c1', skillId: 'grounded-citations', question: 'a', runId: 'run_1' });
  store.update(job.id, {
    status: 'awaiting_approval',
    approval: { command: 'python3 sources.py', description: 'schrijft weg', choices: ['once', 'deny'] },
  });

  const res = await request(app).get('/research/jobs');

  assert.deepEqual(res.body.finished[0].approval, {
    command: 'python3 sources.py',
    description: 'schrijft weg',
    choices: ['once', 'deny'],
  });
});

test('a running job carries no approval field', async () => {
  const { app, store } = buildApp();
  store.create({ conversationId: 'c1', skillId: 'grounded-citations', question: 'a', runId: 'run_1' });

  const res = await request(app).get('/research/jobs');

  assert.equal(res.body.running[0].approval, null);
});

test('POST /research/jobs/:id/approval forwards the decision and maps failures', async () => {
  const { app, store } = buildApp();
  const job = store.create({ conversationId: 'c1', skillId: 'grounded-citations', question: 'a', runId: 'run_1' });
  store.update(job.id, { status: 'awaiting_approval', approval: { command: 'x', description: '', choices: ['once', 'deny'] } });

  const seen = [];
  const app2 = express();
  app2.use(express.json());
  app2.use('/research', createResearchRouter({
    store,
    auth,
    answerApproval: async (jobId, choice) => {
      seen.push({ jobId, choice });
      if (choice === 'deny') return { ok: false, status: 409, error: 'approval_not_pending' };
      return { ok: true, status: 204, error: null };
    },
  }));

  assert.equal((await request(app2).post(`/research/jobs/${job.id}/approval`).send({ choice: 'once' })).status, 204);
  assert.deepEqual(seen, [{ jobId: job.id, choice: 'once' }]);

  const refused = await request(app2).post(`/research/jobs/${job.id}/approval`).send({ choice: 'deny' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'approval_not_pending');
});

test('POST /research/jobs/:id/approval says so when approvals are not wired', async () => {
  const { app, store } = buildApp();
  const job = store.create({ conversationId: 'c1', skillId: 'grounded-citations', question: 'a', runId: 'run_1' });

  const res = await request(app).post(`/research/jobs/${job.id}/approval`).send({ choice: 'once' });

  assert.equal(res.status, 503);
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
