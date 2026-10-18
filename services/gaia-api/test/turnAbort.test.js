'use strict';

/**
 * C2 of the background-voice work: when the client leaves mid-turn (Desktop closes the connection when the
 * user interrupts Gaia), the turn is aborted. Generation stops instead of running on for nobody, the part
 * of the reply that was already streamed is saved and marked `interrupted`, and nothing is reflected on:
 * a reply nobody finished hearing is not an experience Gaia learns from.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performStreamingTurn } = require('../src/turn');
const { streamWithFailover } = require('../src/generation/generationFailover');
const { GenerationError } = require('../src/generation/gaiaGenerator');
const { createConversationStore } = require('../src/conversationStore');
const { createApp } = require('../src/server');

const DOCUMENTS = { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' };
const SILENT_HINDSIGHT = { recall: async () => [], reflect: async () => {} };
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    written: [],
    ended: false,
    jsonBody: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    write(chunk) { this.written.push(chunk); },
    end() { this.ended = true; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; },
  };
}

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** A generator that streams one chunk and then waits, until it is aborted. */
function stallingHermes({ onSignal } = {}) {
  return {
    stream: async (messages, { onDelta, signal }) => {
      if (onSignal) onSignal(signal);
      onDelta('Er was eens een ', false);
      await new Promise((resolve, reject) => {
        if (!signal) return; // no signal: stalls forever (the test would time out, which is the point)
        signal.addEventListener('abort', () => reject(abortError()));
      });
      return 'never reached';
    },
  };
}

function recordingHistory() {
  const saved = [];
  return { saved, saveConversation: (id, messages) => saved.push({ id, messages }) };
}

// --- the turn --------------------------------------------------------------------------------------

test('an aborted turn saves the partial reply marked interrupted, writes nothing more, and reflects on nothing', async () => {
  const res = fakeRes();
  const controller = new AbortController();
  const historyStore = recordingHistory();
  let reflected = 0;
  const hindsight = { recall: async () => [], reflect: async () => { reflected += 1; } };
  let handed;

  const turn = performStreamingTurn({
    messages: [{ role: 'user', content: 'vertel me een verhaal alsjeblieft' }],
    documents: DOCUMENTS,
    hermes: stallingHermes({ onSignal: (s) => { handed = s; } }),
    hindsight,
    historyStore,
    conversationId: 'conv-abort',
    res,
    signal: controller.signal,
  });
  await flush();
  assert.ok(res.written.some((w) => w.includes('Er was eens een ')), 'the first words did stream');
  controller.abort();
  await turn;
  await flush();

  assert.equal(handed, controller.signal, 'generation was given the abort signal');
  assert.equal(historyStore.saved.length, 1);
  const stored = historyStore.saved[0];
  assert.equal(stored.id, 'conv-abort');
  assert.deepEqual(stored.messages.at(-1), { role: 'assistant', content: 'Er was eens een ', interrupted: true });
  assert.equal(stored.messages[0].content, 'vertel me een verhaal alsjeblieft');
  assert.ok(!res.written.some((w) => w.includes('[DONE]')), 'no finish frame to a connection that is gone');
  assert.ok(!res.written.some((w) => w.includes('"type":"error"')), 'no error frame either');
  assert.equal(res.ended, false);
  assert.equal(reflected, 0, 'an interrupted reply is not reflected on');
});

test('aborted before a single word: the question is kept and no assistant reply is invented', async () => {
  const res = fakeRes();
  const controller = new AbortController();
  const historyStore = recordingHistory();
  const hermes = {
    stream: async (messages, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(abortError()));
    }),
  };
  const turn = performStreamingTurn({
    messages: [{ role: 'user', content: 'dit is mijn vraag aan jou' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    historyStore,
    conversationId: 'conv-early',
    res,
    signal: controller.signal,
  });
  await flush();
  controller.abort();
  await turn;

  assert.equal(historyStore.saved.length, 1);
  assert.deepEqual(historyStore.saved[0].messages, [{ role: 'user', content: 'dit is mijn vraag aan jou' }]);
});

test('a client that left during memory recall never starts generating', async () => {
  const res = fakeRes();
  const controller = new AbortController();
  let generated = 0;
  const hindsight = {
    recall: async () => { controller.abort(); return []; },
    reflect: async () => {},
  };
  const hermes = { stream: async () => { generated += 1; return 'x'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'onthoud je wat ik je vorige week vertelde?' }],
    documents: DOCUMENTS,
    hermes,
    hindsight,
    historyStore: recordingHistory(),
    conversationId: 'conv-recall',
    res,
    signal: controller.signal,
  });
  assert.equal(generated, 0);
});

