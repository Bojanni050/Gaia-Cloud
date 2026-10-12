'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createEleosIntentStore } = require('../src/eleosIntentStore');
const { createEleosRuntime, hourInTz, isQuietHour, titleFromLoop } = require('../src/eleosRuntime');

function build({ nowIso, voice } = {}) {
  const store = createEleosIntentStore({
    intentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-eleos-rt-')),
    now: () => new Date(nowIso || '2026-10-05T12:00:00Z'),
  });
  const saved = [];
  const historyStore = {
    saved,
    saveConversation(id, messages, options) { saved.push({ id, messages, options }); },
    getConversation() { return { messages: [{ role: 'user', content: 'oude boodschap' }] }; },
  };
  const runtime = createEleosRuntime({
    store,
    voice: voice || { open: async () => 'Hoi Bo, hoe gaat het nu?' },
    historyStore,
    activeMs: 5 * 60 * 1000,
    quietStartHour: 22,
    quietEndHour: 8,
    timezone: 'UTC',
    maxPerDay: 1,
    tickMs: 0,
  });
  return { store, runtime, historyStore, saved };
}

const pending = (store, iso = '2026-10-05T00:00:00Z') =>
  store.create({ conversationId: 'c1', kind: 'sadness', summary: 'Bo had een zware week', dueAt: iso });

test('hourInTz and isQuietHour compute the quiet window with an overnight wrap', () => {
  assert.equal(hourInTz(new Date('2026-10-05T23:30:00Z'), 'UTC'), 23);
  assert.equal(isQuietHour(23, 22, 8), true);
  assert.equal(isQuietHour(3, 22, 8), true);
  assert.equal(isQuietHour(8, 22, 8), false);
  assert.equal(isQuietHour(12, 22, 8), false);
  assert.equal(isQuietHour(12, 8, 22), true);
  assert.equal(isQuietHour(12, 22, 22), false);
});

test('evaluate: idle daytime delivers; active daytime is not an interruption', () => {
  const { store, runtime } = build();
  const loop = pending(store);
  const daytime = new Date('2026-10-05T12:00:00Z');
  assert.equal(runtime.evaluate(loop, daytime).deliver, true);

  runtime.recordActivity(daytime);
  assert.deepEqual(runtime.evaluate(loop, daytime), { deliver: false, reason: 'active' });
});

test('evaluate: quiet hours wait — unless the person is active at night', () => {
  const { store, runtime } = build();
  const loop = pending(store);
  const night = new Date('2026-10-05T03:00:00Z');
  assert.deepEqual(runtime.evaluate(loop, night), { deliver: false, reason: 'quiet-hours' });

  runtime.recordActivity(night);
  assert.equal(runtime.evaluate(loop, night).deliver, true);
});

test('evaluate: the daily cap suppresses a second check-in', () => {
  const { store, runtime } = build();
  const first = pending(store);
  store.markDelivered(first.id, { at: new Date('2026-10-05T09:00:00Z') });
  const second = pending(store);
  assert.deepEqual(runtime.evaluate(second, new Date('2026-10-05T12:00:00Z')), { deliver: false, reason: 'daily-cap' });
  // A day later the cap no longer applies.
  assert.equal(runtime.evaluate(second, new Date('2026-10-06T12:00:00Z')).deliver, true);
});

test('tick delivers a due loop into a NEW conversation and marks it delivered', async () => {
  const { store, runtime, saved } = build();
  const loop = pending(store);
  const results = await runtime.tick(new Date('2026-10-05T12:00:00Z'));

  assert.deepEqual(results, [{ delivered: loop.id, conversationId: `eleos-${loop.id}` }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, `eleos-${loop.id}`);
  assert.equal(saved[0].messages[0].role, 'assistant');
  assert.equal(saved[0].messages[0].content, 'Hoi Bo, hoe gaat het nu?');
  assert.equal(saved[0].options.title, 'Bo had een zware week');
  assert.equal(store.get(loop.id).status, 'delivered');
});

test('tick defers a loop it may not deliver, without losing it', async () => {
  const { store, runtime, saved } = build();
  const loop = pending(store);
  const results = await runtime.tick(new Date('2026-10-05T03:00:00Z')); // quiet, idle

  assert.deepEqual(results, [{ id: loop.id, deferred: 'quiet-hours' }]);
  assert.equal(saved.length, 0);
  assert.equal(store.get(loop.id).status, 'pending');
  assert.ok(new Date(store.get(loop.id).dueAt) > new Date('2026-10-05T03:00:00Z'));
});

test('tick never throws when the voice or history store is missing', async () => {
  const store = createEleosIntentStore({ intentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-eleos-rt-')) });
  pending(store);
  const noVoice = createEleosRuntime({ store, historyStore: { saveConversation() {} }, tickMs: 0 });
  assert.deepEqual(await noVoice.tick(new Date('2026-10-05T12:00:00Z')), [{ skipped: 'no-voice' }]);
});

test('titleFromLoop trims a long summary', () => {
  assert.equal(titleFromLoop({ summary: 'kort' }), 'kort');
  assert.equal(titleFromLoop({ summary: 'x'.repeat(80) }).length, 61);
  assert.equal(titleFromLoop({}), 'Even terugkomen');
});
