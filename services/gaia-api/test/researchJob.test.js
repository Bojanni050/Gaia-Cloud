'use strict';

/**
 * The research job lifecycle: submit → poll → deliver. The pieces that matter
 * are the ones that would otherwise fail silently: a submit that cannot reach
 * Hermes, a poll that cannot reach Hermes, and a document that has to travel
 * from the shared volume into Gaia's own library.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createResearchJobStore } = require('../src/researchJobStore');
const {
  startResearchJob,
  pollResearchJobs,
  pickOutboxFile,
  importOutboxFile,
  renderResearchMessage,
  saveResearchMessage,
} = require('../src/researchJob');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setup({ runState, outbox = false } = {}) {
  const jobsDir = tempDir('gaia-rj-');
  const store = createResearchJobStore({ jobsDir });
  const submitted = [];
  const hermes = {
    submitRun: async ({ input }) => { submitted.push(input); return { runId: 'run_1', status: 'started' }; },
    getRun: async () => runState,
  };
  const outboxDir = outbox ? fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-outbox-')) : undefined;
  return { store, hermes, submitted, outboxDir };
}

// --- submit --------------------------------------------------------------------

test('startResearchJob submits a run that names the skill and records the job', async () => {
  const { store, hermes, submitted } = setup();

  const job = await startResearchJob({
    question: 'Wat kost Tailscale?',
    skillId: 'grounded-citations',
    conversationId: 'conv-1',
    hermes,
    store,
  });

  assert.equal(submitted.length, 1);
  assert.match(submitted[0], /`grounded-citations`/);
  assert.match(submitted[0], /Wat kost Tailscale\?/);
  assert.equal(job.runId, 'run_1');
  assert.equal(job.status, 'running');
  assert.equal(job.conversationId, 'conv-1');
  assert.equal(store.listRunning().length, 1);
});

test('startResearchJob records nothing when Hermes gives no run id, or cannot be reached', async () => {
  const noId = {
    submitRun: async () => ({ runId: null, status: null }),
    getRun: async () => null,
  };
  let { store } = setup();
  assert.equal(await startResearchJob({ question: 'q', skillId: 's', conversationId: 'conv-1', hermes: noId, store }), null);
  assert.equal(store.list().length, 0);

  const throwing = { submitRun: async () => { throw new Error('hermes unreachable'); }, getRun: async () => null };
  ({ store } = setup());
  assert.equal(await startResearchJob({ question: 'q', skillId: 's', conversationId: 'conv-1', hermes: throwing, store }), null);
  assert.equal(store.list().length, 0);
});

test('startResearchJob refuses a job without a conversation, and never submits the run', async () => {
  const { store, hermes, submitted } = setup();

  const job = await startResearchJob({ question: 'q', skillId: 'grounded-citations', hermes, store });
  assert.equal(job, null);
  assert.equal(submitted.length, 0, 'the run must not be submitted at all');
  assert.equal(store.list().length, 0);
});

// --- poll ----------------------------------------------------------------------

test('a completed run closes the job with its findings', async () => {
  const { store, hermes } = setup({ runState: { status: 'completed', output: 'Bevindingen met bronnen.', error: null } });
  const job = await startResearchJob({ question: 'q', skillId: 'grounded-citations', conversationId: 'conv-1', hermes, store });

  const changed = await pollResearchJobs({ hermes, store });

  assert.deepEqual(changed.map((j) => j.id), [job.id]);
  const stored = store.get(job.id);
  assert.equal(stored.status, 'done');
  assert.equal(stored.resultText, 'Bevindingen met bronnen.');
});

test('a failed run closes the job with the reason', async () => {
  const { store, hermes } = setup({ runState: { status: 'failed', output: null, error: 'provider exploded' } });
  const job = await startResearchJob({ question: 'q', skillId: 'grounded-citations', conversationId: 'conv-1', hermes, store });

  await pollResearchJobs({ hermes, store });

  const stored = store.get(job.id);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.error, 'provider exploded');
});

test('a run that is still going, or an unreachable Hermes, leaves the job running for the next cycle', async () => {
  const { store, hermes } = setup({ runState: { status: 'running', output: null, error: null } });
  const job = await startResearchJob({ question: 'q', skillId: 'grounded-citations', conversationId: 'conv-1', hermes, store });
  await pollResearchJobs({ hermes, store });
  assert.equal(store.get(job.id).status, 'running');

  const unreachable = { getRun: async () => { throw new Error('hermes unreachable'); } };
  await pollResearchJobs({ hermes: unreachable, store });
  assert.equal(store.get(job.id).status, 'running');
  assert.equal(job.id, store.listRunning()[0].id);
});

test('pollResearchJobs hands finished jobs to onCompleted', async () => {
  const { store, hermes } = setup({ runState: { status: 'completed', output: 'klaar', error: null } });
  await startResearchJob({ question: 'q', skillId: 'grounded-citations', conversationId: 'conv-1', hermes, store });

  const seen = [];
  await pollResearchJobs({ hermes, store, onCompleted: (job) => seen.push(job.status) });

  assert.deepEqual(seen, ['done']);
});

// --- the document in the shared volume ----------------------------------------

test('pickOutboxFile finds the newest file and ignores imported/ and subdirectories', () => {
  const dir = tempDir('gaia-outbox-');
  fs.mkdirSync(path.join(dir, 'imported'));
  fs.writeFileSync(path.join(dir, 'old.pdf'), 'old');
  fs.writeFileSync(path.join(dir, 'imported', 'already.pdf'), 'x');
  const fresh = path.join(dir, 'report.pdf');
  fs.writeFileSync(fresh, 'pdf-bytes');
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, 'old.pdf'), past, past);

  assert.equal(pickOutboxFile(dir, new Date().toISOString()), fresh);
  assert.equal(pickOutboxFile(path.join(dir, 'nope'), new Date().toISOString()), null);
});

test('importOutboxFile saves the document into the library and archives it', () => {
  const dir = tempDir('gaia-outbox-');
  const file = path.join(dir, 'rapport.pdf');
  fs.writeFileSync(file, 'pdf-bytes');
  const saved = [];
  const library = {
    saveFile: (buffer, meta) => { saved.push({ buffer, meta }); return { id: 'file_1' }; },
  };

  const imported = importOutboxFile(file, { library });

  assert.equal(imported.fileId, 'file_1');
  assert.equal(imported.filename, 'rapport.pdf');
  assert.equal(imported.mimeType, 'application/pdf');
  assert.equal(saved[0].buffer.toString(), 'pdf-bytes');
  // Moved aside: the next poll must not import it a second time.
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.join(dir, 'imported')).length, 1);
});

test('an unimportable document leaves the file in place for the next poll', () => {
  const dir = tempDir('gaia-outbox-');
  const file = path.join(dir, 'rapport.pdf');
  fs.writeFileSync(file, 'pdf-bytes');
  const library = { saveFile: () => { throw new Error('disk full'); } };

  assert.equal(importOutboxFile(file, { library }), null);
  assert.equal(fs.existsSync(file), true);
});

test('a completed run imports the document it left behind', async () => {
  const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-outbox-'));
  const { store, hermes } = setup({ runState: { status: 'completed', output: 'Zie bijgaand.', error: null } });
  const job = await startResearchJob({ question: 'q', skillId: 'grounded-citations', conversationId: 'conv-1', hermes, store });
  fs.writeFileSync(path.join(outboxDir, 'rapport.pdf'), 'pdf-bytes');
  const library = { saveFile: () => ({ id: 'file_9' }) };

  await pollResearchJobs({ hermes, store, library, outboxDir });

  const stored = store.get(job.id);
  assert.equal(stored.status, 'done');
  assert.equal(stored.file.fileId, 'file_9');
  assert.equal(stored.file.filename, 'rapport.pdf');
});

// --- the message ----------------------------------------------------------------

test('renderResearchMessage reports the findings, and the document when there is one', () => {
  const done = renderResearchMessage({
    status: 'done', skillId: 'grounded-citations', resultText: 'Bronnen: a, b',
    file: { filename: 'rapport.pdf', bytes: 2048 },
  });
  assert.match(done, /Onderzoek afgerond \(skill grounded-citations\)/);
  assert.match(done, /Bronnen: a, b/);
  assert.match(done, /rapport\.pdf/);

  const failed = renderResearchMessage({ status: 'failed', skillId: 'grounded-citations', error: 'timeout' });
  assert.match(failed, /niet gelukt: timeout/);
});

test('saveResearchMessage appends Gaia\'s findings to the conversation', () => {
  const conversations = { 'conv-1': { messages: [{ role: 'user', content: 'Doe research.' }] } };
  const historyStore = {
    getConversation: (id) => {
      if (!conversations[id]) throw new Error('no such conversation');
      return conversations[id];
    },
    saveConversation: (id, messages) => { conversations[id] = { messages }; },
  };
  const job = { conversationId: 'conv-1', status: 'done', skillId: 'grounded-citations', resultText: 'Bevindingen.' };

  assert.equal(saveResearchMessage({ job, historyStore }), true);
  const saved = conversations['conv-1'].messages;
  assert.equal(saved.length, 2);
  assert.equal(saved[1].role, 'assistant');
  assert.match(saved[1].content, /Bevindingen\./);

  // A job without a conversation, or an unknown one, is not an error.
  assert.equal(saveResearchMessage({ job: { ...job, conversationId: null }, historyStore }), false);
  assert.equal(saveResearchMessage({ job: { ...job, conversationId: 'conv-nope' }, historyStore }), false);
});
