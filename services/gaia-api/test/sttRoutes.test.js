'use strict';

/**
 * POST /speech/transcribe and GET /speech/stt-info through createApp() and a real HTTP server, with the
 * provider call intercepted at the transport boundary (global fetch), same approach as server.test.js.
 * Listening is an input transport: these tests also pin what it must never do (store audio or text,
 * leak the provider, buffer unauthenticated uploads).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { MAX_AUDIO_BYTES } = require('../src/speech/mistralStt');

const TOKEN = 'test-token';
const STT_BASE = 'http://fake-stt.internal/v1';
const SECRET_KEY = 'stt-secret-key';
const AUDIO = Buffer.from('RIFF----WAVEfmt fake-utterance-bytes');

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-api-stt-test-'));
const FOUNDATION_ARTIFACT_PATH = path.join(fixtureDir, 'foundation-artifact.json');
fs.writeFileSync(FOUNDATION_ARTIFACT_PATH, JSON.stringify({
  documents: { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' },
}));

function baseEnv(overrides = {}) {
  return {
    GAIA_API_TOKEN: TOKEN,
    HERMES_BASE_URL: 'http://fake-hermes.internal/v1',
    HERMES_MODEL: 'hermes-agent',
    FOUNDATION_ARTIFACT_PATH,
    ...overrides,
  };
}

const sttEnv = (overrides = {}) =>
  baseEnv({ GAIA_STT_BASE_URL: STT_BASE, GAIA_STT_MODEL: 'voxtral-mini-latest', GAIA_STT_AUTH_TOKEN: SECRET_KEY, ...overrides });

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
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A provider fake that records the multipart form it receives. */
function sttProvider({ text = 'hallo daar', language = 'nl', status = 200, fail = false, onCall } = {}) {
  return async (url, options = {}) => {
    const href = String(url);
    if (!href.startsWith(`${STT_BASE}/audio/transcriptions`)) throw new Error(`unexpected fetch in test to ${href}`);
    if (fail) throw new Error(`connect ECONNREFUSED ${STT_BASE} ${SECRET_KEY}`);
    if (onCall) await onCall(href, options);
    return { ok: status < 400, status, json: async () => ({ text, language }) };
  };
}

function post(originalFetch, port, { body = AUDIO, type = 'audio/wav', auth = true, query = '', headers = {} } = {}) {
  return originalFetch(`http://127.0.0.1:${port}/speech/transcribe${query}`, {
    method: 'POST',
    headers: { 'Content-Type': type, ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers },
    body,
  });
}

// --- Auth ------------------------------------------------------------------------

test('POST /speech/transcribe requires auth, same boundary as /speech', async () => {
  let providerCalls = 0;
  await withMockedFetch(sttProvider({ onCall: () => { providerCalls += 1; } }), async (originalFetch) => {
    await withServer(createApp(sttEnv()), async (port) => {
      const res = await post(originalFetch, port, { auth: false });
      assert.equal(res.status, 401);
      assert.equal(providerCalls, 0, 'an unauthenticated upload never reaches the provider');
    });
  });
});

