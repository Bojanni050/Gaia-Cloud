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
const WEB_BASE = 'http://fake-web-search.internal/search';

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
    // The decision store writes one line per turn. Without this, createApp()
    // falls back to services/gaia-api/data/logos-decisions and every test run
    // appends to whatever the developer has there — measured 18-10-2026:
    // 61 lines per run. Pointed at the throwaway fixture dir instead.
    LOGOS_DECISIONS_PATH: path.join(fixtureDir, 'logos-decisions'),
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

/** The PCM the fake MiMo stream carries, as two chunks a client can hear start. */
const TTS_STREAM_CHUNKS = [Buffer.from('pcm-one'), Buffer.from('pcm-two')];

/**
 * A fake MiMo *streaming* answer for the TTS endpoint: the same SSE framing
 * as sseBody(), but with base64 PCM in choices[0].delta.audio.data (what
 * mimoTts.js's stream() reads) and a real ReadableStream body, like undici's
 * fetch hands to production code.
 *
 * `afterFirstChunk`, when given, is awaited between the two chunks: how a
 * test proves the route writes each chunk out as it arrives instead of
 * buffering the whole reply first.
 */
function ttsSseBody(afterFirstChunk) {
  const frames = TTS_STREAM_CHUNKS.map((pcm) => `data: ${JSON.stringify({
    choices: [{ delta: { audio: { data: pcm.toString('base64') } } }],
  })}\n\n`).concat('data: [DONE]\n\n');
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index === 1 && afterFirstChunk) await afterFirstChunk();
      if (index >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(frames[index++]));
    },
  });
}

/** Fails with `message` if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Polls until `check()` is true — for asserting something a route does out of band. */
async function waitFor(check, message, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

/**
 * Routes fetch by URL prefix to a fake native / hermes responder — reading
 * the request body's own `stream` flag to answer with the JSON shape
 * (performTurn's chat()/generate()) or the SSE shape (performStreamingTurn's
 * stream()), exactly like a real OpenAI-compatible endpoint would. Fails
 * loudly on anything else (e.g. an accidental real network call to
 * Hindsight) so a wiring mistake can't hide behind a silently-caught error.
 */
function mockFetch({ onNative, onHermes, onTts, ttsShouldFail = false, ttsAfterFirstChunk, onWebSearch } = {}) {
  return async (url, options = {}) => {
    const href = String(url);
    const requestBody = options.body ? JSON.parse(options.body) : {};
    if (href.startsWith(NATIVE_BASE)) {
      if (onNative) onNative(href);
      return fakeResponse(requestBody.stream, 'Gaia native voice reply');
    }
    if (href.startsWith(HERMES_BASE)) {
      if (onHermes) onHermes(href);
      // The research pipeline submits a RUN (/v1/runs) rather than a chat
      // completion; answer it with a run id so a job can actually be created.
      if (href.endsWith('/runs')) {
        return { ok: true, json: async () => ({ run_id: 'run_test_1', status: 'started' }) };
      }
      return fakeResponse(requestBody.stream, 'Hermes reply');
    }
    if (href.startsWith(TTS_BASE)) {
      if (onTts) onTts(href, requestBody, options);
      if (ttsShouldFail) {
        throw new Error('ECONNREFUSED api.xiaomimimo.com:443 (secret-tts-key)');
      }
      // POST /speech/stream asks for the streaming contract; POST /speech
      // never does, so one mock serves both.
      if (requestBody.stream) {
        return { ok: true, body: ttsSseBody(ttsAfterFirstChunk) };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { audio: { data: Buffer.from('RIFF-fake-wav-bytes').toString('base64') } } }] }),
      };
    }
    if (href.startsWith(WEB_BASE)) {
      if (onWebSearch) onWebSearch(href);
      return {
        ok: true,
        json: async () => ({
          web: { results: [{ title: 'OpenAI API Reference', url: 'https://platform.openai.com/docs', description: 'The official docs.' }] },
        }),
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

test('createApp does not throw when GAIA_NATIVE_* is unset (native generator stays undefined)', async () => {
  const app = await createApp(baseEnv());
  assert.ok(app);
});

test('createApp does not throw when GAIA_NATIVE_* is set (native generator is constructed)', async () => {
  const app = await createApp(baseEnv({ GAIA_NATIVE_BASE_URL: NATIVE_BASE, GAIA_NATIVE_MODEL: 'test-model' }));
  assert.ok(app);
});

// --- research reach gating (opt-in, off by default) -------------------------

test('research reach is off by default: a research ask never starts a Hermes run', async () => {
  let hermesCalls = 0;

  await withMockedFetch(
    mockFetch({ onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = await createApp(baseEnv({ GAIA_NATIVE_BASE_URL: NATIVE_BASE, GAIA_NATIVE_MODEL: 'test-model' }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'Doe research naar VPS-hosting met bronnen.' }] }),
        });
        const body = await res.json();

        assert.equal(res.status, 200);
        assert.equal(body.reply, 'Gaia native voice reply');
      });
    }
  );

  assert.equal(hermesCalls, 0, 'the reach is opt-in and must not fire unless enabled');
});

