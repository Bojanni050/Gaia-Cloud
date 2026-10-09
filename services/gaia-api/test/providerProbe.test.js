'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { probeChatCompletion } = require('../src/providerProbe');

function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

test('probeChatCompletion reports ok and latency on a 200', async () => {
  let calledUrl = null;
  await withFetch(async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) };
  }, async () => {
    const r = await probeChatCompletion({ baseUrl: 'https://api.example.com/v1/', model: 'm1', apiKey: 'k' });
    assert.equal(r.ok, true);
    assert.equal(r.sample, 'pong');
    assert.equal(typeof r.latencyMs, 'number');
    assert.equal(calledUrl, 'https://api.example.com/v1/chat/completions');
  });
});

test('probeChatCompletion surfaces the provider error on a non-200', async () => {
  await withFetch(async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'bad key' } }) }), async () => {
    const r = await probeChatCompletion({ baseUrl: 'https://api.example.com/v1', model: 'm1', apiKey: 'k' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.match(r.error, /401/);
    assert.match(r.error, /bad key/);
  });
});

test('probeChatCompletion reports a timeout instead of throwing', async () => {
  await withFetch(async () => {
    const e = new Error('aborted');
    e.name = 'TimeoutError';
    throw e;
  }, async () => {
    const r = await probeChatCompletion({ baseUrl: 'https://api.example.com/v1', model: 'm1', timeoutMs: 1000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
  });
});