test('an aborted turn does not fail over to the backup generator', async () => {
  const res = fakeRes();
  const controller = new AbortController();
  let backupCalls = 0;
  const generator = {
    stream: async (messages, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = abortError();
        err.retryable = true;
        reject(err);
      });
    }),
  };
  const backupGenerator = { stream: async () => { backupCalls += 1; return 'backup'; } };
  const turn = performStreamingTurn({
    messages: [{ role: 'user', content: 'een heel lange vraag voor de generator' }],
    documents: DOCUMENTS,
    generator,
    backupGenerator,
    hindsight: SILENT_HINDSIGHT,
    historyStore: recordingHistory(),
    conversationId: 'conv-nofailover',
    res,
    signal: controller.signal,
  });
  await flush();
  controller.abort();
  await turn;
  assert.equal(backupCalls, 0);
});

test('a turn nobody interrupted is saved complete, without the mark, and finishes the stream', async () => {
  const res = fakeRes();
  const historyStore = recordingHistory();
  const hermes = { stream: async (m, { onDelta }) => { onDelta('Klaar.', false); return 'Klaar.'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'vertel me iets korts alsjeblieft' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    historyStore,
    conversationId: 'conv-ok',
    res,
    signal: new AbortController().signal,
  });
  await flush();
  assert.deepEqual(historyStore.saved[0].messages.at(-1), { role: 'assistant', content: 'Klaar.' });
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

test('without any signal the turn behaves exactly as before (older callers)', async () => {
  const res = fakeRes();
  const hermes = { stream: async (m, { onDelta }) => { onDelta('Hoi', false); return 'Hoi'; } };
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'zeg maar gewoon hallo tegen mij' }],
    documents: DOCUMENTS,
    hermes,
    hindsight: SILENT_HINDSIGHT,
    res,
  });
  assert.equal(res.written.at(-1), 'data: [DONE]\n\n');
});

// --- failover --------------------------------------------------------------------------------------

test('streamWithFailover: when the turn was aborted the backup is never tried', async () => {
  const controller = new AbortController();
  let backupCalls = 0;
  const primary = {
    stream: async () => {
      controller.abort();
      const err = abortError();
      err.retryable = true;
      throw err;
    },
  };
  const backup = { stream: async () => { backupCalls += 1; return 'from the backup'; } };
  await assert.rejects(
    streamWithFailover([{ role: 'user', content: 'hi' }], { primary, backup, signal: controller.signal }),
    /aborted/
  );
  assert.equal(backupCalls, 0, 'a client that left must not cost a second generation');
});

test('streamWithFailover: real failover still works when nobody aborted', async () => {
  const controller = new AbortController();
  const primary = { stream: async () => { throw new GenerationError('primary 503', { status: 503, retryable: true }); } };
  const backup = { stream: async () => 'from the backup' };
  assert.equal(
    await streamWithFailover([{ role: 'user', content: 'hi' }], { primary, backup, signal: controller.signal }),
    'from the backup'
  );
});

// --- the history store -----------------------------------------------------------------------------