test('research reach with GAIA_RESEARCH_REACH=on submits a run and still answers immediately', async () => {
  let hermesCalls = 0;

  await withMockedFetch(
    mockFetch({ onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = await createApp(baseEnv({
        GAIA_NATIVE_BASE_URL: NATIVE_BASE,
        GAIA_NATIVE_MODEL: 'test-model',
        GAIA_RESEARCH_REACH: 'on',
      }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'Doe research naar VPS-hosting met bronnen.' }], conversationId: 'conv-1' }),
        });
        const body = await res.json();

        assert.equal(res.status, 200);
        // The turn answers now; the run is not waited on.
        assert.equal(body.reply, 'Gaia native voice reply');
      });
    }
  );

  assert.equal(hermesCalls, 1, 'exactly one run submitted per research turn');
});

// --- performTurn (non-streaming) -------------------------------------------

test('non-streaming: a native-routable turn reaches GaiaGenerator\'s real HTTP call, never Hermes', async () => {
  let nativeCalls = 0;
  let hermesCalls = 0;

  await withMockedFetch(
    mockFetch({ onNative: () => { nativeCalls += 1; }, onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = await createApp(baseEnv({ GAIA_NATIVE_BASE_URL: NATIVE_BASE, GAIA_NATIVE_MODEL: 'test-model' }));
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

test('non-streaming: without generation configured, the turn answers a calm 503 and never touches Hermes', async () => {
  let nativeCalls = 0;
  let hermesCalls = 0;

  await withMockedFetch(
    mockFetch({ onNative: () => { nativeCalls += 1; }, onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = await createApp(baseEnv()); // no GAIA_NATIVE_* at all
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        });
        const body = await res.json();

        // v3.0: Hermes is never an inference fallback. Unconfigured
        // generation is an honest 503 in Gaia's calm words.
        assert.equal(res.status, 503);
        assert.equal(body.error, 'gaia could not answer right now');
        assert.equal(nativeCalls, 0);
        assert.equal(hermesCalls, 0);
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
      const app = await createApp(baseEnv({ GAIA_NATIVE_BASE_URL: NATIVE_BASE, GAIA_NATIVE_MODEL: 'test-model' }));
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

test('streaming: without generation configured, the turn answers a calm 503 JSON and never touches Hermes', async () => {
  let nativeCalls = 0;
  let hermesCalls = 0;

  await withMockedFetch(
    mockFetch({ onNative: () => { nativeCalls += 1; }, onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = await createApp(baseEnv()); // no GAIA_NATIVE_* at all
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
        });
        const body = await res.json();

        // Nothing ever streamed, so the failure is still a clean JSON
        // body — 503, calm, and Hermes was never consulted.
        assert.equal(res.status, 503);
        assert.equal(body.error, 'gaia could not answer right now');
        assert.equal(nativeCalls, 0);
        assert.equal(hermesCalls, 0);
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
      const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'mimo-v2.5-tts-voicedesign' }));
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
    const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'test-model' }));
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
    const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'test-model' }));
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
    const app = await createApp(baseEnv()); // no GAIA_TTS_* at all
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
      const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'test-model', GAIA_TTS_AUTH_TOKEN: 'secret-tts-key' }));
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

// --- TTS provider dispatch (MiMo vs Mistral Voxtral) --------------------------
//
// The store-backed provider value picks the client: 'mistral' speaks
// Mistral's POST {base}/audio/speech protocol, everything else (including
// the pre-provider 'env' fallback) stays on MiMo's /chat/completions
// protocol. These go through createApp + a real HTTP server with a
// provider-config file on disk, exactly like an admin-saved Voice section.

