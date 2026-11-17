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
  createPcmMeter,
  matchSegmentGain,
  applyPcmGain,
  wrapPcm16Wav,
  LANGUAGES,
  LEVEL_MIN_SPEECH_SAMPLES,
  STREAM_SAMPLE_RATE,
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

// --- Segmenting: one provider request per paragraph --------------------------

const { splitForSynthesis, createPcmTrimmer } = require('../src/speech/mistralTts');

test('splitForSynthesis keeps a reply in one request as long as it is one paragraph', () => {
  assert.deepEqual(splitForSynthesis('Hi there'), ['Hi there']);
  assert.deepEqual(
    splitForSynthesis('The wind turned west. The rain came early. Nobody minded.'),
    ['The wind turned west. The rain came early. Nobody minded.'],
  );
});

test('splitForSynthesis asks once per paragraph', () => {
  const text = [
    'One sentence goes here. Two follows it.',
    '',
    'Three comes next. Four closes the answer.',
  ].join('\n');
  assert.deepEqual(splitForSynthesis(text), [
    'One sentence goes here. Two follows it.',
    'Three comes next. Four closes the answer.',
  ]);
});

test('splitForSynthesis treats a single newline as a wrap, not a pause', () => {
  const text = 'The first line\ncontinues on the second\nand ends here.';
  assert.deepEqual(splitForSynthesis(text), ['The first line continues on the second and ends here.']);
});

test('splitForSynthesis does not cut at an abbreviation, an initial or a decimal', () => {
  const filler = 'Filler words go here. '.repeat(30);
  const segments = splitForSynthesis(`${filler}Dr. J. Smith arrived at 3.14 sharp. He stayed.`);
  assert.ok(
    segments.some((segment) => segment.includes('Dr. J. Smith arrived at 3.14 sharp. He stayed.')),
    'the guarded sentence survives whole',
  );
});

test('splitForSynthesis cuts a paragraph that is too long for one request', () => {
  const long = `${'a word that goes on '.repeat(40)}and ends here.`;
  const segments = splitForSynthesis(long);
  assert.ok(segments.length > 1, 'a paragraph that long must be cut');
  for (const segment of segments) assert.ok(segment.length <= 600, `too long: ${segment.length}`);
  assert.ok(segments.join(' ').includes('and ends here.'), 'nothing is dropped');
});

test('splitForSynthesis is empty for empty text', () => {
  assert.deepEqual(splitForSynthesis('   '), []);
});

test('stream() asks the provider once per paragraph, in order, with a breath between', async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push(JSON.parse(init.body).input);
    return sseResponse(sseEvent({ type: 'speech.audio.delta', audio_data: float32Buffer([0.5]).toString('base64') }));
  };
  const text = 'First paragraph here.\n\nSecond paragraph ends it.';
  const pcm = await collect(mistralClient(fetchImpl).stream(text));

  assert.deepEqual(asked, ['First paragraph here.', 'Second paragraph ends it.']);
  // Two samples of audio, the 600 ms breath between them, and nothing after.
  assert.equal(pcm.length, 2 + 28_800 + 2);
  assert.ok(pcm.subarray(2, 2 + 28_800).every((byte) => byte === 0), 'the gap is silence');
});

test('stream() starts the next paragraph before the first one has played out', async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push(JSON.parse(init.body).input);
    return sseResponse(sseEvent({ type: 'speech.audio.delta', audio_data: float32Buffer([0.5]).toString('base64') }));
  };
  const text = 'First paragraph here.\n\nSecond paragraph ends it.';
  const generator = mistralClient(fetchImpl).stream(text);
  await generator.next();

  // Waiting for the first request to finish cost a full provider round trip (1.4 s) of silence.
  assert.equal(asked.length, 2, 'both requests are already in flight');

  // Close the generator so its `finally` runs: an abandoned one keeps the
  // whole-reply timeout (120 s) pending and holds the test process open long
  // after the suite has finished.
  await generator.return();
});

test('stream() puts no silence after the last paragraph', async () => {
  const fetchImpl = async () => sseResponse(sseEvent({ type: 'speech.audio.delta', audio_data: float32Buffer([0.5]).toString('base64') }));
  const pcm = await collect(mistralClient(fetchImpl).stream('Only one paragraph. Nothing else.'));
  assert.equal(pcm.length, 2);
});

test('the trimmer keeps a sliver of padding and the pauses inside a segment', () => {
  const trimmer = createPcmTrimmer();
  const silence = (samples) => {
    const out = Buffer.alloc(samples * 2);
    return out;
  };
  const loud = (samples) => {
    const out = Buffer.allocUnsafe(samples * 2);
    for (let i = 0; i < samples; i += 1) out.writeInt16LE(12_000, i * 2);
    return out;
  };

  // 2 s of padding, a word, a 0.5 s pause, another word, 2 s of padding.
  const trimmed = Buffer.concat([
    trimmer.push(silence(48_000)),
    trimmer.push(loud(2_400)),
    trimmer.push(silence(12_000)),
    trimmer.push(loud(2_400)),
    trimmer.push(silence(48_000)),
    trimmer.flush(),
  ]);

  const samples = trimmed.length / 2;
  const lead = 60 / 1000 * 24_000;
  const tail = 150 / 1000 * 24_000;
  assert.equal(samples, lead + 2_400 + 12_000 + 2_400 + tail, 'padding cut back, pause kept whole');
});