function tempStore() {
  return createConversationStore({ historyDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-abort-history-')) });
}

test('saveConversation keeps interrupted: true on a cut-off reply and round-trips it', () => {
  const store = tempStore();
  store.saveConversation('c-int', [
    { role: 'user', content: 'vertel een verhaal' },
    { role: 'assistant', content: 'Er was eens', interrupted: true },
  ]);
  const { messages } = store.getConversation('c-int');
  assert.equal(messages[1].interrupted, true);
  assert.equal(messages[0].interrupted, undefined, 'only the cut-off reply carries the mark');
});

test('only an exact true is kept: a client cannot invent markers or truthy values', () => {
  const store = tempStore();
  store.saveConversation('c-fake', [
    { role: 'user', content: 'hallo', interrupted: 'yes', admin: true },
    { role: 'assistant', content: 'dag', interrupted: 1, secret: 'x' },
  ]);
  const { messages } = store.getConversation('c-fake');
  for (const m of messages) {
    assert.deepEqual(Object.keys(m).sort(), ['content', 'createdAt', 'role']);
  }
});

test('a completed reply saved later replaces the interrupted one without keeping the mark', () => {
  const store = tempStore();
  store.saveConversation('c-redo', [
    { role: 'user', content: 'vraag' },
    { role: 'assistant', content: 'half', interrupted: true },
  ]);
  store.saveConversation('c-redo', [
    { role: 'user', content: 'vraag' },
    { role: 'assistant', content: 'het hele antwoord' },
  ]);
  const { messages } = store.getConversation('c-redo');
  assert.equal(messages[1].content, 'het hele antwoord');
  assert.equal(messages[1].interrupted, undefined);
});

// --- end to end: a real client really disconnects -----------------------------------------------------

const TOKEN = 'test-token';
const NATIVE_BASE = 'http://fake-native.internal/v1';
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-api-abort-test-'));
const FOUNDATION_ARTIFACT_PATH = path.join(fixtureDir, 'foundation-artifact.json');
// The decision store would otherwise default to services/gaia-api/data/logos-decisions
// and every run of this suite would append to the checkout (18-10-2026).
const LOGOS_DECISIONS_PATH = path.join(fixtureDir, 'logos-decisions');
fs.writeFileSync(FOUNDATION_ARTIFACT_PATH, JSON.stringify({ documents: DOCUMENTS }));

test('over real HTTP: a turn that is allowed to finish is not aborted and is saved complete', async () => {
  const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-api-abort-history-'));
  let providerSignal = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    providerSignal = options.signal;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Een kort antwoord.' } }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return { ok: true, body };
  };
  const app = createApp({
    GAIA_API_TOKEN: TOKEN,
    GAIA_NATIVE_BASE_URL: NATIVE_BASE,
    GAIA_NATIVE_MODEL: 'test-model',
    HERMES_BASE_URL: 'http://fake-hermes.internal/v1',
    HERMES_MODEL: 'hermes-agent',
    FOUNDATION_ARTIFACT_PATH,
    LOGOS_DECISIONS_PATH,
    HISTORY_PATH: historyDir,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const response = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ stream: true, conversationId: 'conv-done', messages: [{ role: 'user', content: 'zeg iets kort tegen me' }] }),
    });
    await response.text();
    await new Promise((r) => setTimeout(r, 100));
    const messages = JSON.parse(fs.readFileSync(path.join(historyDir, 'conv-done', 'messages.json'), 'utf-8'));
    assert.equal(messages.at(-1).content, 'Een kort antwoord.');
    assert.equal(messages.at(-1).interrupted, undefined);
    assert.equal(providerSignal.aborted, false, 'a finished turn must not be reported as a disconnect');
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('over real HTTP, production-like (primary with tools): a client that leaves before any text aborts generation and keeps only the question', async () => {
  const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-api-abort-history-'));
  let providerSignal = null;
  let providerCalled = null;
  const called = new Promise((resolve) => { providerCalled = resolve; });
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    if (!href.startsWith(NATIVE_BASE)) throw new Error(`unreachable in this test: ${href}`);
    providerSignal = options.signal;
    providerCalled();
    // the provider is still thinking: nothing has been said yet
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => controller.error(abortError()));
        },
      }),
    };
  };
  const app = createApp({
    GAIA_API_TOKEN: TOKEN,
    GAIA_NATIVE_BASE_URL: NATIVE_BASE,
    GAIA_NATIVE_MODEL: 'test-model',
    HERMES_BASE_URL: 'http://fake-hermes.internal/v1',
    HERMES_MODEL: 'hermes-agent',
    FOUNDATION_ARTIFACT_PATH,
    LOGOS_DECISIONS_PATH,
    HISTORY_PATH: historyDir,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const clientAbort = new AbortController();
    const request = originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ stream: true, conversationId: 'conv-early-live', messages: [{ role: 'user', content: 'dit is mijn vraag, nog voor je antwoord' }] }),
      signal: clientAbort.signal,
    }).catch((e) => e);
    await called;
    clientAbort.abort(); // the user interrupted while Gaia was still thinking
    await request;

    const deadline = Date.now() + 5000;
    let saved = null;
    while (Date.now() < deadline) {
      try {
        saved = JSON.parse(fs.readFileSync(path.join(historyDir, 'conv-early-live', 'messages.json'), 'utf-8'));
        break;
      } catch (_) { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(providerSignal.aborted, 'generation was aborted, not left running for nobody');
    assert.ok(saved, 'the question was saved');
    assert.deepEqual(saved.map((m) => [m.role, m.content]), [['user', 'dit is mijn vraag, nog voor je antwoord']]);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});
