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
    GAIA_TTS_VOICE_ID: 'Chloe',
  };
  const config = readTtsConfig(env);
  assert.equal(config.baseUrl, 'http://test:1234/v1');
  assert.equal(config.model, 'test-tts-model');
  assert.equal(config.authToken, 'test-token');
  assert.equal(config.format, 'pcm16');
  assert.equal(config.voiceDescription, 'a custom voice');
  assert.equal(config.voiceId, 'Chloe');
});

test('readTtsConfig defaults to wav format and the built-in Gaia voice description', () => {
  const config = readTtsConfig({});
  assert.equal(config.baseUrl, '');
  assert.equal(config.model, '');
  assert.equal(config.authToken, '');
  assert.equal(config.format, 'wav');
  assert.equal(config.voiceDescription, DEFAULT_VOICE_DESCRIPTION);
  assert.equal(config.voiceId, '');
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

test('LANGUAGES is Chinese/English only — the desktop gate reads this', () => {
  const { LANGUAGES } = require('../src/speech/mimoTts');
  assert.deepEqual(LANGUAGES, ['zh', 'en']);
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

// --- Built-in voices (mimo-v2.5-tts, the variant that streams) --------------

test("BUILT_IN_VOICES lists Xiaomi's named voices with the languages they speak", () => {
  const { BUILT_IN_VOICES } = require('../src/speech/mimoTts');
  const ids = BUILT_IN_VOICES.map((voice) => voice.id);
  assert.ok(ids.includes('mimo_default'));
  assert.ok(ids.includes('Mia'));
  assert.ok(ids.includes('Chloe'));
  for (const voice of BUILT_IN_VOICES) {
    assert.equal(typeof voice.id, 'string');
    assert.equal(typeof voice.name, 'string');
    assert.ok(Array.isArray(voice.languages) && voice.languages.length > 0);
    for (const language of voice.languages) assert.ok(['zh', 'en'].includes(language));
  }
  // The cluster decides what "default" actually is, so it is offered as both.
  assert.deepEqual(BUILT_IN_VOICES.find((voice) => voice.id === 'mimo_default').languages, ['zh', 'en']);
});

test("stream() is fixed to Xiaomi's splittable contract: pcm16, 24 kHz, mono", () => {
  const { STREAM_FORMAT, STREAM_SAMPLE_RATE, STREAM_CHANNELS } = require('../src/speech/mimoTts');
  assert.equal(STREAM_FORMAT, 'pcm16');
  assert.equal(STREAM_SAMPLE_RATE, 24000);
  assert.equal(STREAM_CHANNELS, 1);
  // The route tells clients how to read the bytes it writes.
  assert.equal(mimeTypeFor(STREAM_FORMAT), 'audio/L16');
});

test('synthesize() with a built-in voice sends audio.voice and drops the voice-design message', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from([1, 2]).toString('base64') } } }] }) };
  };
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'mimo-v2.5-tts', voiceId: 'Chloe', fetchImpl });
  assert.equal(tts.voice, 'Chloe');
  await tts.synthesize('hallo');
  // Built-in voice, designed format: still wav here — only streaming is pcm16.
  assert.deepEqual(sent.audio, { format: 'wav', voice: 'Chloe' });
  assert.deepEqual(sent.messages, [{ role: 'assistant', content: 'hallo' }]);
});

test('an unset voice id is never sent as audio.voice — the voicedesign variant would reject it', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { audio: { data: 'AAAA' } } }] }) };
  };
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'mimo-v2.5-tts-voicedesign', voiceId: '', fetchImpl });
  await tts.synthesize('hallo');
  assert.deepEqual(sent.audio, { format: 'wav' });
  assert.equal(sent.messages.length, 2);
});

// --- stream() ---------------------------------------------------------------

/** The provider's SSE body, as parts a reader may receive them. */
function sseStream(...parts) {
  return (async function* () {
    for (const part of parts) yield part;
  })();
}

/** One `data:` line carrying base64 PCM, the way MiMo sends audio. */
function audioEvent(pcm) {
  return `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm.toString('base64') } } }] })}\n\n`;
}

async function collect(generator) {
  const chunks = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

test('stream() posts stream:true with pcm16 and the built-in voice', async () => {
  let url;
  let sent;
  let headers;
  const fetchImpl = async (target, init) => {
    url = target;
    sent = JSON.parse(init.body);
    headers = init.headers;
    return { ok: true, body: sseStream(audioEvent(Buffer.from([1, 2, 3, 4]))) };
  };
  const tts = createMimoTts({ baseUrl: 'http://test/v1/', model: 'mimo-v2.5-tts', voiceId: 'Chloe', fetchImpl });
  const chunks = await collect(tts.stream('hallo'));
  assert.equal(url, 'http://test/v1/chat/completions');
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.audio, { format: 'pcm16', voice: 'Chloe' });
  assert.deepEqual(sent.messages, [{ role: 'assistant', content: 'hallo' }]);
  assert.equal(sent.model, 'mimo-v2.5-tts');
  assert.equal(headers.Accept, 'text/event-stream');
  assert.deepEqual(chunks, [Buffer.from([1, 2, 3, 4])]);
});