test('the trimmer drops a segment that is nothing but silence', () => {
  const trimmer = createPcmTrimmer();
  assert.equal(trimmer.push(Buffer.alloc(24_000 * 2)).length, 0);
  assert.equal(trimmer.flush().length, 0);
});

test('stream() still answers a reply that produced nothing at all', async () => {
  const fetchImpl = async () => sseResponse(sseEvent({ type: 'speech.audio.done' }));
  await assert.rejects(
    () => collect(mistralClient(fetchImpl).stream('One sentence. And another one.')),
    /speech synthesis returned no audio/,
  );
});

// --- POST /speech: a long reply is spoken in segments, returned as one WAV ---

/** PCM16LE at a constant amplitude — a stand-in for a segment of speech. */
function pcm16(samples, amplitude) {
  const out = Buffer.allocUnsafe(samples * 2);
  for (let index = 0; index < samples; index += 1) out.writeInt16LE(Math.round(amplitude * 32767), index * 2);
  return out;
}

/** A provider that answers the streaming shape, and records what it was asked. */
function streamingProvider(samples, amplitude) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push(JSON.parse(init.body));
    return sseResponse(
      sseEvent({ type: 'speech.audio.delta', audio_data: float32Buffer(Array(samples).fill(amplitude)).toString('base64') })
      + sseEvent({ type: 'speech.audio.done', usage: {} }),
    );
  };
  return { fetchImpl, asked };
}

const TWO_PARAGRAPHS = 'Eerste alinea hier.\n\nTweede alinea daar.';

test('synthesize() speaks a multi-paragraph reply as one request per segment', async () => {
  const { fetchImpl, asked } = streamingProvider(1, 0.5);
  const { audio, mimeType } = await mistralClient(fetchImpl).synthesize(TWO_PARAGRAPHS);

  assert.equal(asked.length, 2, 'one provider request per paragraph');
  for (const body of asked) {
    assert.equal(body.stream, true);
    assert.equal(body.response_format, 'pcm');
  }
  assert.deepEqual(asked.map((body) => body.input), ['Eerste alinea hier.', 'Tweede alinea daar.']);
  assert.equal(mimeType, 'audio/wav');
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(audio.subarray(8, 12).toString('ascii'), 'WAVE');
});

test('synthesize() still answers one mp3 request for a reply that fits in one segment', async () => {
  let asked = 0;
  const fetchImpl = async () => {
    asked += 1;
    return okAudioResponse(Buffer.from('one clip').toString('base64'));
  };
  const { audio, mimeType } = await mistralClient(fetchImpl).synthesize('Eén korte zin.');

  assert.equal(asked, 1);
  assert.equal(mimeType, 'audio/mpeg');
  assert.equal(audio.toString(), 'one clip');
});

test('the WAV wrapper writes a canonical PCM16 header around the concatenated stream', () => {
  // 0.6 s of deliberate silence between two one-sample segments, as stream() yields it.
  const gap = Buffer.alloc(Math.round((STREAM_SAMPLE_RATE * 600) / 1000) * 2);
  const body = Buffer.concat([Buffer.from([1, 0]), gap, Buffer.from([2, 0])]);
  const wav = wrapPcm16Wav([Buffer.from([1, 0]), gap, Buffer.from([2, 0])]);

  assert.equal(wav.length, 44 + body.length);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + body.length);
  assert.equal(wav.subarray(8, 16).toString('ascii'), 'WAVEfmt ');
  assert.equal(wav.readUInt32LE(16), 16, 'fmt chunk length');
  assert.equal(wav.readUInt16LE(20), 1, 'PCM');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(28), 24_000 * 2, 'byte rate');
  assert.equal(wav.readUInt16LE(32), 2, 'block align');
  assert.equal(wav.readUInt16LE(34), 16, 'bits per sample');
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(wav.readUInt32LE(40), body.length);
  assert.deepEqual(wav.subarray(44), body);
});

// --- Per-segment level matching ----------------------------------------------

/** A provider answering each streaming request with its own constant amplitude. */
function pcmProvider(amplitudes, samples = LEVEL_MIN_SPEECH_SAMPLES) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push(JSON.parse(init.body));
    const amplitude = amplitudes[Math.min(asked.length - 1, amplitudes.length - 1)];
    return sseResponse(
      sseEvent({ type: 'speech.audio.delta', audio_data: float32Buffer(Array(samples).fill(amplitude)).toString('base64') })
      + sseEvent({ type: 'speech.audio.done', usage: {} }),
    );
  };
  return { fetchImpl, asked };
}

