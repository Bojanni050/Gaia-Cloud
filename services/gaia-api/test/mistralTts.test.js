'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMistralTts,
  readTtsConfig,
  isConfigured,
  createFromEnv,
  normalizeFormat,
  mimeTypeFor,
  LANGUAGES,
} = require('../src/speech/mistralTts');

function okAudioResponse(base64 = Buffer.from('ID3...fake mp3').toString('base64')) {
  return { ok: true, json: async () => ({ audio_data: base64 }) };
}

// --- Configuration ----------------------------------------------------------

test('readTtsConfig reads from environment variables', () => {
  const env = {
    GAIA_TTS_BASE_URL: 'http://test:1234/v1',
    GAIA_TTS_MODEL: 'voxtral-mini-tts-2603',
    GAIA_TTS_AUTH_TOKEN: 'test-token',
    GAIA_TTS_FORMAT: 'wav',
    GAIA_TTS_VOICE_ID: 'voice-abc-123',
  };
  const config = readTtsConfig(env);
  assert.equal(config.baseUrl, 'http://test:1234/v1');
  assert.equal(config.model, 'voxtral-mini-tts-2603');
  assert.equal(config.authToken, 'test-token');
  assert.equal(config.format, 'wav');
  assert.equal(config.voiceId, 'voice-abc-123');
});

test('readTtsConfig defaults to mp3 format (not MiMo wav) and no voice', () => {
  const config = readTtsConfig({});
  assert.equal(config.baseUrl, '');
  assert.equal(config.model, '');
  assert.equal(config.authToken, '');
  assert.equal(config.format, 'mp3');
  assert.equal(config.voiceId, '');
});

test('readTtsConfig falls back to mp3 for formats Mistral does not support', () => {
  assert.equal(readTtsConfig({ GAIA_TTS_FORMAT: 'pcm16' }).format, 'mp3');
  assert.equal(readTtsConfig({ GAIA_TTS_FORMAT: '' }).format, 'mp3');
});

test('normalizeFormat keeps every documented Mistral response format', () => {
  for (const format of ['mp3', 'wav', 'pcm', 'flac', 'opus']) {
    assert.equal(normalizeFormat(format), format);
  }
  assert.equal(normalizeFormat('nonsense'), 'mp3');
  assert.equal(normalizeFormat(undefined), 'mp3');
});

test('isConfigured requires both baseUrl and model — voiceId stays optional', () => {
  assert.equal(isConfigured({ baseUrl: '', model: '' }), false);
  assert.equal(isConfigured({ baseUrl: 'http://x', model: '' }), false);
  assert.equal(isConfigured({ baseUrl: '', model: 'x' }), false);
  assert.equal(isConfigured({ baseUrl: 'http://x', model: 'x' }), true);
});

test('mimeTypeFor maps playable formats and falls back generically', () => {
  assert.equal(mimeTypeFor('mp3'), 'audio/mpeg');
  assert.equal(mimeTypeFor('wav'), 'audio/wav');
  assert.equal(mimeTypeFor('flac'), 'audio/flac');
  assert.equal(mimeTypeFor('opus'), 'audio/opus');
  // pcm is raw float32 LE, streaming-oriented — never mislabeled playable
  assert.equal(mimeTypeFor('pcm'), 'application/octet-stream');
  assert.equal(mimeTypeFor('nonsense'), 'application/octet-stream');
});