test('GET /speech/stt-info requires auth', async () => {
  await withMockedFetch(sttProvider(), async (originalFetch) => {
    await withServer(createApp(sttEnv()), async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/stt-info`);
      assert.equal(res.status, 401);
    });
  });
});

// --- Success ---------------------------------------------------------------------

test('POST /speech/transcribe sends the audio to the provider and returns the text and language', async () => {
  let seen;
  await withMockedFetch(sttProvider({ onCall: (href, options) => { seen = options; } }), async (originalFetch) => {
    await withServer(createApp(sttEnv()), async (port) => {
      const res = await post(originalFetch, port);
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.deepEqual(body, { text: 'hallo daar', language: 'nl' });
      assert.equal(seen.headers.Authorization, `Bearer ${SECRET_KEY}`);
      assert.equal(seen.body.get('model'), 'voxtral-mini-latest');
      assert.equal(Buffer.from(await seen.body.get('file').arrayBuffer()).toString(), AUDIO.toString());
    });
  });
});

test('the language hint travels from the query string or the header to the provider', async () => {
  const hints = [];
  await withMockedFetch(sttProvider({ onCall: (href, options) => { hints.push(options.body.get('language')); } }), async (originalFetch) => {
    await withServer(createApp(sttEnv()), async (port) => {
      await post(originalFetch, port, { query: '?language=nl' });
      await post(originalFetch, port, { headers: { 'X-Gaia-Language': 'en' } });
      await post(originalFetch, port);
    });
  });
  assert.deepEqual(hints, ['nl', 'en', null]);
});

test('a stored provider config (admin-saved) takes the place of the environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-api-stt-provider-test-'));
  const storePath = path.join(dir, 'provider-config.json');
  fs.writeFileSync(storePath, JSON.stringify({
    provider: '', baseUrl: '', apiKey: '', catalog: [], catalogRetrievedAt: null,
    roles: { generation: { mode: 'catalog', model: '' }, reasoning: { mode: 'catalog', model: '' }, vision: { mode: 'catalog', model: '' } },
    stt: { provider: 'mistral', baseUrl: STT_BASE, apiKey: 'stored-key', model: 'voxtral-mini-2602' },
    updatedAt: new Date().toISOString(),
  }));
  let seen;
  await withMockedFetch(sttProvider({ onCall: (href, options) => { seen = options; } }), async (originalFetch) => {
    await withServer(createApp(baseEnv({ GAIA_PROVIDER_CONFIG_PATH: storePath })), async (port) => {
      const res = await post(originalFetch, port);
      assert.equal(res.status, 200);
      assert.equal(seen.headers.Authorization, 'Bearer stored-key');
      assert.equal(seen.body.get('model'), 'voxtral-mini-2602');
    });
  });
});

test('silence comes back as an empty text, not an error', async () => {
  await withMockedFetch(sttProvider({ text: '' }), async (originalFetch) => {
    await withServer(createApp(sttEnv()), async (port) => {
      const res = await post(originalFetch, port);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).text, '');
    });
  });
});

// --- Rejections ---------------------------------------------------------------------

test('an empty body is a 400 and never reaches the provider', async () => {
  let providerCalls = 0;
  await withMockedFetch(sttProvider({ onCall: () => { providerCalls += 1; } }), async (originalFetch) => {
    await withServer(createApp(sttEnv()), async (port) => {
      const res = await post(originalFetch, port, { body: Buffer.alloc(0) });
      assert.equal(res.status, 400);
      assert.equal(providerCalls, 0);
    });
  });
});

test('a JSON body is a 400, not audio', async () => {
  await withMockedFetch(sttProvider(), async (originalFetch) => {
    await withServer(createApp(sttEnv()), async (port) => {
      const res = await post(originalFetch, port, { body: JSON.stringify({ audio: 'x' }), type: 'application/json' });
      assert.equal(res.status, 400);
    });
  });
});

test('an upload over the size limit is a 413 and never reaches the provider', async () => {
  let providerCalls = 0;
  await withMockedFetch(sttProvider({ onCall: () => { providerCalls += 1; } }), async (originalFetch) => {
    await withServer(createApp(sttEnv()), async (port) => {
      const res = await post(originalFetch, port, { body: Buffer.alloc(MAX_AUDIO_BYTES + 1024) });
      assert.equal(res.status, 413);
      assert.equal(providerCalls, 0);
    });
  });
});

test('answers 503 when speech recognition is not configured, with no attempted call', async () => {
  let providerCalls = 0;
  await withMockedFetch(sttProvider({ onCall: () => { providerCalls += 1; } }), async (originalFetch) => {
    await withServer(createApp(baseEnv()), async (port) => {
      const res = await post(originalFetch, port);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'speech recognition is not configured');
      assert.equal(providerCalls, 0);
    });
  });
});

// --- Calm failures ----------------------------------------------------------------------

test('a provider failure is a calm 502 that never leaks the provider, endpoint, key or error text', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    await withMockedFetch(sttProvider({ fail: true }), async (originalFetch) => {
      await withServer(createApp(sttEnv()), async (port) => {
        const res = await post(originalFetch, port);
        const raw = await res.text();
        assert.equal(res.status, 502);
        assert.deepEqual(JSON.parse(raw), { error: 'gaia could not listen right now' });
        for (const leaked of [STT_BASE, SECRET_KEY, 'ECONNREFUSED', 'voxtral', 'mistral']) {
          assert.ok(!raw.includes(leaked), `leaked: ${leaked}`);
        }
      });
    });
  } finally {
    console.error = originalError;
  }
});

test('a provider error status is also a calm 502', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    await withMockedFetch(sttProvider({ status: 401 }), async (originalFetch) => {
      await withServer(createApp(sttEnv()), async (port) => {
        const res = await post(originalFetch, port);
        assert.equal(res.status, 502);
      });
    });
  } finally {
    console.error = originalError;
  }
});

test('the operator log says why a transcription failed, without the key or the provider words', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    await withMockedFetch(sttProvider({ status: 401 }), async (originalFetch) => {
      await withServer(createApp(sttEnv()), async (port) => {
        const res = await post(originalFetch, port);
        assert.ok(!(await res.text()).includes('401'), 'the client gets the calm message only');
        const log = await originalFetch(`http://127.0.0.1:${port}/admin/api/stt/log`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        const { entries } = await log.json();
        assert.equal(entries[0].error, 'gaia could not listen right now (provider answered 401)');
        assert.ok(!JSON.stringify(entries).includes(SECRET_KEY));
      });
    });
  } finally {
    console.error = originalError;
  }
});

