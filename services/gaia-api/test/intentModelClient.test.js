'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createIntentModelClient,
  readIntentModelConfig,
  isConfigured,
  createFromEnv,
} = require('../src/logos/intentModelClient');

// --- Configuration ----------------------------------------------------------

test('readIntentModelConfig reads from environment variables', () => {
  const config = readIntentModelConfig({
    GAIA_INTENT_BASE_URL: 'http://test:1234/v1',
    GAIA_INTENT_MODEL: 'test-intent-model',
    GAIA_INTENT_AUTH_TOKEN: 'test-token',
  });
  assert.equal(config.baseUrl, 'http://test:1234/v1');
  assert.equal(config.model, 'test-intent-model');
  assert.equal(config.authToken, 'test-token');
});

test('readIntentModelConfig defaults to empty strings when env vars are unset', () => {
  const config = readIntentModelConfig({});
  assert.equal(config.baseUrl, '');
  assert.equal(config.model, '');
  assert.equal(config.authToken, '');
});

test('isConfigured requires both baseUrl and model', () => {
  assert.equal(isConfigured({ baseUrl: '', model: '' }), false);
  assert.equal(isConfigured({ baseUrl: 'http://x', model: '' }), false);
  assert.equal(isConfigured({ baseUrl: '', model: 'x' }), false);
  assert.equal(isConfigured({ baseUrl: 'http://x', model: 'x' }), true);
});

// --- createFromEnv -----------------------------------------------------------

test('createFromEnv returns undefined when GAIA_INTENT_* is unset — IntentIQ degrades to heuristic-only', () => {
  assert.equal(createFromEnv({}), undefined);
});

test('createFromEnv returns undefined when only one of baseUrl/model is set', () => {
  assert.equal(createFromEnv({ GAIA_INTENT_BASE_URL: 'http://test' }), undefined);
  assert.equal(createFromEnv({ GAIA_INTENT_MODEL: 'test-model' }), undefined);
});

test('createFromEnv returns a working client when both baseUrl and model are set', () => {
  const client = createFromEnv({ GAIA_INTENT_BASE_URL: 'http://test:1234/v1', GAIA_INTENT_MODEL: 'test-model' });
  assert.ok(client);
  assert.equal(typeof client.chat, 'function');
});

// --- createIntentModelClient / chat ------------------------------------------

test('createIntentModelClient throws when baseUrl is missing', () => {
  assert.throws(() => createIntentModelClient({ model: 'test' }), /GAIA_INTENT_BASE_URL/);
});

test('createIntentModelClient throws when model is missing', () => {
  assert.throws(() => createIntentModelClient({ baseUrl: 'http://test' }), /GAIA_INTENT_MODEL/);
});

test('chat() posts to {baseUrl}/chat/completions, forcing response_format: json_object', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'http://test:1234/v1/chat/completions');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-intent-model');
    assert.equal(body.stream, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"intent":"converse"}' } }] }) };
  };
  const client = createIntentModelClient({ baseUrl: 'http://test:1234/v1', model: 'test-intent-model', fetchImpl });
  const result = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(result, '{"intent":"converse"}');
});

test('chat() sends the auth token as a bearer header when configured', async () => {
  let seenHeaders;
  const fetchImpl = async (url, options) => {
    seenHeaders = options.headers;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  };
  const client = createIntentModelClient({ baseUrl: 'http://test', model: 'test', authToken: 'secret-intent-key', fetchImpl });
  await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(seenHeaders.Authorization, 'Bearer secret-intent-key');
});

test('chat() sends no Authorization header when no auth token is configured', async () => {
  let seenHeaders;
  const fetchImpl = async (url, options) => {
    seenHeaders = options.headers;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  };
  const client = createIntentModelClient({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(seenHeaders.Authorization, undefined);
});

// --- Error handling: never leak provider/transport details ------------------

test('chat() throws a calm, generic error on network failure — no URL, no key', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED some.host:443 (key=secret-intent-key)'); };
  const client = createIntentModelClient({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), (err) => {
    assert.match(err.message, /intent model unreachable/);
    assert.ok(!err.message.includes('secret-intent-key'));
    assert.ok(!err.message.includes('some.host'));
    return true;
  });
});

test('chat() throws a calm error on a non-200 response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  const client = createIntentModelClient({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), /intent model responded with an error/);
});

test('chat() throws a calm error when the response has no content', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) });
  const client = createIntentModelClient({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), /intent model returned no content/);
});

test('chat() throws a calm error on an unreadable (non-JSON) response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  const client = createIntentModelClient({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), /intent model returned an unreadable response/);
});

// --- Architectural invariant: no cognitive/capability dependencies ---------

test('intentModelClient.js has no code-level dependency on Hermes, ReasonIQ\'s model, the native generator, the Decision Engine, the Orchestrator, or the Response Engine', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/logos/intentModelClient.js'), 'utf-8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const forbidden = [
    'hermesClient', 'reasoningModelClient', 'gaiaGenerator',
    'decisionEngine', 'orchestrator', 'responseEngine',
  ];
  for (const name of forbidden) {
    assert.ok(!codeOnly.includes(name), `intentModelClient.js must not reference ${name}`);
  }
});