test('stream() yields decoded PCM in order and skips everything that is not audio', async () => {
  const first = Buffer.from([1, 2, 3, 4]);
  const second = Buffer.from([5, 6]);
  const fetchImpl = async () => ({
    ok: true,
    body: sseStream(
      ':\n\n',                                                          // comment keep-alive
      'data: \n\n',                                                     // empty payload
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',             // text delta, no audio
      audioEvent(first),
      'data: {not json\n\n',                                            // unparseable line
      audioEvent(second),
      'data: [DONE]\n\n',                                               // OpenAI's end marker
    ),
  });
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'mimo-v2.5-tts', fetchImpl });
  assert.deepEqual(await collect(tts.stream('hallo')), [first, second]);
});

test('stream() survives an event split across two reads — a read boundary is not a line boundary', async () => {
  const pcm = Buffer.from([9, 9, 9, 9]);
  const whole = Buffer.from(audioEvent(pcm), 'utf-8');
  const fetchImpl = async () => ({
    ok: true,
    body: sseStream(whole.subarray(0, 12), whole.subarray(12)),
  });
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'mimo-v2.5-tts', fetchImpl });
  assert.deepEqual(await collect(tts.stream('hallo')), [pcm]);
});

test('stream() is silent about the provider but calm to the caller when it is unreachable', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED 1.2.3.4:443 (api.xiaomimimo.com)'); };
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'mimo-v2.5-tts', fetchImpl });
  await assert.rejects(() => collect(tts.stream('hi')), (err) => {
    assert.match(err.message, /speech synthesis unreachable/);
    assert.ok(!err.message.includes('xiaomimimo'));
    assert.ok(!err.message.includes('1.2.3.4'));
    return true;
  });
});

test('stream() throws a calm error on a non-200 response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'mimo-v2.5-tts', fetchImpl });
  await assert.rejects(() => collect(tts.stream('hi')), (err) => {
    assert.match(err.message, /speech synthesis responded with an error/);
    assert.ok(!err.message.includes('401'));
    return true;
  });
});

test('stream() throws a calm error when the stream carries no audio at all', async () => {
  const fetchImpl = async () => ({ ok: true, body: sseStream('data: [DONE]\n\n') });
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'mimo-v2.5-tts', fetchImpl });
  await assert.rejects(() => collect(tts.stream('hi')), /speech synthesis returned no audio/);
});

test('stream() throws a calm error when the provider answers with an error event', async () => {
  const fetchImpl = async () => ({
    ok: true,
    body: sseStream(`data: ${JSON.stringify({ error: { message: 'quota exceeded for key sk-abc' } })}\n\n`),
  });
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'mimo-v2.5-tts', fetchImpl });
  await assert.rejects(() => collect(tts.stream('hi')), (err) => {
    assert.match(err.message, /speech synthesis responded with an error/);
    assert.ok(!err.message.includes('quota'));
    return true;
  });
});

test("stream() relays the caller's abort to the provider request and stays calm about it", async () => {
  const controller = new AbortController();
  let sawAborted = null;
  const fetchImpl = async (url, init) => {
    sawAborted = init.signal.aborted;
    const error = new Error('the operation was aborted');
    error.name = 'AbortError';
    throw error;
  };
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'mimo-v2.5-tts', fetchImpl });
  controller.abort();
  await assert.rejects(() => collect(tts.stream('hi', { signal: controller.signal })), (err) => {
    assert.match(err.message, /speech synthesis was cancelled/);
    assert.ok(!err.message.includes('http://test'));
    return true;
  });
  // The listener is gone: the provider request must not keep running.
  assert.equal(sawAborted, true);
});

test('stream() stops pulling from the provider the moment the caller stops listening', async () => {
  let reads = 0;
  const body = (async function* () {
    for (;;) {
      reads += 1;
      yield audioEvent(Buffer.from([reads & 0xff]));
    }
  })();
  const fetchImpl = async () => ({ ok: true, body });
  const tts = createMimoTts({ baseUrl: 'http://test', model: 'mimo-v2.5-tts', fetchImpl });
  const generator = tts.stream('hallo');
  const first = await generator.next();
  assert.equal(first.done, false);
  await generator.return(); // exactly what a `break` in a for-await loop does
  const readsAtClose = reads;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reads, readsAtClose);
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
