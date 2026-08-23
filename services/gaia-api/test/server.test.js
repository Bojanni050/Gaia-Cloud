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
const TTS_BASE = 'http://fake-tts.internal/v1';

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
function mockFetch({ onNative, onHermes, onTts, ttsShouldFail = false } = {}) {
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
    if (href.startsWith(TTS_BASE)) {
      if (onTts) onTts(href, requestBody);
      if (ttsShouldFail) {
        throw new Error('ECONNREFUSED api.xiaomimimo.com:443 (secret-tts-key)');
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { audio: { data: Buffer.from('RIFF-fake-wav-bytes').toString('base64') } } }] }),
      };
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

// --- POST /speech (TTS — presentation-only, after a text reply exists) -----

test('POST /speech returns audio/wav on success, reaching the configured TTS endpoint', async () => {
  let ttsCalls = 0;
  let seenBody;

  await withMockedFetch(
    mockFetch({ onTts: (href, body) => { ttsCalls += 1; seenBody = body; } }),
    async (originalFetch) => {
      const app = createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'mimo-v2.5-tts-voicedesign' }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ text: 'Ja. Het voelt goed om er te zijn.' }),
        });
        const buf = Buffer.from(await res.arrayBuffer());

        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'audio/wav');
        assert.equal(buf.toString(), 'RIFF-fake-wav-bytes');
        assert.equal(ttsCalls, 1);
        assert.equal(seenBody.model, 'mimo-v2.5-tts-voicedesign');
        assert.equal(seenBody.messages[1].role, 'assistant');
        assert.equal(seenBody.messages[1].content, 'Ja. Het voelt goed om er te zijn.');
        assert.deepEqual(seenBody.audio, { format: 'wav' });
      });
    }
  );
});

test('POST /speech requires auth, same boundary as /conversation/turn', async () => {
  await withMockedFetch(mockFetch(), async (originalFetch) => {
    const app = createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'test-model' }));
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }, // no Authorization
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(res.status, 401);
    });
  });
});

test('POST /speech rejects empty/missing text with a 400, never calling the TTS endpoint', async () => {
  let ttsCalls = 0;
  await withMockedFetch(mockFetch({ onTts: () => { ttsCalls += 1; } }), async (originalFetch) => {
    const app = createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'test-model' }));
    await withServer(app, async (port) => {
      const res1 = await originalFetch(`http://127.0.0.1:${port}/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({}),
      });
      const res2 = await originalFetch(`http://127.0.0.1:${port}/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text: '   ' }),
      });
      assert.equal(res1.status, 400);
      assert.equal(res2.status, 400);
      assert.equal(ttsCalls, 0);
    });
  });
});

test('POST /speech answers 503 when GAIA_TTS_* is not configured (no attempted call)', async () => {
  await withMockedFetch(mockFetch(), async (originalFetch) => {
    const app = createApp(baseEnv()); // no GAIA_TTS_* at all
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text: 'hi' }),
      });
      const body = await res.json();
      assert.equal(res.status, 503);
      assert.equal(body.error, 'speech is not configured');
    });
  });
});

test('POST /speech maps a Xiaomi failure to a calm 502, never leaking the provider, key, or stack', async () => {
  await withMockedFetch(
    mockFetch({ ttsShouldFail: true }),
    async (originalFetch) => {
      const app = createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'test-model', GAIA_TTS_AUTH_TOKEN: 'secret-tts-key' }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ text: 'hi' }),
        });
        const body = await res.json();
        assert.equal(res.status, 502);
        assert.equal(body.error, 'gaia could not speak right now');
        const bodyText = JSON.stringify(body);
        assert.ok(!bodyText.includes('xiaomimimo'));
        assert.ok(!bodyText.includes('secret-tts-key'));
        assert.ok(!bodyText.toLowerCase().includes('econnrefused'));
      });
    }
  );
});
