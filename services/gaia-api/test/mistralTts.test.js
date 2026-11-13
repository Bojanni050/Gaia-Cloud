'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMistralTts,
  listVoices,
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

// --- listVoices (admin voice picker) ----------------------------------------

test('listVoices() GETs {baseUrl}/audio/voices and maps items to id/name pairs', async () => {
  let seenUrl;
  let seenHeaders;
  const fetchImpl = async (url, fetchOptions) => {
    seenUrl = url;
    seenHeaders = fetchOptions.headers;
    return {
      ok: true,
      json: async () => ({
        // No `total` here — a short page alone must end the walk.
        items: [
          { id: 'voice-1', name: 'Gaia Warm', type: 'custom' },
          { id: 'voice-2', name: '', type: 'preset' },
          { id: '', name: 'nameless' },
          null,
        ],
      }),
    };
  };
  const voices = await listVoices({ baseUrl: 'http://test:1234/v1/', authToken: 'k', fetchImpl });
  assert.equal(seenUrl, 'http://test:1234/v1/audio/voices?limit=100&offset=0');
  assert.equal(seenHeaders.Authorization, 'Bearer k');
  assert.deepEqual(voices, [
    { id: 'voice-1', name: 'Gaia Warm' },
    { id: 'voice-2', name: 'voice-2' },
  ]);
});

test('listVoices() throws when baseUrl is missing', async () => {
  await assert.rejects(() => listVoices({}), /GAIA_TTS_BASE_URL/);
});

test('listVoices() throws a calm error on network failure', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED 1.2.3.4:443'); };
  await assert.rejects(() => listVoices({ baseUrl: 'http://test', fetchImpl }), (err) => {
    assert.match(err.message, /voice listing unreachable/);
    assert.ok(!err.message.includes('1.2.3.4'));
    return true;
  });
});

test('listVoices() carries the HTTP status so callers can map 401 to bad-key wording', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => listVoices({ baseUrl: 'http://test', fetchImpl }), (err) => {
    assert.match(err.message, /voice listing responded with an error/);
    assert.equal(err.status, 401);
    return true;
  });
});

test('listVoices() throws a calm error on an unreadable response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  await assert.rejects(() => listVoices({ baseUrl: 'http://test', fetchImpl }), /voice listing returned an unreadable response/);
});

test('listVoices() returns an empty list when the response has no items array', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  assert.deepEqual(await listVoices({ baseUrl: 'http://test', fetchImpl }), []);
});

test('listVoices() follows pages until the reported total is reached', async () => {
  const seenOffsets = [];
  const fetchImpl = async (url) => {
    seenOffsets.push(url);
    const offset = Number(new URL(url).searchParams.get('offset'));
    const items = offset === 0
      ? [{ id: 'voice-1', name: 'One' }, { id: 'voice-2', name: 'Two' }]
      : [{ id: 'voice-3', name: 'Three' }];
    return { ok: true, json: async () => ({ items, total: 3 }) };
  };
  // The server pages smaller than the requested limit=100 here — the
  // reported total (3) must keep the walk going past the short page.
  const voices = await listVoices({ baseUrl: 'http://test', fetchImpl });
  assert.deepEqual(seenOffsets, [
    'http://test/audio/voices?limit=100&offset=0',
    'http://test/audio/voices?limit=100&offset=2',
  ]);
  assert.deepEqual(voices.map((v) => v.id), ['voice-1', 'voice-2', 'voice-3']);
});

test('listVoices() stops after a short page even without a total', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ items: [{ id: 'only', name: 'Only' }] }) };
  };
  const voices = await listVoices({ baseUrl: 'http://test', fetchImpl });
  assert.equal(calls, 1);
  assert.deepEqual(voices, [{ id: 'only', name: 'Only' }]);
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

// --- Streaming --------------------------------------------------------------

/** @param {number[]} samples float32 samples, in [-1, 1] */
function float32Buffer(samples) {
  const buffer = Buffer.alloc(samples.length * 4);
  samples.forEach((sample, index) => buffer.writeFloatLE(sample, index * 4));
  return buffer;
}

/** One SSE event line, exactly as Mistral frames it. */
function sseEvent(payload) {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/** A response whose body is the given SSE text, split into `parts`. */
function sseResponse(text, parts = 1, extra = {}) {
  const size = Math.ceil(text.length / parts);
  const pieces = [];
  for (let offset = 0; offset < text.length; offset += size) pieces.push(Buffer.from(text.slice(offset, offset + size)));
  return {
    ok: true,
    body: (async function* () { for (const piece of pieces) yield piece; })(),
    ...extra,
  };
}

function mistralClient(fetchImpl, extra = {}) {
  return createMistralTts({ baseUrl: 'http://test:1234/v1', model: 'voxtral-mini-tts-2603', fetchImpl, ...extra });
}

async function collect(generator) {
  const chunks = [];
  for await (const chunk of generator) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('stream() asks for raw streaming pcm and the configured voice', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return sseResponse(sseEvent({ type: 'speech.audio.delta', audio_data: float32Buffer([0.5]).toString('base64') }) + sseEvent({ type: 'speech.audio.done', usage: {} }));
  };
  await collect(mistralClient(fetchImpl, { voiceId: 'voice-1' }).stream('Hi there'));

  assert.equal(seen.url, 'http://test:1234/v1/audio/speech');
  assert.equal(seen.init.headers.Authorization, undefined);
  assert.equal(seen.init.headers.Accept, 'text/event-stream');
  assert.deepEqual(JSON.parse(seen.init.body), {
    model: 'voxtral-mini-tts-2603',
    input: 'Hi there',
    response_format: 'pcm',
    stream: true,
    voice_id: 'voice-1',
  });
});

