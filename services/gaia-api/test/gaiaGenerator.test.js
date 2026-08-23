'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGaiaGenerator, readNativeConfig, isConfigured } = require('../src/generation/gaiaGenerator');

// --- Configuration --------------------------------------------------------

test('readNativeConfig reads from environment variables', () => {
  const env = {
    GAIA_NATIVE_BASE_URL: 'http://test:1234/v1',
    GAIA_NATIVE_MODEL: 'test-model',
    GAIA_NATIVE_AUTH_TOKEN: 'test-token',
  };
  const config = readNativeConfig(env);
  assert.equal(config.baseUrl, 'http://test:1234/v1');
  assert.equal(config.model, 'test-model');
  assert.equal(config.authToken, 'test-token');
});

test('readNativeConfig defaults to empty strings when env vars are unset', () => {
  const config = readNativeConfig({});
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

// --- createGaiaGenerator --------------------------------------------------

test('createGaiaGenerator throws when baseUrl is missing', () => {
  assert.throws(() => createGaiaGenerator({ model: 'test' }), /GAIA_NATIVE_BASE_URL/);
});

test('createGaiaGenerator throws when model is missing', () => {
  assert.throws(() => createGaiaGenerator({ baseUrl: 'http://test' }), /GAIA_NATIVE_MODEL/);
});

// --- generate (non-streaming) ---------------------------------------------

test('generate() calls the configured provider and returns the content', async () => {
  const fetchImpl = async (url, options) => {
    assert.match(url, /\/chat\/completions$/);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'SOUL' }, { role: 'user', content: 'hello' }]);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Gaia says hello' } }] }),
    };
  };

  const generator = createGaiaGenerator({ baseUrl: 'http://test:1234/v1', model: 'test-model', fetchImpl });
  const result = await generator.generate([
    { role: 'system', content: 'SOUL' },
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(result, 'Gaia says hello');
});

test('generate() sends auth token when configured', async () => {
  let seenHeaders;
  const fetchImpl = async (url, options) => {
    seenHeaders = options.headers;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    };
  };

  const generator = createGaiaGenerator({ baseUrl: 'http://test', model: 'test', authToken: 'secret', fetchImpl });
  await generator.generate([{ role: 'user', content: 'hi' }]);
  assert.equal(seenHeaders.Authorization, 'Bearer secret');
});

test('generate() throws on network failure without leaking details', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const generator = createGaiaGenerator({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await assert.rejects(
    () => generator.generate([{ role: 'user', content: 'hi' }]),
    /native generator unreachable/
  );
});

test('generate() throws on non-200 response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'internal error' });
  const generator = createGaiaGenerator({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await assert.rejects(
    () => generator.generate([{ role: 'user', content: 'hi' }]),
    /native generator responded with an error/
  );
});

test('generate() throws when response has no content', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '' } }] }),
  });
  const generator = createGaiaGenerator({ baseUrl: 'http://test', model: 'test', fetchImpl });
  await assert.rejects(
    () => generator.generate([{ role: 'user', content: 'hi' }]),
    /native generator returned no content/
  );
});

// --- Architectural invariant: Hermes is never called ----------------------

test('the native generator has no code-level dependency on Hermes — it is a completely independent module', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/generation/gaiaGenerator.js'), 'utf-8');
  // Strip comments (both // and /* */) to check only executable code.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!codeOnly.includes('hermesClient'), 'gaiaGenerator.js must not import or require hermesClient');
  assert.ok(!codeOnly.includes("require('../hermesClient"), 'gaiaGenerator.js must not require hermesClient');
  assert.ok(!codeOnly.includes("require('./hermesClient"), 'gaiaGenerator.js must not require hermesClient');
});

// --- stream (streaming) ---------------------------------------------------

test('stream() returns accumulated text and calls onDelta for each chunk', async () => {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  let chunkIndex = 0;

  const fetchImpl = async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (chunkIndex >= chunks.length) return { done: true };
          const value = new TextEncoder().encode(chunks[chunkIndex++]);
          return { value, done: false };
        },
      }),
    },
  });

  const deltas = [];
  const generator = createGaiaGenerator({ baseUrl: 'http://test', model: 'test', fetchImpl });
  const result = await generator.stream(
    [{ role: 'user', content: 'hi' }],
    { onDelta: (chunk, isReasoning) => deltas.push({ chunk, isReasoning }) }
  );

  assert.equal(result, 'Hello');
  assert.deepEqual(deltas, [
    { chunk: 'Hel', isReasoning: false },
    { chunk: 'lo', isReasoning: false },
  ]);
});