/** RMS of PCM16LE, normalised to −1..1. */
function rmsOf(buffer) {
  const samples = Math.floor(buffer.length / 2);
  let sumSquares = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample = buffer.readInt16LE(index * 2) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

test('stream() brings a quiet second paragraph back to the level of the first, and leaves the first alone', async () => {
  const { fetchImpl } = pcmProvider([0.5, 0.25]);
  const pcm = await collect(mistralClient(fetchImpl).stream(TWO_PARAGRAPHS));
  const gap = Math.round((STREAM_SAMPLE_RATE * 600) / 1000) * 2;
  const perSegment = LEVEL_MIN_SPEECH_SAMPLES * 2;
  assert.equal(pcm.length, perSegment * 2 + gap, 'two segments and one paragraph pause');

  const first = rmsOf(pcm.subarray(0, perSegment));
  const second = rmsOf(pcm.subarray(perSegment + gap));
  assert.ok(Math.abs(first - 0.5) < 0.005, `the reference segment is untouched (was ${first})`);
  assert.ok(Math.abs(second - first) < 0.005, `the quiet segment was lifted to it (was ${second})`);
});

test('stream() stops matching at 12 dB rather than amplifying a near-silent segment without limit', async () => {
  const { fetchImpl } = pcmProvider([0.5, 0.02]);
  const pcm = await collect(mistralClient(fetchImpl).stream(TWO_PARAGRAPHS));
  const gap = Math.round((STREAM_SAMPLE_RATE * 600) / 1000) * 2;
  const perSegment = LEVEL_MIN_SPEECH_SAMPLES * 2;

  const first = rmsOf(pcm.subarray(0, perSegment));
  const second = rmsOf(pcm.subarray(perSegment + gap));
  // 0.02 is 28 dB below the reference: only 12 dB of that is corrected.
  assert.ok(Math.abs(second - 0.02 * 10 ** (12 / 20)) < 0.01, `clamped lift (was ${second})`);
  assert.ok(second < first, 'still quieter than the reference — the clamp held');
});

test('stream() leaves a segment exactly as the provider sent it when GAIA_TTS_LEVEL_MATCH is off', async () => {
  const { fetchImpl } = pcmProvider([0.5, 0.25]);
  const pcm = await collect(mistralClient(fetchImpl, { levelMatch: false }).stream(TWO_PARAGRAPHS));
  const gap = Math.round((STREAM_SAMPLE_RATE * 600) / 1000) * 2;
  const perSegment = LEVEL_MIN_SPEECH_SAMPLES * 2;

  assert.ok(Math.abs(rmsOf(pcm.subarray(perSegment + gap)) - 0.25) < 0.005, 'untouched');
});

test('level matching reads GAIA_TTS_LEVEL_MATCH through flags.js, defaulting to on', async () => {
  const gap = Math.round((STREAM_SAMPLE_RATE * 600) / 1000) * 2;
  const perSegment = LEVEL_MIN_SPEECH_SAMPLES * 2;

  const withFlag = async (env) => {
    const { fetchImpl } = pcmProvider([0.5, 0.25]);
    const tts = createMistralTts({
      baseUrl: 'http://test:1234/v1',
      model: 'voxtral-mini-tts-2603',
      fetchImpl,
      env,
    });
    const pcm = await collect(tts.stream(TWO_PARAGRAPHS));
    return rmsOf(pcm.subarray(perSegment + gap));
  };

  assert.ok(Math.abs(await withFlag({ GAIA_TTS_LEVEL_MATCH: 'off' }) - 0.25) < 0.005, 'off: untouched');
  assert.ok(Math.abs(await withFlag({}) - 0.5) < 0.005, 'unset: on by default');
  assert.ok(Math.abs(await withFlag({ GAIA_TTS_LEVEL_MATCH: 'on' }) - 0.5) < 0.005, 'on');
});

test('matchSegmentGain answers 1 for anything it cannot measure', () => {
  const quiet = createPcmMeter();
  quiet.push(pcm16(10, 0.4));
  assert.equal(quiet.isMeasurable(), false, 'ten samples are not a measurement');
  assert.equal(matchSegmentGain(0.5, quiet), 1);
  assert.equal(matchSegmentGain(null, quiet), 1);

  const loud = createPcmMeter();
  loud.push(pcm16(LEVEL_MIN_SPEECH_SAMPLES, 0.5));
  assert.equal(matchSegmentGain(0, loud), 1, 'no reference, no gain');
  assert.ok(Math.abs(matchSegmentGain(0.25, loud) - 0.5) < 0.01);
});

test('applyPcmGain clamps at the int16 bounds instead of wrapping around', () => {
  const source = Buffer.allocUnsafe(4);
  source.writeInt16LE(30_000, 0);
  source.writeInt16LE(-30_000, 2);
  const out = applyPcmGain(source, 2);

  assert.equal(out.readInt16LE(0), 32_767);
  assert.equal(out.readInt16LE(2), -32_768);
  assert.equal(applyPcmGain(source, 1), source, 'a gain of 1 passes the buffer through');
});