test('stream() converts float32 samples to PCM16LE', async () => {
  const samples = [0, 0.5, -0.5, 1, -1, 2, -2, Number.NaN];
  const fetchImpl = async () => sseResponse(sseEvent({ type: 'speech.audio.delta', audio_data: float32Buffer(samples).toString('base64') }));
  const pcm = await collect(mistralClient(fetchImpl).stream('x'));

  assert.equal(pcm.length, samples.length * 2);
  assert.deepEqual(
    Array.from({ length: samples.length }, (_, index) => pcm.readInt16LE(index * 2)),
    [0, 16384, -16383, 32767, -32767, 32767, -32767, 0],
  );
});

test('stream() keeps a sample that is split across two events intact', async () => {
  const raw = float32Buffer([0.25, 0.75]);
  // Split mid-sample: the first event ends after two bytes of the first float.
  const first = raw.subarray(0, 2).toString('base64');
  const second = raw.subarray(2).toString('base64');
  const fetchImpl = async () => sseResponse(
    sseEvent({ type: 'speech.audio.delta', audio_data: first }) + sseEvent({ type: 'speech.audio.delta', audio_data: second }),
  );
  const pcm = await collect(mistralClient(fetchImpl).stream('x'));
  assert.equal(pcm.length, 4);
  assert.equal(pcm.readInt16LE(0), 8192);
  assert.equal(pcm.readInt16LE(2), 24575);
});

test('stream() also reads the SDK shape with the payload nested under data', async () => {
  const fetchImpl = async () => sseResponse(
    sseEvent({ event: 'speech.audio.delta', data: { audio_data: float32Buffer([-0.25]).toString('base64') } }),
  );
  const pcm = await collect(mistralClient(fetchImpl).stream('x'));
  assert.equal(pcm.readInt16LE(0), -8192);
});

test('stream() stops at speech.audio.done and skips framing it cannot read', async () => {
  const fetchImpl = async () => sseResponse(
    ': keepalive\n\n'
    + 'data: not json\n\n'
    + sseEvent({ type: 'speech.audio.delta', audio_data: float32Buffer([0.5]).toString('base64') })
    + sseEvent({ type: 'speech.audio.done', usage: { total_tokens: 1 } })
    + sseEvent({ type: 'speech.audio.delta', audio_data: float32Buffer([0.1]).toString('base64') }),
    5,
  );
  const pcm = await collect(mistralClient(fetchImpl).stream('x'));
  assert.equal(pcm.length, 2);
  assert.equal(pcm.readInt16LE(0), 16384);
});

test('stream() answers a provider error as one calm message', async () => {
  const fetchImpl = async () => sseResponse(sseEvent({ type: 'speech.audio.delta', error: { message: 'quota for org-123' } }));
  await assert.rejects(() => collect(mistralClient(fetchImpl).stream('x')), (err) => {
    assert.match(err.message, /speech synthesis responded with an error/);
    assert.ok(!err.message.includes('quota'));
    return true;
  });
});

test('stream() is calm about an HTTP failure, an empty stream and a missing body', async () => {
  await assert.rejects(() => collect(mistralClient(async () => ({ ok: false, status: 429 })).stream('x')), /speech synthesis responded with an error/);
  await assert.rejects(() => collect(mistralClient(async () => sseResponse(sseEvent({ type: 'speech.audio.done' }))).stream('x')), /speech synthesis returned no audio/);
  await assert.rejects(() => collect(mistralClient(async () => ({ ok: true, body: null })).stream('x')), /speech synthesis returned no audio/);
});

test('stream() reports an abort as cancelled, not as an outage', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async () => {
    const error = new Error('aborted');
    throw error;
  };
  await assert.rejects(() => collect(mistralClient(fetchImpl).stream('x', { signal: controller.signal })), /speech synthesis was cancelled/);
});

test('stream() advertises the PCM shape server.js announces to the desktop', () => {
  const { STREAM_FORMAT, STREAM_SAMPLE_RATE, STREAM_CHANNELS } = require('../src/speech/mistralTts');
  assert.equal(STREAM_FORMAT, 'pcm16');
  assert.equal(STREAM_SAMPLE_RATE, 24000);
  assert.equal(STREAM_CHANNELS, 1);
});