test('LANGUAGES includes English and Dutch — the desktop gate reads this', () => {
  assert.ok(LANGUAGES.includes('en'));
  assert.ok(LANGUAGES.includes('nl'));
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

// --- createMistralTts / synthesize ------------------------------------------

test('createMistralTts throws when baseUrl is missing', () => {
  assert.throws(() => createMistralTts({ model: 'test' }), /GAIA_TTS_BASE_URL/);
});

test('createMistralTts throws when model is missing', () => {
  assert.throws(() => createMistralTts({ baseUrl: 'http://test' }), /GAIA_TTS_MODEL/);
});

test('synthesize() posts to {baseUrl}/audio/speech with the exact Mistral contract', async () => {
  const fetchImpl = async (url, fetchOptions) => {
    assert.equal(url, 'http://test:1234/v1/audio/speech');
    assert.equal(fetchOptions.method, 'POST');
    const body = JSON.parse(fetchOptions.body);
    assert.equal(body.model, 'voxtral-mini-tts-2603');
    assert.equal(body.input, 'hello there');
    assert.equal(body.response_format, 'mp3');
    assert.ok(!('voice_id' in body), 'no voice_id key at all when no voice is configured');
    return okAudioResponse();
  };
  const tts = createMistralTts({ baseUrl: 'http://test:1234/v1/', model: 'voxtral-mini-tts-2603', fetchImpl });
  const result = await tts.synthesize('hello there');
  assert.ok(Buffer.isBuffer(result.audio));
  assert.equal(result.audio.toString(), 'ID3...fake mp3');
  assert.equal(result.mimeType, 'audio/mpeg');
});

test('synthesize() strips trailing slashes from baseUrl before appending the path', async () => {
  let seenUrl;
  const fetchImpl = async (url) => {
    seenUrl = url;
    return okAudioResponse();
  };
  const tts = createMistralTts({ baseUrl: 'http://test/v1///', model: 'm', fetchImpl });
  await tts.synthesize('hi');
  assert.equal(seenUrl, 'http://test/v1/audio/speech');
});

test('synthesize() sends the configured voice_id when one is set', async () => {
  let seenBody;
  const fetchImpl = async (url, fetchOptions) => {
    seenBody = JSON.parse(fetchOptions.body);
    return okAudioResponse();
  };
  const tts = createMistralTts({ baseUrl: 'http://test', model: 'm', voiceId: 'voice-abc-123', fetchImpl });
  await tts.synthesize('Ja. Het voelt goed om er te zijn.');
  assert.equal(seenBody.voice_id, 'voice-abc-123');
  assert.equal(seenBody.input, 'Ja. Het voelt goed om er te zijn.');
});

test('synthesize() lets a per-call voiceId override the client default', async () => {
  let seenBody;
  const fetchImpl = async (url, fetchOptions) => {
    seenBody = JSON.parse(fetchOptions.body);
    return okAudioResponse();
  };
  const tts = createMistralTts({ baseUrl: 'http://test', model: 'm', voiceId: 'default-voice', fetchImpl });
  await tts.synthesize('hi', { voiceId: 'other-voice' });
  assert.equal(seenBody.voice_id, 'other-voice');
});

test('synthesize() sends the configured audio format and matching mime type', async () => {
  let seenBody;
  const fetchImpl = async (url, fetchOptions) => {
    seenBody = JSON.parse(fetchOptions.body);
    return okAudioResponse();
  };
  const tts = createMistralTts({ baseUrl: 'http://test', model: 'm', format: 'wav', fetchImpl });
  const result = await tts.synthesize('hi');
  assert.equal(seenBody.response_format, 'wav');
  assert.equal(result.mimeType, 'audio/wav');
});

test('synthesize() normalizes an unsupported format to mp3 rather than sending it', async () => {
  let seenBody;
  const fetchImpl = async (url, fetchOptions) => {
    seenBody = JSON.parse(fetchOptions.body);
    return okAudioResponse();
  };
  const tts = createMistralTts({ baseUrl: 'http://test', model: 'm', format: 'pcm16', fetchImpl });
  const result = await tts.synthesize('hi');
  assert.equal(seenBody.response_format, 'mp3');
  assert.equal(result.mimeType, 'audio/mpeg');
});

test('synthesize() sends the auth token as a bearer header when configured', async () => {
  let seenHeaders;
  const fetchImpl = async (url, fetchOptions) => {
    seenHeaders = fetchOptions.headers;
    return okAudioResponse();
  };
  const tts = createMistralTts({ baseUrl: 'http://test', model: 'm', authToken: 'secret-mistral-key', fetchImpl });
  await tts.synthesize('hi');
  assert.equal(seenHeaders.Authorization, 'Bearer secret-mistral-key');
});

test('synthesize() sends no Authorization header when no auth token is configured', async () => {
  let seenHeaders;
  const fetchImpl = async (url, fetchOptions) => {
    seenHeaders = fetchOptions.headers;
    return okAudioResponse();
  };
  const tts = createMistralTts({ baseUrl: 'http://test', model: 'm', fetchImpl });
  await tts.synthesize('hi');
  assert.equal(seenHeaders.Authorization, undefined);
});

// --- Error handling: never leak provider/transport details ------------------

test('synthesize() throws a calm, generic error on network failure — no URL, no provider name', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED 1.2.3.4:443 (api.mistral.ai)'); };
  const tts = createMistralTts({ baseUrl: 'http://test', model: 'm', fetchImpl });
  await assert.rejects(() => tts.synthesize('hi'), (err) => {
    assert.match(err.message, /speech synthesis unreachable/);
    assert.ok(!err.message.includes('mistral'));
    assert.ok(!err.message.includes('1.2.3.4'));
    return true;
  });
});

test('synthesize() throws a calm, generic error on a non-200 response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  const tts = createMistralTts({ baseUrl: 'http://test', model: 'm', fetchImpl });
  await assert.rejects(() => tts.synthesize('hi'), (err) => {
    assert.match(err.message, /speech synthesis responded with an error/);
    assert.ok(!err.message.includes('403'));
    return true;
  });
});

test('synthesize() throws a calm error when the response has no audio', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ something_else: true }) });
  const tts = createMistralTts({ baseUrl: 'http://test', model: 'm', fetchImpl });
  await assert.rejects(() => tts.synthesize('hi'), /speech synthesis returned no audio/);
});

test('synthesize() throws a calm error on an unreadable (non-JSON) response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  const tts = createMistralTts({ baseUrl: 'http://test', model: 'm', fetchImpl });
  await assert.rejects(() => tts.synthesize('hi'), /speech synthesis returned an unreadable response/);
});

// --- Architectural invariant: no cognitive dependencies ---------------------

test('mistralTts.js has no code-level dependency on Hermes, the native generator, IntentIQ/ReasonIQ, the Decision Engine, the Orchestrator, or the Response Engine', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/speech/mistralTts.js'), 'utf-8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const forbidden = [
    'hermesClient', 'gaiaGenerator', 'intentIQ', 'reasonIQ',
    'decisionEngine', 'orchestrator', 'responseEngine',
  ];
  for (const name of forbidden) {
    assert.ok(!codeOnly.includes(name), `mistralTts.js must not reference ${name}`);
  }
});
