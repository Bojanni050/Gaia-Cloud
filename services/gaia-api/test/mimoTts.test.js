'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMimoTts,
  readTtsConfig,
  isConfigured,
  createFromEnv,
  mimeTypeFor,
  DEFAULT_VOICE_DESCRIPTION,
} = require('../src/speech/mimoTts');

// --- Configuration ----------------------------------------------------------

test('readTtsConfig reads from environment variables', () => {
  const env = {
    GAIA_TTS_BASE_URL: 'http://test:1234/v1',
    GAIA_TTS_MODEL: 'test-tts-model',
    GAIA_TTS_AUTH_TOKEN: 'test-token',
    GAIA_TTS_FORMAT: 'pcm16',
    GAIA_TTS_VOICE_DESCRIPTION: 'a custom voice',
  };
  const config = readTtsConfig(env);
  assert.equal(config.baseUrl, 'http://test:1234/v1');
  assert.equal(config.model, 'test-tts-model');
  assert.equal(config.authToken, 'test-token');
  assert.equal(config.format, 'pcm16');
  assert.equal(config.voiceDescription, 'a custom voice');
});

test('readTtsConfig defaults to wav format and the built-in Gaia voice description', () => {
  const config = readTtsConfig({});
  assert.equal(config.baseUrl, '');
  assert.equal(config.model, '');
  assert.equal(config.authToken, '');
  assert.equal(config.format, 'wav');
  assert.equal(config.voiceDescription, DEFAULT_VOICE_DESCRIPTION);
});

test('DEFAULT_VOICE_DESCRIPTION reads calm/warm/lively, not a named voice or impersonation', () => {
  assert.match(DEFAULT_VOICE_DESCRIPTION, /calm/i);
  assert.match(DEFAULT_VOICE_DESCRIPTION, /warm/i);
  assert.match(DEFAULT_VOICE_DESCRIPTION, /liveliness/i);
  assert.match(DEFAULT_VOICE_DESCRIPTION, /avoid sounding dramatic, solemn, melancholic/i);
});

test('isConfigured requires both baseUrl and model', () => {
  assert.equal(isConfigured({ baseUrl: '', model: '' }), false);
  assert.equal(isConfigured({ baseUrl: 'http://x', model: '' }), false);
  assert.equal(isConfigured({ baseUrl: '', model: 'x' }), false);
  assert.equal(isConfigured({ baseUrl: 'http://x', model: 'x' }), true);
});

test('mimeTypeFor maps known formats and falls back generically for unknown ones', () => {
  assert.equal(mimeTypeFor('wav'), 'audio/wav');
  assert.equal(mimeTypeFor('pcm16'), 'audio/L16');
  assert.equal(mimeTypeFor('nonsense'), 'application/octet-stream');
});

// --- createFromEnv (the composition server.js uses) -------------------------

test('createFromEnv returns undefined when GAIA_TTS_* is unset — /speech answers 503 rather than guessing', () => {
  assert.equal(createFromEnv({}), undefined);
});

test('createFromEnv returns undefined when only one of baseUrl/model is set', () => {
  assert.equal(createFromEnv({ GAIA_TTS_BASE_URL: 'http://test' }), undefined);
  assert.equal(createFromEnv({ GAIA_TTS_MODEL: 'test-model' }), undefined);
});

test('createFromEnv returns a working client when both baseUrl and model are set', () => {
  const tts = createFromEnv({ GAIA_TTS_BASE_URL: 'http://test:1234/v1', GAIA_TTS_MODEL: 'test-model' });
  assert.ok(tts);
  assert.equal(typeof tts.synthesize, 'function');
});

// --- createMimoTts / synthesize ---------------------------------------------

test('createMimoTts throws when baseUrl is missing', () => {
  assert.throws(() => createMimoTts({ model: 'test' }), /GAIA_TTS_BASE_URL/);
});

test('createMimoTts throws when model is missing', () => {
  assert.throws(() => createMimoTts({ baseUrl: 'http://test' }), /GAIA_TTS_MODEL/);
});

test('synthesize() posts to {baseUrl}/chat/completions with the exact Xiaomi MiMo contract', async () => {
  const fetchImpl = async (url, fetchOptions) => {
    assert.equal(url, 'http://test:1234/v1/chat/completions');
    assert.equal(fetchOptions.method, 'POST');
    const body = JSON.parse(fetchOptions.body);
    assert.equal(body.model, 'mimo-v2.5-tts-voicedesign');
    assert.deepEqual(body.audio, { format: 'wav' });
    assert.equal(body.messages.length, 2);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { audio: { data: Buffer.from('RIFF...fake wav').toString('base64') } } }] }),
    };
  };
  const tts = createMimoTts({ baseUrl: 'http://test:1234/v1', model: 'mimo-v2.5-tts-voicedesign', fetchImpl });
  const result = await tts.synthesize('hello there');
  assert.ok(Buffer.isBuffer(result.audio));
  assert.equal(result.audio.toString(), 'RIFF...fake wav');
  assert.equal(result.mimeType, 'audio/wav');
});

