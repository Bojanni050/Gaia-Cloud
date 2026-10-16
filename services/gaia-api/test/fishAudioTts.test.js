'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createFishAudioTts,
  listVoices,
  listModels,
  originOf,
  mimeTypeFor,
  LANGUAGES,
} = require('../src/speech/fishAudioTts');

function audioResponse(bytes = Buffer.from('ID3 fake mp3')) {
  return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
}

test('originOf accepts the origin, /v1 and the full /v1/tts endpoint', () => {
  for (const raw of ['https://api.fish.audio', 'https://api.fish.audio/', 'https://api.fish.audio/v1', 'https://api.fish.audio/v1/tts', 'https://api.fish.audio/v1/tts/', '']) {
    assert.equal(originOf(raw), 'https://api.fish.audio');
  }
  assert.equal(originOf('https://proxy.test/fish/v1/tts'), 'https://proxy.test/fish');
});

test('synthesize posts to /v1/tts with Bearer auth, the model header and reference_id', async () => {
  let seen;
  const tts = createFishAudioTts({
    baseUrl: 'https://api.fish.audio/v1/tts',
    model: 's2.1-pro',
    authToken: 'key-1',
    voiceId: 'voice-1',
    fetchImpl: async (url, init) => { seen = { url, init }; return audioResponse(); },
  });
  const { audio, mimeType } = await tts.synthesize('Hallo');
  assert.equal(seen.url, 'https://api.fish.audio/v1/tts');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer key-1');
  assert.equal(seen.init.headers.model, 's2.1-pro');
  assert.deepEqual(JSON.parse(seen.init.body), { text: 'Hallo', format: 'mp3', reference_id: 'voice-1' });
  assert.equal(mimeType, 'audio/mpeg');
  assert.equal(audio.toString(), 'ID3 fake mp3');
});

test('the voice is optional: no reference_id is sent without one, a per-call voice wins', async () => {
  const bodies = [];
  const tts = createFishAudioTts({
    model: 'm',
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return audioResponse(); },
  });
  await tts.synthesize('x');
  await tts.synthesize('x', { voiceId: 'other' });
  assert.equal('reference_id' in bodies[0], false);
  assert.equal(bodies[1].reference_id, 'other');
});

test('a model is required to construct', () => {
  assert.throws(() => createFishAudioTts({}), /model/);
});

test('synthesize fails calmly on network errors, HTTP errors and empty audio', async () => {
  const make = (fetchImpl) => createFishAudioTts({ model: 'm', fetchImpl });
  await assert.rejects(make(async () => { throw new Error('boom'); }).synthesize('x'), /unreachable/);
  await assert.rejects(make(async () => ({ ok: false, status: 402 })).synthesize('x'), /responded with an error/);
  await assert.rejects(make(async () => audioResponse(Buffer.alloc(0))).synthesize('x'), /no audio/);
});

test('mimeTypeFor and LANGUAGES', () => {
  assert.equal(mimeTypeFor('mp3'), 'audio/mpeg');
  assert.equal(mimeTypeFor('pcm'), 'application/octet-stream');
  assert.ok(LANGUAGES.includes('en') && LANGUAGES.includes('nl'));
});

test('listVoices lists the own library: _id/title, deduped, paginated by total', async () => {
  const urls = [];
  const pages = [
    { total: 4, items: [{ _id: "a", title: "Aria" }, { _id: "a", title: "dup" }] },
    { total: 4, items: [{ _id: "b" }, {}] },
  ];
  const voices = await listVoices({
    baseUrl: 'https://api.fish.audio/v1/tts',
    authToken: 'k',
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(init.headers.Authorization, 'Bearer k');
      return { ok: true, json: async () => pages[urls.length - 1] };
    },
  });
  assert.deepEqual(voices, [{ id: 'a', name: 'Aria' }, { id: 'b', name: 'b' }]);
  assert.ok(urls[0].startsWith('https://api.fish.audio/model?self=true&page_size=100&page_number=1'));
  assert.equal(urls.length, 2);
});

test('listVoices surfaces the HTTP status', async () => {
  await assert.rejects(
    listVoices({ fetchImpl: async () => ({ ok: false, status: 401 }) }),
    (error) => error.status === 401
  );
});

test('listModels offers the selectable TTS models', () => {
  const ids = listModels().map((m) => m.id);
  assert.ok(ids.includes('s2.1-pro') && ids.includes('s2.1-pro-free'));
});

test('fishAudioTts.js has no code-level dependency on Hermes, the native generator, IntentIQ/ReasonIQ, the Decision Engine, the Orchestrator, or the Response Engine', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/speech/fishAudioTts.js'), 'utf-8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const name of ['hermes', 'gaiaGenerator', 'intentIQ', 'reasonIQ', 'decisionEngine', 'orchestrator', 'responseEngine']) {
    assert.ok(!codeOnly.toLowerCase().includes(name.toLowerCase()), `must not reference ${name}`);
  }
});