function writeTtsProviderConfig(tts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-api-tts-provider-test-'));
  const storePath = path.join(dir, 'provider-config.json');
  fs.writeFileSync(storePath, JSON.stringify({
    provider: '',
    baseUrl: '',
    apiKey: '',
    catalog: [],
    catalogRetrievedAt: null,
    roles: {
      generation: { mode: 'catalog', model: '' },
      reasoning: { mode: 'catalog', model: '' },
      vision: { mode: 'catalog', model: '' },
    },
    tts,
    updatedAt: new Date().toISOString(),
  }));
  return storePath;
}

function mockMistralTtsFetch({ onSpeech } = {}) {
  return async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith(`${TTS_BASE}/audio/speech`)) {
      const requestBody = options.body ? JSON.parse(options.body) : {};
      if (onSpeech) onSpeech(href, requestBody);
      return {
        ok: true,
        json: async () => ({ audio_data: Buffer.from('ID3-fake-mp3-bytes').toString('base64') }),
      };
    }
    throw new Error(`unexpected fetch in test to ${href}`);
  };
}

test('POST /speech dispatches to Mistral Voxtral when the stored TTS provider is mistral', async () => {
  let speechCalls = 0;
  let seenBody;

  await withMockedFetch(
    mockMistralTtsFetch({ onSpeech: (href, body) => { speechCalls += 1; seenBody = body; } }),
    async (originalFetch) => {
      const storePath = writeTtsProviderConfig({
        provider: 'mistral',
        baseUrl: TTS_BASE,
        apiKey: 'mistral-key',
        model: 'voxtral-mini-tts-2603',
        voiceId: 'gaia-voice-1',
      });
      const app = await createApp(baseEnv({ GAIA_PROVIDER_CONFIG_PATH: storePath }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ text: 'Ja. Het voelt goed om er te zijn.' }),
        });
        const buf = Buffer.from(await res.arrayBuffer());

        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'audio/mpeg');
        assert.equal(buf.toString(), 'ID3-fake-mp3-bytes');
        assert.equal(speechCalls, 1);
        assert.equal(seenBody.model, 'voxtral-mini-tts-2603');
        assert.equal(seenBody.input, 'Ja. Het voelt goed om er te zijn.');
        assert.equal(seenBody.voice_id, 'gaia-voice-1');
        assert.equal(seenBody.response_format, 'mp3');
      });
    }
  );
});

test('POST /speech omits voice_id when no voice is configured, never sending an empty one', async () => {
  let seenBody;

  await withMockedFetch(
    mockMistralTtsFetch({ onSpeech: (href, body) => { seenBody = body; } }),
    async (originalFetch) => {
      const storePath = writeTtsProviderConfig({
        provider: 'mistral',
        baseUrl: TTS_BASE,
        apiKey: 'mistral-key',
        model: 'voxtral-mini-tts-2603',
      });
      const app = await createApp(baseEnv({ GAIA_PROVIDER_CONFIG_PATH: storePath }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ text: 'hi' }),
        });
        assert.equal(res.status, 200);
        assert.ok(!('voice_id' in seenBody));
      });
    }
  );
});

test('POST /speech records each attempt in the admin voice-activity log', async () => {
  await withMockedFetch(
    mockFetch(),
    async (originalFetch) => {
      const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'mimo-v2.5-tts-voicedesign' }));
      await withServer(app, async (port) => {
        const speechRes = await originalFetch(`http://127.0.0.1:${port}/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ text: 'Yes. It feels good to be here.' }),
        });
        assert.equal(speechRes.status, 200);

        const logRes = await originalFetch(`http://127.0.0.1:${port}/admin/api/tts/log`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(logRes.status, 200);
        const entries = (await logRes.json()).entries;
        assert.equal(entries.length, 1);
        assert.equal(entries[0].outcome, 'ok');
        assert.equal(entries[0].status, 200);
        assert.equal(entries[0].provider, 'env');
        assert.equal(entries[0].model, 'mimo-v2.5-tts-voicedesign');
        assert.match(entries[0].preview, /It feels good/);
      });
    }
  );
});

