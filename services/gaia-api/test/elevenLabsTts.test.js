'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createElevenLabsTts,
  listVoices,
  listModels,
  normalizeFormat,
  mimeTypeFor,
  LANGUAGES,
} = require('../src/speech/elevenLabsTts');

function audioResponse(bytes = Buffer.from('ID3 fake mp3')) {
  return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
}

test('synthesize posts text + model_id to the voice path with xi-api-key and returns audio', async () => {
  let seen;
  const tts = createElevenLabsTts({
    model: 'eleven_multilingual_v2',
    authToken: 'key-1',
    voiceId: 'voice/1',
    fetchImpl: async (url, init) => { seen = { url, init }; return audioResponse(); },
  });
  const { audio, mimeType } = await tts.synthesize('Hallo');
  assert.equal(seen.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice%2F1?output_format=mp3_44100_128');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['xi-api-key'], 'key-1');
  assert.deepEqual(JSON.parse(seen.init.body), { text: 'Hallo', model_id: 'eleven_multilingual_v2' });
  assert.equal(mimeType, 'audio/mpeg');
  assert.equal(audio.toString(), 'ID3 fake mp3');
});

test('a per-call voiceId wins, a custom baseUrl is honoured', async () => {
  let url;
  const tts = createElevenLabsTts({
    baseUrl: 'https://api.eu.residency.elevenlabs.io/v1/',
    model: 'm',
    voiceId: 'default',
    fetchImpl: async (u) => { url = u; return audioResponse(); },
  });
  await tts.synthesize('x', { voiceId: 'other' });
  assert.ok(url.startsWith('https://api.eu.residency.elevenlabs.io/v1/text-to-speech/other?'));
});

test('a model is required to construct', () => {
  assert.throws(() => createElevenLabsTts({}), /model/);
});

test('with no voice configured it speaks with the default voice', async () => {
  let url;
  const tts = createElevenLabsTts({ model: 'm', fetchImpl: async (u) => { url = u; return audioResponse(); } });
  await tts.synthesize('x');
  assert.ok(url.includes('/text-to-speech/kLhAstPcnnPxqzk6gS5i?'));
});

test('a full text-to-speech URL as base URL yields base + voice', async () => {
  let url;
  const tts = createElevenLabsTts({
    baseUrl: 'https://api.elevenlabs.io/v1/text-to-speech/abc123',
    model: 'm',
    fetchImpl: async (u) => { url = u; return audioResponse(); },
  });
  await tts.synthesize('x');
  assert.ok(url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/abc123?'));
});

test('synthesize fails calmly on network errors, HTTP errors and empty audio', async () => {
  const make = (fetchImpl) => createElevenLabsTts({ model: 'm', voiceId: 'v', fetchImpl });
  await assert.rejects(make(async () => { throw new Error('boom'); }).synthesize('x'), /unreachable/);
  await assert.rejects(make(async () => ({ ok: false, status: 401 })).synthesize('x'), /responded with an error/);
  await assert.rejects(make(async () => audioResponse(Buffer.alloc(0))).synthesize('x'), /no audio/);
});

test('format helpers keep playable containers and reject raw ones', () => {
  assert.equal(normalizeFormat('opus_48000_64'), 'opus_48000_64');
  assert.equal(normalizeFormat('pcm_16000'), 'mp3_44100_128');
  assert.equal(normalizeFormat(undefined), 'mp3_44100_128');
  assert.equal(mimeTypeFor('mp3_44100_128'), 'audio/mpeg');
  assert.equal(mimeTypeFor('pcm_16000'), 'application/octet-stream');
});

test('LANGUAGES includes English and Dutch', () => {
  assert.ok(LANGUAGES.includes('en'));
  assert.ok(LANGUAGES.includes('nl'));
});

test('listVoices maps voice_id/name and dedupes', async () => {
  const voices = await listVoices({
    authToken: 'k',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.elevenlabs.io/v1/voices');
      assert.equal(init.headers['xi-api-key'], 'k');
      return { ok: true, json: async () => ({ voices: [{ voice_id: 'a', name: 'Aria' }, { voice_id: 'a', name: 'dup' }, { voice_id: 'b' }, {}] }) };
    },
  });
  assert.deepEqual(voices, [{ id: 'a', name: 'Aria' }, { id: 'b', name: 'b' }]);
});

test('listVoices surfaces the HTTP status', async () => {
  await assert.rejects(
    listVoices({ fetchImpl: async () => ({ ok: false, status: 401 }) }),
    (error) => error.status === 401
  );
});

test('listModels keeps only text-to-speech models', async () => {
  const models = await listModels({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true },
        { model_id: 'eleven_english_sts_v2', name: 'STS', can_do_text_to_speech: false },
      ],
    }),
  });
  assert.deepEqual(models.map((m) => m.id), ['eleven_multilingual_v2']);
  await assert.rejects(listModels({ fetchImpl: async () => ({ ok: false, status: 401 }) }), /authentication failed/);
});

test('elevenLabsTts.js has no code-level dependency on Hermes, the native generator, IntentIQ/ReasonIQ, the Decision Engine, the Orchestrator, or the Response Engine', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/speech/elevenLabsTts.js'), 'utf-8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const name of ['hermes', 'gaiaGenerator', 'intentIQ', 'reasonIQ', 'decisionEngine', 'orchestrator', 'responseEngine']) {
    assert.ok(!codeOnly.toLowerCase().includes(name.toLowerCase()), `must not reference ${name}`);
  }
});
