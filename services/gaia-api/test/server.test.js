'use strict';

/**
 * server.js wiring regression tests — proving the native generator
 * (src/generation/gaiaGenerator.js) is actually constructed from env and
 * actually reached through the real HTTP path, for both performTurn (the
 * non-streaming route) and performStreamingTurn (the SSE route).
 *
 * These intentionally go through createApp() + a real HTTP server rather
 * than injecting fakes into turn.js directly (already covered in
 * turn.test.js) — the gap this file exists to close is specifically
 * "is server.js's wiring correct", which only a real app.listen() +
 * request can prove. Network calls are intercepted at the transport
 * boundary (global fetch) rather than hitting any real provider.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

const TOKEN = 'test-token';
const NATIVE_BASE = 'http://fake-native.internal/v1';
const HERMES_BASE = 'http://fake-hermes.internal/v1';

// createApp() -> loadFoundationDocuments() hard-fails without a
// foundation-artifact.json (see foundation.js) — a file that only exists
// locally after running scripts/build-foundation-artifact.js, and that CI's
// test job never generates (only the later deploy step does, per
// .github/workflows/deploy.yml). A minimal fixture + FOUNDATION_ARTIFACT_PATH
// (createApp's own documented env-override seam) keeps this suite
// independent of that build step, in CI and locally alike.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-api-server-test-'));
const FOUNDATION_ARTIFACT_PATH = path.join(fixtureDir, 'foundation-artifact.json');
fs.writeFileSync(FOUNDATION_ARTIFACT_PATH, JSON.stringify({
  documents: { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' },
}));

function baseEnv(overrides = {}) {
  return {
    GAIA_API_TOKEN: TOKEN,
    HERMES_BASE_URL: HERMES_BASE,
    HERMES_MODEL: 'hermes-agent',
    FOUNDATION_ARTIFACT_PATH,
    ...overrides,
  };
}

/**
 * A minimal fake SSE body: one content delta frame, then [DONE] — the same
 * shape hermesClient.js's stream() and gaiaGenerator.js's stream() both
 * parse via response.body.getReader().
 */
function sseBody(content) {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i >= chunks.length) return { done: true, value: undefined };
        const value = new TextEncoder().encode(chunks[i++]);
        return { value, done: false };
      },
    }),
  };
}

/** Shapes a fake fetch response for either the streaming or JSON call path. */
function fakeResponse(isStream, content) {
  if (isStream) {
    return { ok: true, body: sseBody(content) };
  }
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}

/**
 * Routes fetch by URL prefix to a fake native / hermes responder — reading
 * the request body's own `stream` flag to answer with the JSON shape
 * (performTurn's chat()/generate()) or the SSE shape (performStreamingTurn's
 * stream()), exactly like a real OpenAI-compatible endpoint would. Fails
 * loudly on anything else (e.g. an accidental real network call to
 * Hindsight) so a wiring mistake can't hide behind a silently-caught error.
 */
function mockFetch({ onNative, onHermes } = {}) {
  return async (url, options = {}) => {
    const href = String(url);
    const requestBody = options.body ? JSON.parse(options.body) : {};
    if (href.startsWith(NATIVE_BASE)) {
      if (onNative) onNative(href);
      return fakeResponse(requestBody.stream, 'Gaia native voice reply');
    }
    if (href.startsWith(HERMES_BASE)) {
      if (onHermes) onHermes(href);
      return fakeResponse(requestBody.stream, 'Hermes reply');
    }
    // Anything else (e.g. Hindsight) — hindsightClient.js/memory.js already
    // catch fetch failures internally and degrade gracefully; a rejection
    // here is the correct way to simulate "unreachable" for those calls
    // without a real network dependency.
    throw new Error(`unexpected fetch in test to ${href}`);
  };
}

async function withMockedFetch(impl, fn) {
  const originalFetch = global.fetch;
  global.fetch = impl;
  try {
    await fn(originalFetch);
  } finally {
    global.fetch = originalFetch;
  }
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- createApp wiring (unit-level) -----------------------------------------

test('createApp does not throw when GAIA_NATIVE_* is unset (native generator stays undefined)', () => {
  assert.doesNotThrow(() => createApp(baseEnv()));
});

test('createApp does not throw when GAIA_NATIVE_* is set (native generator is constructed)', () => {
  assert.doesNotThrow(() => createApp(baseEnv({ GAIA_NATIVE_BASE_URL: NATIVE_BASE, GAIA_NATIVE_MODEL: 'test-model' })));
});

// --- performTurn (non-streaming) -------------------------------------------

test('non-streaming: a native-routable turn reaches GaiaGenerator\'s real HTTP call, never Hermes', async () => {
  let nativeCalls = 0;
  let hermesCalls = 0;

  await withMockedFetch(
    mockFetch({ onNative: () => { nativeCalls += 1; }, onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = createApp(baseEnv({ GAIA_NATIVE_BASE_URL: NATIVE_BASE, GAIA_NATIVE_MODEL: 'test-model' }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        });
        const body = await res.json();

        assert.equal(res.status, 200);
        assert.equal(body.reply, 'Gaia native voice reply');
        assert.equal(nativeCalls, 1);
        assert.equal(hermesCalls, 0);
      });
    }
  );
});

test('non-streaming: without GAIA_NATIVE_* configured, the same turn falls back to Hermes (backward compatible)', async () => {
  let nativeCalls = 0;
  let hermesCalls = 0;

  await withMockedFetch(
    mockFetch({ onNative: () => { nativeCalls += 1; }, onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = createApp(baseEnv()); // no GAIA_NATIVE_* at all
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        });
        const body = await res.json();

        assert.equal(res.status, 200);
        assert.equal(body.reply, 'Hermes reply');
        assert.equal(nativeCalls, 0);
        assert.equal(hermesCalls, 1);
      });
    }
  );
});

// --- performStreamingTurn (SSE) --------------------------------------------

test('streaming: a native-routable turn reaches GaiaGenerator\'s real HTTP call, never Hermes', async () => {
  let nativeCalls = 0;
  let hermesCalls = 0;

  await withMockedFetch(
    mockFetch({ onNative: () => { nativeCalls += 1; }, onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = createApp(baseEnv({ GAIA_NATIVE_BASE_URL: NATIVE_BASE, GAIA_NATIVE_MODEL: 'test-model' }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
        });
        const text = await res.text();

        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'text/event-stream');
        assert.match(text, /Gaia native voice reply/);
        assert.match(text, /data: \[DONE\]/);
        assert.equal(nativeCalls, 1);
        assert.equal(hermesCalls, 0);
        // No provider/model name ever reaches the wire.
        assert.ok(!text.includes('test-model'));
        assert.ok(!text.toLowerCase().includes('hermes'));
      });
    }
  );
});

test('streaming: without GAIA_NATIVE_* configured, the same turn falls back to Hermes (backward compatible)', async () => {
  let nativeCalls = 0;
  let hermesCalls = 0;

  await withMockedFetch(
    mockFetch({ onNative: () => { nativeCalls += 1; }, onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = createApp(baseEnv()); // no GAIA_NATIVE_* at all
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
        });
        const text = await res.text();

        assert.equal(res.status, 200);
        assert.match(text, /Hermes reply/);
        assert.equal(nativeCalls, 0);
        assert.equal(hermesCalls, 1);
      });
    }
  );
});