test('POST /speech logs not-configured attempts instead of failing silently', async () => {
  await withMockedFetch(
    mockFetch(),
    async (originalFetch) => {
      const app = await createApp(baseEnv()); // no GAIA_TTS_* at all
      await withServer(app, async (port) => {
        const speechRes = await originalFetch(`http://127.0.0.1:${port}/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ text: 'hi' }),
        });
        assert.equal(speechRes.status, 503);

        const logRes = await originalFetch(`http://127.0.0.1:${port}/admin/api/tts/log`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        const entries = (await logRes.json()).entries;
        assert.equal(entries.length, 1);
        assert.equal(entries[0].outcome, 'not-configured');
        assert.equal(entries[0].status, 503);
      });
    }
  );
});

// --- POST /speech/stream (the same voice, one chunk at a time) --------------
//
// The streaming sibling of POST /speech: a client asks for the same text and
// hears it start before the reply is finished. Everything it shares with the
// buffered route (auth, validation, the operator log, the calm errors) is
// exercised here through the same real-HTTP path.

/** The request every /speech/stream test makes. */
function streamRequest(port, body, extra = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    ...extra,
  };
}

test('POST /speech/stream writes each PCM chunk out as it arrives — real streaming, not one buffered clip', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let seenBody;

  await withMockedFetch(
    mockFetch({ onTts: (href, body) => { seenBody = body; }, ttsAfterFirstChunk: () => gate }),
    async (originalFetch) => {
      const app = await createApp(baseEnv({
        GAIA_TTS_BASE_URL: TTS_BASE,
        GAIA_TTS_MODEL: 'mimo-v2.5-tts',
        GAIA_TTS_VOICE_ID: 'Chloe',
      }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/speech/stream`, streamRequest(port, { text: 'Ja. Het voelt goed om er te zijn.' }));

        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'audio/L16');
        assert.equal(res.headers.get('x-gaia-sample-rate'), '24000');
        assert.equal(res.headers.get('x-gaia-channels'), '1');
        assert.equal(res.headers.get('cache-control'), 'no-store');

        const reader = res.body.getReader();
        // The whole point of this route: the first bytes reach the client
        // while the provider is still synthesizing the rest. If the route
        // buffered the reply, this read would never settle.
        const first = await withTimeout(
          reader.read(),
          5000,
          'no PCM arrived before the provider finished — the route buffered the reply'
        );
        assert.deepEqual(Buffer.from(first.value), TTS_STREAM_CHUNKS[0]);

        // A built-in voice is what makes this request stream at all: no
        // voice-design message, pcm16 (the only splittable format).
        assert.equal(seenBody.stream, true);
        assert.equal(seenBody.model, 'mimo-v2.5-tts');
        assert.deepEqual(seenBody.audio, { format: 'pcm16', voice: 'Chloe' });
        assert.deepEqual(seenBody.messages, [{ role: 'assistant', content: 'Ja. Het voelt goed om er te zijn.' }]);

        release();
        let rest = Buffer.alloc(0);
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          rest = Buffer.concat([rest, Buffer.from(part.value)]);
        }
        assert.deepEqual(rest, TTS_STREAM_CHUNKS[1]);
      });
    }
  );
});

test('POST /speech/stream requires auth, same boundary as POST /speech', async () => {
  await withMockedFetch(mockFetch(), async (originalFetch) => {
    const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'mimo-v2.5-tts' }));
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(res.status, 401);
    });
  });
});

test('POST /speech/stream rejects empty text with a 400, never calling the TTS endpoint', async () => {
  let ttsCalls = 0;
  await withMockedFetch(mockFetch({ onTts: () => { ttsCalls += 1; } }), async (originalFetch) => {
    const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'mimo-v2.5-tts' }));
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/stream`, streamRequest(port, { text: '   ' }));
      assert.equal(res.status, 400);
      assert.equal(ttsCalls, 0);
    });
  });
});

test('POST /speech/stream answers 503 and logs the attempt when no voice is configured', async () => {
  await withMockedFetch(mockFetch(), async (originalFetch) => {
    const app = await createApp(baseEnv()); // no GAIA_TTS_* at all
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/stream`, streamRequest(port, { text: 'hi' }));
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'speech is not configured');

      const logRes = await originalFetch(`http://127.0.0.1:${port}/admin/api/tts/log`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const entries = (await logRes.json()).entries;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].outcome, 'not-configured');
      assert.equal(entries[0].status, 503);
    });
  });
});

