'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMistralStt,
  isConfigured,
  audioMimeType,
  normalizeLanguage,
  LANGUAGES,
  MAX_AUDIO_BYTES,
} = require('../src/speech/mistralStt');

const BASE = 'http://fake-stt.internal/v1';
const AUDIO = Buffer.from('RIFF....WAVEfake-audio');

function okResponse(body = { text: 'hallo daar', language: 'nl' }) {
  return { ok: true, json: async () => body };
}

/** Captures the one fetch call so the multipart form can be inspected. */
function capture(response = okResponse()) {
  const seen = {};
  const fetchImpl = async (url, options) => {
    seen.url = String(url);
    seen.options = options;
    return typeof response === 'function' ? response() : response;
  };
  return { seen, fetchImpl };
}

// --- Configuration ----------------------------------------------------------

test('isConfigured needs both a base URL and a model', () => {
  assert.equal(isConfigured({ baseUrl: BASE, model: 'voxtral-mini-latest' }), true);
  assert.equal(isConfigured({ baseUrl: BASE, model: '' }), false);
  assert.equal(isConfigured({ baseUrl: '', model: 'm' }), false);
  assert.equal(isConfigured(null), false);
});

test('createMistralStt requires a base URL and a model', () => {
  assert.throws(() => createMistralStt({ model: 'm' }), /GAIA_STT_BASE_URL/);
  assert.throws(() => createMistralStt({ baseUrl: BASE }), /GAIA_STT_MODEL/);
});

test('Dutch is among the advertised languages, and the upload limit is a sane size', () => {
  assert.ok(LANGUAGES.includes('nl'));
  assert.ok(LANGUAGES.includes('en'));
  assert.ok(MAX_AUDIO_BYTES >= 512 * 1024 && MAX_AUDIO_BYTES <= 8 * 1024 * 1024);
});

// --- Request shape ------------------------------------------------------------

test('transcribe posts a multipart form to /audio/transcriptions with the model, the file and the key', async () => {
  const { seen, fetchImpl } = capture();
  const stt = createMistralStt({ baseUrl: `${BASE}/`, model: 'voxtral-mini-latest', authToken: 'secret-key', fetchImpl });

  const result = await stt.transcribe(AUDIO, { mimeType: 'audio/wav' });

  assert.equal(seen.url, `${BASE}/audio/transcriptions`, 'trailing slash on the base URL is tolerated');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers.Authorization, 'Bearer secret-key');
  assert.ok(!('Content-Type' in seen.options.headers), 'fetch must set the multipart boundary itself');
  assert.ok(seen.options.body instanceof FormData);
  assert.equal(seen.options.body.get('model'), 'voxtral-mini-latest');
  const file = seen.options.body.get('file');
  assert.equal(file.type, 'audio/wav');
  assert.equal(file.name, 'utterance.wav');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), AUDIO.toString());
  assert.equal(seen.options.body.get('language'), null, 'no hint is sent when none is given');
  assert.deepEqual(result, { text: 'hallo daar', language: 'nl' });
});

test('transcribe sends no Authorization header when no key is configured', async () => {
  const { seen, fetchImpl } = capture();
  await createMistralStt({ baseUrl: BASE, model: 'm', fetchImpl }).transcribe(AUDIO);
  assert.ok(!('Authorization' in seen.options.headers));
});

test('a valid language hint is forwarded, a malformed one is dropped', async () => {
  let c = capture();
  await createMistralStt({ baseUrl: BASE, model: 'm', fetchImpl: c.fetchImpl }).transcribe(AUDIO, { language: 'NL' });
  assert.equal(c.seen.options.body.get('language'), 'nl');

  c = capture();
  await createMistralStt({ baseUrl: BASE, model: 'm', fetchImpl: c.fetchImpl }).transcribe(AUDIO, { language: 'nl; DROP TABLE' });
  assert.equal(c.seen.options.body.get('language'), null);
});

test('the file keeps its real audio type and a matching extension', async () => {
  const c = capture();
  await createMistralStt({ baseUrl: BASE, model: 'm', fetchImpl: c.fetchImpl }).transcribe(AUDIO, { mimeType: 'audio/webm;codecs=opus' });
  const file = c.seen.options.body.get('file');
  assert.equal(file.type, 'audio/webm');
  assert.equal(file.name, 'utterance.webm');
});

