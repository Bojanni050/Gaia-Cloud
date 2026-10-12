'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSttLog, DEFAULT_MAX_ENTRIES } = require('../src/speech/sttLog');

test('record stamps an entry and list returns it newest first', () => {
  const log = createSttLog();
  log.record({ provider: 'mistral', model: 'voxtral-mini-latest', bytes: 1234, outcome: 'ok', status: 200, durationMs: 40 });
  log.record({ provider: 'mistral', model: 'voxtral-mini-latest', bytes: 99, outcome: 'error', status: 502, durationMs: 10 });
  const [newest, oldest] = log.list();
  assert.equal(newest.outcome, 'error');
  assert.equal(oldest.outcome, 'ok');
  assert.ok(Date.parse(newest.at) > 0);
});

test('record NEVER keeps anything that could carry the user\'s voice or words', () => {
  const log = createSttLog();
  const stored = log.record({
    provider: 'mistral',
    bytes: 10,
    outcome: 'ok',
    text: 'what the user said',
    transcript: 'what the user said',
    preview: 'what the us',
    audio: Buffer.from('raw audio'),
    body: 'raw body',
    input: 'x',
    content: 'x',
  });
  const serialized = JSON.stringify(log.list());
  for (const word of ['what the user said', 'what the us', 'raw audio', 'raw body']) {
    assert.ok(!serialized.includes(word), `leaked: ${word}`);
  }
  for (const key of ['text', 'transcript', 'preview', 'audio', 'body', 'input', 'content']) {
    assert.ok(!(key in stored), `${key} must be stripped`);
  }
  assert.equal(stored.bytes, 10, 'operator-useful facts survive');
});

test('the caller\'s object is not mutated by the stripping', () => {
  const log = createSttLog();
  const entry = { text: 'x', bytes: 1 };
  log.record(entry);
  assert.equal(entry.text, 'x');
});

test('the buffer is capped and the default cap is a useful diagnostic tail', () => {
  assert.ok(DEFAULT_MAX_ENTRIES >= 20);
  const log = createSttLog({ maxEntries: 3 });
  for (let i = 0; i < 5; i += 1) log.record({ n: i });
  assert.deepEqual(log.list().map((e) => e.n), [4, 3, 2]);
  log.clear();
  assert.equal(log.list().length, 0);
});