test('POST /speech/stream maps a provider failure to a calm 502 while nothing has been written yet', async () => {
  await withMockedFetch(
    mockFetch({ ttsShouldFail: true }),
    async (originalFetch) => {
      const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'mimo-v2.5-tts', GAIA_TTS_AUTH_TOKEN: 'secret-tts-key' }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/speech/stream`, streamRequest(port, { text: 'hi' }));
        const body = await res.json();

        // Headers are only committed by the first write, so a failure before
        // any audio still gets the same clean JSON answer as POST /speech.
        assert.equal(res.status, 502);
        assert.match(res.headers.get('content-type'), /application\/json/);
        assert.equal(body.error, 'gaia could not speak right now');
        const bodyText = JSON.stringify(body);
        assert.ok(!bodyText.includes('xiaomimimo'));
        assert.ok(!bodyText.includes('secret-tts-key'));
        assert.ok(!bodyText.toLowerCase().includes('econnrefused'));
      });
    }
  );
});

test('POST /speech/stream answers with the whole clip for a provider that cannot stream', async () => {
  await withMockedFetch(
    mockMistralTtsFetch(),
    async (originalFetch) => {
      const storePath = writeTtsProviderConfig({
        provider: 'mistral',
        baseUrl: TTS_BASE,
        apiKey: 'mistral-key',
        model: 'voxtral-mini-tts-2603',
        voiceId: 'gaia-voice-1',
      });
      const app = await createApp(baseEnv({ GAIA_PROVIDER_CONFIG_PATH: storePath }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/speech/stream`, streamRequest(port, { text: 'hi' }));
        const buf = Buffer.from(await res.arrayBuffer());

        // Same route, same request, one write — a client never has to know
        // which voice is behind it.
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'audio/mpeg');
        assert.equal(buf.toString(), 'ID3-fake-mp3-bytes');
      });
    }
  );
});

test('POST /speech/stream records the attempt, the first byte and the size in the voice-activity log', async () => {
  await withMockedFetch(mockFetch(), async (originalFetch) => {
    const app = await createApp(baseEnv({
      GAIA_TTS_BASE_URL: TTS_BASE,
      GAIA_TTS_MODEL: 'mimo-v2.5-tts',
      GAIA_TTS_VOICE_ID: 'Chloe',
    }));
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/stream`, streamRequest(port, { text: 'Yes. It feels good to be here.', language: 'en' }));
      await res.arrayBuffer();

      const logRes = await originalFetch(`http://127.0.0.1:${port}/admin/api/tts/log`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const entries = (await logRes.json()).entries;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].outcome, 'ok');
      assert.equal(entries[0].status, 200);
      assert.equal(entries[0].provider, 'env');
      assert.equal(entries[0].model, 'mimo-v2.5-tts');
      assert.equal(entries[0].voiceId, 'Chloe');
      assert.match(entries[0].preview, /It feels good/);
      assert.equal(typeof entries[0].firstChunkMs, 'number');
      // Both PCM chunks, counted as they went out.
      assert.equal(entries[0].bytes, TTS_STREAM_CHUNKS[0].length + TTS_STREAM_CHUNKS[1].length);
    });
  });
});

test('POST /speech/stream hangs the provider request up when the listener goes away', async () => {
  let seenSignal = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  await withMockedFetch(
    mockFetch({ onTts: (href, body, options) => { seenSignal = options.signal; }, ttsAfterFirstChunk: () => gate }),
    async (originalFetch) => {
      const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'mimo-v2.5-tts' }));
      await withServer(app, async (port) => {
        const client = new AbortController();
        const res = await originalFetch(
          `http://127.0.0.1:${port}/speech/stream`,
          streamRequest(port, { text: 'yes' }, { signal: client.signal })
        );
        const reader = res.body.getReader();
        await withTimeout(reader.read(), 5000, 'no PCM arrived before the provider finished');

        // The listener is gone mid-reply: Gaia must not keep paying for the
        // rest of a sentence nobody will hear.
        client.abort();
        await waitFor(() => seenSignal && seenSignal.aborted, 'the provider request was never hung up');
        release();
        await reader.cancel().catch(() => {});
      });
    }
  );
});

// --- GET /speech/info (voice description for clients) ------------------------

