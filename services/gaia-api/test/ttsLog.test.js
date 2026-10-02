'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTtsLog, DEFAULT_MAX_ENTRIES } = require('../src/speech/ttsLog');

test('record stores entries newest-first with a timestamp', () => {
  const log = createTtsLog();
  log.record({ outcome: 'ok', status: 200 });
  log.record({ outcome: 'error', status: 502 });
  const entries = log.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].outcome, 'error');
  assert.equal(entries[1].outcome, 'ok');
  assert.ok(typeof entries[0].at === 'string' && entries[0].at !== '');
});

test('record caps the buffer at maxEntries, dropping the oldest', () => {
  const log = createTtsLog({ maxEntries: 3 });
  for (let i = 1; i <= 5; i++) log.record({ outcome: 'ok', n: i });
  const entries = log.list();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.n), [5, 4, 3]);
});

test('the default cap holds a useful diagnostic tail', () => {
  assert.ok(DEFAULT_MAX_ENTRIES >= 20);
});

test('list returns a copy — callers cannot mutate the buffer', () => {
  const log = createTtsLog();
  log.record({ outcome: 'ok' });
  log.list().length = 0;
  assert.equal(log.list().length, 1);
});

test('clear empties the buffer', () => {
  const log = createTtsLog();
  log.record({ outcome: 'ok' });
  log.clear();
  assert.deepEqual(log.list(), []);
});