test('audioMimeType falls back to wav for missing or non-audio types', () => {
  assert.equal(audioMimeType(undefined), 'audio/wav');
  assert.equal(audioMimeType('application/json'), 'audio/wav');
  assert.equal(audioMimeType('Audio/WAV; charset=binary'), 'audio/wav');
  assert.equal(audioMimeType('audio/mpeg'), 'audio/mpeg');
});

test('normalizeLanguage accepts only 2 or 3 letter codes', () => {
  assert.equal(normalizeLanguage('nl'), 'nl');
  assert.equal(normalizeLanguage(' EN '), 'en');
  assert.equal(normalizeLanguage('nld'), 'nld');
  assert.equal(normalizeLanguage('nl-NL'), undefined);
  assert.equal(normalizeLanguage(''), undefined);
  assert.equal(normalizeLanguage(undefined), undefined);
});

// --- Responses ----------------------------------------------------------------

test('transcribe trims the text and reports the detected language', async () => {
  const { fetchImpl } = capture(okResponse({ text: '  een twee drie \n', language: 'nl' }));
  const result = await createMistralStt({ baseUrl: BASE, model: 'm', fetchImpl }).transcribe(AUDIO);
  assert.deepEqual(result, { text: 'een twee drie', language: 'nl' });
});

test('empty text is a valid answer (silence or noise), not an error', async () => {
  const { fetchImpl } = capture(okResponse({ text: '' }));
  const result = await createMistralStt({ baseUrl: BASE, model: 'm', fetchImpl }).transcribe(AUDIO);
  assert.deepEqual(result, { text: '', language: null });
});

// --- Calm failures --------------------------------------------------------------

async function rejection(fetchImpl) {
  const originalError = console.error;
  console.error = () => {};
  try {
    await createMistralStt({ baseUrl: BASE, model: 'm', authToken: 'secret-key', fetchImpl }).transcribe(AUDIO);
  } catch (error) {
    return error;
  } finally {
    console.error = originalError;
  }
  assert.fail('expected transcribe to reject');
}

test('an unreachable provider fails calmly, never leaking the endpoint or key', async () => {
  const error = await rejection(async () => { throw new Error(`connect ECONNREFUSED ${BASE} secret-key`); });
  assert.equal(error.message, 'speech recognition unreachable');
});

test('a provider error status fails calmly', async () => {
  const error = await rejection(async () => ({ ok: false, status: 401, json: async () => ({ message: 'bad key secret-key' }) }));
  assert.equal(error.message, 'speech recognition responded with an error');
  assert.ok(!error.message.includes('secret-key'));
});

test('an unreadable response fails calmly', async () => {
  const error = await rejection(async () => ({ ok: true, json: async () => { throw new Error('not json'); } }));
  assert.equal(error.message, 'speech recognition returned an unreadable response');
});

test('a response without a text field fails calmly', async () => {
  const error = await rejection(async () => okResponse({ something: 'else' }));
  assert.equal(error.message, 'speech recognition returned no text');
});

test('the client logs failures without ever logging the audio, text or key', async () => {
  const lines = [];
  const originalError = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await createMistralStt({ baseUrl: BASE, model: 'm', authToken: 'secret-key', fetchImpl: async () => { throw new Error('boom'); } })
      .transcribe(AUDIO).catch(() => {});
  } finally {
    console.error = originalError;
  }
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(!line.includes('secret-key'));
    assert.ok(!line.includes('fake-audio'));
  }
});

// --- Architectural invariant: no cognitive dependencies ---------------------------

test('mistralStt.js has no code-level dependency on Hermes, the native generator, IntentIQ/ReasonIQ, the Decision Engine, the Orchestrator, or the Response Engine', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/speech/mistralStt.js'), 'utf-8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const forbidden = [
    'hermesClient', 'gaiaGenerator', 'intentIQ', 'reasonIQ',
    'decisionEngine', 'orchestrator', 'responseEngine',
  ];
  for (const name of forbidden) {
    assert.ok(!codeOnly.includes(name), `mistralStt.js must not reference ${name}`);
  }
});

test('mistralStt.js never writes audio anywhere: it does not import fs or touch the filesystem', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/speech/mistralStt.js'), 'utf-8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!/require\(['"](node:)?fs['"]\)/.test(codeOnly));
  assert.ok(!/writeFile|createWriteStream/.test(codeOnly));
});