test('synthesize() puts the voice description in the user message and the text to speak in the assistant message', async () => {
  let seenMessages;
  const fetchImpl = async (url, fetchOptions) => {
    seenMessages = JSON.parse(fetchOptions.body).messages;
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from('x').toString('base64') } } }] }) };
  };
  const tts = createMimoTts({
    baseUrl: 'http://test',
    model: 'test-model',
    voiceDescription: 'calm intelligent warm voice',
    fetchImpl,
  });
  await tts.synthesize('Ja. Het voelt goed om er te zijn.');

  assert.equal(seenMessages[0].role, 'user');
  assert.equal(seenMessages[0].content, 'calm intelligent warm voice');
  assert.equal(seenMessages[1].role, 'assistant');
  assert.equal(seenMessages[1].content, 'Ja. Het voelt goed om er te zijn.');
});

test('synthesize() lets a per-call voiceDescription override the client\'s default', async () => {
  let seenMessages;
  const fetchImpl = async (url, fetchOptions) => {
    seenMessages = JSON.parse(fetchOptions.body).messages;
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from('x').toString('base64') } } }] }) };
  };
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'test-model', voiceDescription: 'default voice', fetchImpl });
  await tts.synthesize('hi', { voiceDescription: 'a different voice for this call' });
  assert.equal(seenMessages[0].content, 'a different voice for this call');
});

test('synthesize() sends the configured audio format', async () => {
  let seenBody;
  const fetchImpl = async (url, fetchOptions) => {
    seenBody = JSON.parse(fetchOptions.body);
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from('x').toString('base64') } } }] }) };
  };
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'test-model', format: 'pcm16', fetchImpl });
  await tts.synthesize('hi');
  assert.deepEqual(seenBody.audio, { format: 'pcm16' });
});

test('synthesize() sends the auth token as a bearer header when configured', async () => {
  let seenHeaders;
  const fetchImpl = async (url, fetchOptions) => {
    seenHeaders = fetchOptions.headers;
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from('x').toString('base64') } } }] }) };
  };
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'test-model', authToken: 'secret-xiaomi-key', fetchImpl });
  await tts.synthesize('hi');
  assert.equal(seenHeaders.Authorization, 'Bearer secret-xiaomi-key');
});

test('synthesize() sends no Authorization header when no auth token is configured', async () => {
  let seenHeaders;
  const fetchImpl = async (url, fetchOptions) => {
    seenHeaders = fetchOptions.headers;
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from('x').toString('base64') } } }] }) };
  };
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'test-model', fetchImpl });
  await tts.synthesize('hi');
  assert.equal(seenHeaders.Authorization, undefined);
});

// --- Error handling: never leak provider/transport details ------------------

test('synthesize() throws a calm, generic error on network failure — no URL, no provider name', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED 1.2.3.4:443 (api.xiaomimimo.com)'); };
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'test-model', fetchImpl });
  await assert.rejects(() => tts.synthesize('hi'), (err) => {
    assert.match(err.message, /speech synthesis unreachable/);
    assert.ok(!err.message.includes('xiaomimimo'));
    assert.ok(!err.message.includes('1.2.3.4'));
    return true;
  });
});

test('synthesize() throws a calm, generic error on a non-200 response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'test-model', fetchImpl });
  await assert.rejects(() => tts.synthesize('hi'), (err) => {
    assert.match(err.message, /speech synthesis responded with an error/);
    assert.ok(!err.message.includes('401'));
    return true;
  });
});

test('synthesize() throws a calm error when the response has no audio', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: {} }] }) });
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'test-model', fetchImpl });
  await assert.rejects(() => tts.synthesize('hi'), /speech synthesis returned no audio/);
});

test('synthesize() throws a calm error on an unreadable (non-JSON) response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'test-model', fetchImpl });
  await assert.rejects(() => tts.synthesize('hi'), /speech synthesis returned an unreadable response/);
});

// --- Architectural invariant: no cognitive dependencies ---------------------

test('mimoTts.js has no code-level dependency on Hermes, the native generator, IntentIQ/ReasonIQ, the Decision Engine, the Orchestrator, or the Response Engine', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/speech/mimoTts.js'), 'utf-8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const forbidden = [
    'hermesClient', 'gaiaGenerator', 'intentIQ', 'reasonIQ',
    'decisionEngine', 'orchestrator', 'responseEngine',
  ];
  for (const name of forbidden) {
    assert.ok(!codeOnly.includes(name), `mimoTts.js must not reference ${name}`);
  }
});