test('GET /speech/info requires auth, same boundary as POST /speech', async () => {
  await withMockedFetch(mockFetch(), async (originalFetch) => {
    const app = await createApp(baseEnv());
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/info`);
      assert.equal(res.status, 401);
    });
  });
});

test('GET /speech/info reports unconfigured with English-only languages when no TTS is set', async () => {
  await withMockedFetch(mockFetch(), async (originalFetch) => {
    const app = await createApp(baseEnv()); // no GAIA_TTS_* at all
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/info`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.configured, false);
      assert.equal(body.provider, null);
      assert.deepEqual(body.languages, ['en']);
    });
  });
});

test('GET /speech/info reports the env (MiMo) voice as Chinese/English-only', async () => {
  await withMockedFetch(mockFetch(), async (originalFetch) => {
    const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'mimo-v2.5-tts-voicedesign' }));
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/info`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.configured, true);
      assert.equal(body.provider, 'env');
      assert.deepEqual(body.languages, ['zh', 'en']);
    });
  });
});

test('GET /speech/info reports the stored Mistral voice with Dutch among its languages', async () => {
  await withMockedFetch(mockFetch(), async (originalFetch) => {
    const storePath = writeTtsProviderConfig({
      provider: 'mistral',
      baseUrl: TTS_BASE,
      apiKey: 'mistral-key',
      model: 'voxtral-mini-tts-2603',
    });
    const app = await createApp(baseEnv({ GAIA_PROVIDER_CONFIG_PATH: storePath }));
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech/info`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.configured, true);
      assert.equal(body.provider, 'mistral');
      assert.ok(body.languages.includes('nl'));
      assert.ok(body.languages.includes('en'));
    });
  });
});

// --- POST /speech with two voices (Dutch default + optional English on another provider) ---

test('POST /speech picks the English voice for language=en and the default voice otherwise', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-api-two-voices-test-'));
  const storePath = path.join(dir, 'provider-config.json');
  fs.writeFileSync(storePath, JSON.stringify({
    provider: '', baseUrl: '', apiKey: '', catalog: [], catalogRetrievedAt: null,
    roles: { generation: { mode: 'catalog', model: '' }, reasoning: { mode: 'catalog', model: '' }, vision: { mode: 'catalog', model: '' } },
    tts: { provider: 'mistral', baseUrl: 'https://mistral.test/v1', apiKey: 'k-nl', model: 'voxtral', voiceId: 'nl-voice' },
    ttsEn: { provider: 'elevenlabs', baseUrl: 'https://eleven.test/v1', apiKey: 'k-en', model: 'eleven_v3', voiceId: 'en-voice' },
    updatedAt: new Date().toISOString(),
  }));
  const seen = [];
  const fake = async (url, options = {}) => {
    const href = String(url);
    seen.push(href);
    if (href.startsWith('https://eleven.test')) {
      const bytes = Buffer.from('EN-AUDIO');
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
    }
    return { ok: true, json: async () => ({ audio_data: Buffer.from('NL-AUDIO').toString('base64') }) };
  };

  await withMockedFetch(fake, async (originalFetch) => {
    const app = await createApp(baseEnv({ GAIA_PROVIDER_CONFIG_PATH: storePath }));
    await withServer(app, async (port) => {
      const speak = async (payload) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(payload),
        });
        return Buffer.from(await res.arrayBuffer()).toString();
      };

      assert.equal(await speak({ text: 'Hello there', language: 'en' }), 'EN-AUDIO');
      assert.ok(seen.at(-1).startsWith('https://eleven.test/v1/text-to-speech/en-voice'));
      assert.equal(await speak({ text: 'Hallo daar', language: 'nl' }), 'NL-AUDIO');
      assert.equal(await speak({ text: 'Okay.' }), 'NL-AUDIO');
      assert.equal(await speak({ text: 'Okay.', language: 'fr' }), 'NL-AUDIO');

      const info = await (await originalFetch(`http://127.0.0.1:${port}/speech/info`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
      assert.equal(info.provider, 'mistral');
      assert.ok(info.languages.includes('nl') && info.languages.includes('en'));
    });
  });
});

test('POST /speech speaks English with the default voice when no English voice is configured', async () => {
  await withMockedFetch(mockFetch(), async (originalFetch) => {
    const app = await createApp(baseEnv({ GAIA_TTS_BASE_URL: TTS_BASE, GAIA_TTS_MODEL: 'mimo-v2.5-tts-voicedesign' }));
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text: 'Hello', language: 'en' }),
      });
      assert.equal(res.status, 200);
    });
  });
});

