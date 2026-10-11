'use strict';

/**
 * Research job store — durability and the status queries the poll endpoint
 * depends on. A lost job is lost research, so the store is the part that must
 * survive a restart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createResearchJobStore, MAX_JOBS } = require('../src/researchJobStore');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-research-jobs-'));
  return { dir, store: createResearchJobStore({ jobsDir: dir }) };
}

test('create/get: a new job starts running and is durable across a restart', () => {
  const { dir, store } = tempStore();
  const job = store.create({ conversationId: 'conv-1', skillId: 'grounded-citations', question: 'Wat kost X?', runId: 'run_1' });

  assert.equal(job.status, 'running');
  assert.equal(job.deliveredAt, null);
  assert.ok(job.id.startsWith('rj_'));

  // A fresh store over the same directory sees it — this is the restart case.
  const reopened = createResearchJobStore({ jobsDir: dir });
  assert.equal(reopened.get(job.id).runId, 'run_1');
  assert.equal(reopened.get(job.id).question, 'Wat kost X?');
});

test('update: a terminal status is recorded, and unknown ids return null', () => {
  const { store } = tempStore();
  const job = store.create({ skillId: 'grounded-citations', question: 'q', runId: 'run_1' });

  const updated = store.update(job.id, { status: 'done', resultText: 'bevindingen' });
  assert.equal(updated.status, 'done');
  assert.equal(updated.resultText, 'bevindingen');
  assert.ok(updated.updatedAt >= job.updatedAt);
  assert.equal(store.update('rj_nope', { status: 'done' }), null);
});

test('listRunning / listUndelivered split by status and acknowledgement', () => {
  const { store } = tempStore();
  const running = store.create({ skillId: 'grounded-citations', question: 'a', runId: 'run_1' });
  const done = store.create({ skillId: 'grounded-citations', question: 'b', runId: 'run_2' });
  const failed = store.create({ skillId: 'grounded-citations', question: 'c', runId: 'run_3' });
  store.update(done.id, { status: 'done', resultText: 'x' });
  store.update(failed.id, { status: 'failed', error: 'timeout' });

  assert.deepEqual(store.listRunning().map((j) => j.id), [running.id]);
  assert.deepEqual(store.listUndelivered().map((j) => j.id).sort(), [done.id, failed.id].sort());

  store.markDelivered(done.id);
  assert.deepEqual(store.listUndelivered().map((j) => j.id), [failed.id]);
  // A delivered job is still readable — delivery is not deletion.
  assert.equal(store.get(done.id).status, 'done');
});

test('the store is bounded: the oldest jobs fall off', () => {
  const { store } = tempStore();
  for (let i = 0; i < MAX_JOBS + 5; i += 1) {
    store.create({ skillId: 'grounded-citations', question: `q${i}`, runId: `run_${i}` });
  }
  const jobs = store.list();
  assert.equal(jobs.length, MAX_JOBS);
  assert.equal(jobs[jobs.length - 1].question, `q${MAX_JOBS + 4}`);
});

test('a corrupt store file reads as no jobs instead of throwing', () => {
  const { dir, store } = tempStore();
  store.create({ skillId: 'grounded-citations', question: 'q', runId: 'run_1' });
  fs.writeFileSync(path.join(dir, 'research-jobs.json'), '{not json', 'utf-8');

  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.listRunning(), []);
});