// --- Privacy: what the operator log may hold ----------------------------------------------

test('the admin listening log records bytes, timing and outcome, never the audio or the words', async () => {
  const SPOKEN = 'dit is een geheim gesprek';
  await withMockedFetch(sttProvider({ text: SPOKEN }), async (originalFetch) => {
    await withServer(createApp(sttEnv()), async (port) => {
      await post(originalFetch, port);
      await post(originalFetch, port, { body: Buffer.alloc(0) });
      const res = await originalFetch(`http://127.0.0.1:${port}/admin/api/stt/log`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const { entries } = await res.json();
      const raw = JSON.stringify(entries);

      assert.equal(res.status, 200);
      assert.equal(entries.length, 2);
      assert.equal(entries[1].outcome, 'ok');
      assert.equal(entries[1].bytes, AUDIO.length);
      assert.equal(entries[1].model, 'voxtral-mini-latest');
      assert.equal(entries[0].outcome, 'bad-request');
      assert.ok(!raw.includes(SPOKEN), 'the transcript must not be logged');
      assert.ok(!raw.includes('fake-utterance'), 'the audio must not be logged');
      assert.ok(!raw.includes(SECRET_KEY), 'the key must not be logged');
    });
  });
});

test('a not-configured attempt is logged, so a silent microphone is debuggable', async () => {
  await withMockedFetch(sttProvider(), async (originalFetch) => {
    await withServer(createApp(baseEnv()), async (port) => {
      await post(originalFetch, port);
      const res = await originalFetch(`http://127.0.0.1:${port}/admin/api/stt/log`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const { entries } = await res.json();
      assert.equal(entries[0].outcome, 'not-configured');
      assert.equal(entries[0].status, 503);
    });
  });
});

// --- GET /speech/stt-info -------------------------------------------------------------------

test('GET /speech/stt-info reports unconfigured when no STT is set', async () => {
  await withMockedFetch(sttProvider(), async (originalFetch) => {
    await withServer(createApp(baseEnv()), async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/stt-info`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.configured, false);
      assert.equal(body.provider, null);
    });
  });
});

test('GET /speech/stt-info reports the provider, the languages and the upload limit', async () => {
  await withMockedFetch(sttProvider(), async (originalFetch) => {
    await withServer(createApp(sttEnv()), async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/stt-info`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const body = await res.json();
      assert.equal(body.configured, true);
      assert.equal(body.provider, 'env');
      assert.ok(body.languages.includes('nl'));
      assert.equal(body.maxBytes, MAX_AUDIO_BYTES);
      assert.ok(!JSON.stringify(body).includes(SECRET_KEY), 'info never carries the key');
    });
  });
});