test('POST /speech uses Fish Audio when it is the stored provider, even without a base URL', async () => {
  const storePath = writeTtsProviderConfig({ provider: 'fishaudio', baseUrl: '', apiKey: 'fish-key', model: 's2.1-pro', voiceId: 'fish-voice' });
  const seen = [];
  const fake = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    const bytes = Buffer.from('FISH-AUDIO');
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  await withMockedFetch(fake, async (originalFetch) => {
    const app = await createApp(baseEnv({ GAIA_PROVIDER_CONFIG_PATH: storePath }));
    await withServer(app, async (port) => {
      const res = await originalFetch(`http://127.0.0.1:${port}/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text: 'Hallo' }),
      });
      assert.equal(res.status, 200);
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'FISH-AUDIO');
      // The process now also runs background jobs (the hypothesis
      // soft-promotion scan polls Cognition at startup), so the TTS request is
      // not necessarily the first fetch — find it by its endpoint.
      const fish = seen.find((s) => s.url.startsWith('https://api.fish.audio/'));
      assert.ok(fish, 'the speech request was sent to Fish Audio');
      assert.equal(fish.init.headers.model, 's2.1-pro');
      assert.equal(JSON.parse(fish.init.body).reference_id, 'fish-voice');

      const info = await (await originalFetch(`http://127.0.0.1:${port}/speech/info`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
      assert.equal(info.configured, true);
      assert.equal(info.provider, 'fishaudio');
      assert.ok(info.languages.includes('nl'));
    });
  });
});

// --- webSearch wiring (src/tools/braveSearch.js) ---------------------------
//
// No non-streaming ("performTurn") equivalent of the streaming test below:
// v3.0: the live path never routes to tools. Web search results shape
// (braveSearch.js's HTTP contract) is covered in braveSearch.test.js;
// turn-level delivery of direct generation is covered in
// planDelivery.test.js and turn.test.js.

// v3.0 LIVE PATH: direct generation only. There is no live web routing —
// an external-knowledge phrasing is answered by the configured
// generation route from its own knowledge, and web search is never
// consulted mid-turn. Hermes is never involved either.

test('streaming: an external-knowledge turn is answered by configured generation, never web search or Hermes', async () => {
  let webCalls = 0;
  let hermesCalls = 0;
  let nativeCalls = 0;

  await withMockedFetch(
    mockFetch({ onNative: () => { nativeCalls += 1; }, onWebSearch: () => { webCalls += 1; }, onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = await createApp(baseEnv({
        GAIA_NATIVE_BASE_URL: NATIVE_BASE,
        GAIA_NATIVE_MODEL: 'test-model',
        GAIA_WEB_SEARCH_API_KEY: 'test-key',
        GAIA_WEB_SEARCH_BASE_URL: WEB_BASE,
      }));
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'what is the current OpenAI API documentation?' }], stream: true }),
        });
        const text = await res.text();

        assert.equal(res.status, 200);
        assert.match(text, /Gaia native voice reply/);
        assert.match(text, /data: \[DONE\]/);
        assert.equal(nativeCalls, 1);
        assert.equal(webCalls, 0);
        assert.equal(hermesCalls, 0);
      });
    }
  );
});

test('streaming: without generation configured, an external-knowledge turn is a calm 503 — no web search, no Hermes', async () => {
  let webCalls = 0;
  let hermesCalls = 0;

  await withMockedFetch(
    mockFetch({ onWebSearch: () => { webCalls += 1; }, onHermes: () => { hermesCalls += 1; } }),
    async (originalFetch) => {
      const app = await createApp(baseEnv()); // no GAIA_NATIVE_*, no GAIA_WEB_SEARCH_* at all
      await withServer(app, async (port) => {
        const res = await originalFetch(`http://127.0.0.1:${port}/conversation/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'what is the current OpenAI API documentation?' }], stream: true }),
        });
        const body = await res.json();

        assert.equal(res.status, 503);
        assert.equal(body.error, 'gaia could not answer right now');
        assert.equal(webCalls, 0);
        assert.equal(hermesCalls, 0);
      });
    }
  );
});
