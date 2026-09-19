'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReasoningModelClient, readReasoningTimeoutMs } = require('../src/logos/reasoningModelClient');

const BASE = { baseUrl: 'http://x/v1', model: 'm' };

/** Collects the llm.call lines the client logs. */
function collectLogs() {
  const lines = [];
  return { lines, logger: (line) => lines.push(JSON.parse(line)) };
}

test('readReasoningTimeoutMs: 20s default, REASONIQ_MODEL_TIMEOUT_MS overrides, junk is ignored', () => {
  assert.equal(readReasoningTimeoutMs({}), 20000);
  assert.equal(readReasoningTimeoutMs({ REASONIQ_MODEL_TIMEOUT_MS: '5000' }), 5000);
  assert.equal(readReasoningTimeoutMs({ REASONIQ_MODEL_TIMEOUT_MS: 'abc' }), 20000);
  assert.equal(readReasoningTimeoutMs({ REASONIQ_MODEL_TIMEOUT_MS: '0' }), 20000);
  assert.equal(readReasoningTimeoutMs({ REASONIQ_MODEL_TIMEOUT_MS: '-3' }), 20000);
});

test('chat: a call that never answers is cut off at timeoutMs and logged as timeout', async () => {
  const { lines, logger } = collectLogs();
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const client = createReasoningModelClient({ ...BASE, fetchImpl, timeoutMs: 30 });
  const startedAt = Date.now();
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }], { logger }), /unreachable/);
  assert.ok(Date.now() - startedAt < 2000, 'must not wait anywhere near the 60s client default');
  const call = lines.find((l) => l.kind === 'llm.call');
  assert.equal(call.ok, false);
  assert.equal(call.errorMessage, 'timeout');
});

test('chat: headers arrive but the body stalls → also logged as timeout, not "unreadable response"', async () => {
  const { lines, logger } = collectLogs();
  const fetchImpl = (_url, { signal }) => Promise.resolve({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
  });
  const client = createReasoningModelClient({ ...BASE, fetchImpl, timeoutMs: 30 });
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }], { logger }), /unreadable response/);
  const call = lines.find((l) => l.kind === 'llm.call');
  assert.equal(call.errorMessage, 'timeout');
});

test('chat: a genuinely malformed body is still logged as unreadable response', async () => {
  const { lines, logger } = collectLogs();
  const fetchImpl = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } });
  const client = createReasoningModelClient({ ...BASE, fetchImpl });
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }], { logger }), /unreadable response/);
  assert.equal(lines.find((l) => l.kind === 'llm.call').errorMessage, 'unreadable response');
});

test('chat: a normal completion still works with the shorter timeout', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) });
  const client = createReasoningModelClient({ ...BASE, fetchImpl, timeoutMs: 20000 });
  assert.equal(await client.chat([{ role: 'user', content: 'hi' }]), '{"ok":true}');
});
