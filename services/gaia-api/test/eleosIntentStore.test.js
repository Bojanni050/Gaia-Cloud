'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createEleosIntentStore } = require('../src/eleosIntentStore');

function tempStore() {
  return createEleosIntentStore({ intentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-eleos-')) });
}

const at = (iso) => () => new Date(iso);

test('creates a pending loop and reads it back', () => {
  const store = tempStore();
  const loop = store.create({ conversationId: 'c1', kind: 'sadness', summary: 'Bo had een zware week', groundingQuote: 'ik voel me rot', dueAt: '2026-10-05T09:00:00Z' });
  assert.equal(loop.status, 'pending');
  assert.equal(store.get(loop.id).summary, 'Bo had een zware week');
  assert.equal(store.listPending().length, 1);
});

test('survives a new store instance over the same directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-eleos-'));
  const first = createEleosIntentStore({ intentsDir: dir });
  const loop = first.create({ conversationId: 'c1', kind: 'other', summary: 'x', dueAt: '2026-10-05T09:00:00Z' });
  const second = createEleosIntentStore({ intentsDir: dir });
  assert.equal(second.get(loop.id).summary, 'x');
});

test('listDue only returns pending loops whose moment has arrived', () => {
  const store = tempStore();
  store.create({ conversationId: 'c1', summary: 'past', dueAt: '2026-10-01T00:00:00Z' });
  store.create({ conversationId: 'c2', summary: 'future', dueAt: '2026-12-01T00:00:00Z' });
  const due = store.listDue(new Date('2026-10-05T00:00:00Z'));
  assert.deepEqual(due.map((l) => l.summary), ['past']);
});

test('pendingForConversation finds the one open loop for a conversation', () => {
  const store = tempStore();
  const loop = store.create({ conversationId: 'c1', summary: 'x', dueAt: '2026-10-05T00:00:00Z' });
  assert.equal(store.pendingForConversation('c1').id, loop.id);
  assert.equal(store.pendingForConversation('c2'), null);
});

test('markDelivered moves a loop out of pending and onto the delivered list', () => {
  const store = createEleosIntentStore({ intentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-eleos-')), now: at('2026-10-05T10:00:00Z') });
  const loop = store.create({ conversationId: 'c1', summary: 'x', dueAt: '2026-10-05T00:00:00Z' });
  store.markDelivered(loop.id, { deliveredConversationId: 'eleos-1' });
  const updated = store.get(loop.id);
  assert.equal(updated.status, 'delivered');
  assert.equal(updated.deliveredConversationId, 'eleos-1');
  assert.equal(updated.deliveredAt, '2026-10-05T10:00:00.000Z');
  assert.deepEqual(store.listPending(), []);
  assert.deepEqual(store.listUndelivered().map((l) => l.id), [loop.id]);
});

test('acknowledging a delivered loop removes it from the undelivered list', () => {
  const store = tempStore();
  const loop = store.create({ conversationId: 'c1', summary: 'x', dueAt: '2026-10-05T00:00:00Z' });
  store.markDelivered(loop.id);
  store.markAcknowledged(loop.id);
  assert.deepEqual(store.listUndelivered(), []);
  assert.ok(store.get(loop.id).acknowledgedAt);
});

test('countDeliveredSince counts within the rolling window', () => {
  const store = createEleosIntentStore({ intentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-eleos-')), now: at('2026-10-05T10:00:00Z') });
  const a = store.create({ conversationId: 'c1', summary: 'a', dueAt: '2026-10-05T00:00:00Z' });
  const b = store.create({ conversationId: 'c2', summary: 'b', dueAt: '2026-10-05T00:00:00Z' });
  store.markDelivered(a.id, { at: new Date('2026-10-05T01:00:00Z') });
  store.markDelivered(b.id, { at: new Date('2026-10-04T01:00:00Z') });
  assert.equal(store.countDeliveredSince(new Date('2026-10-04T12:00:00Z')), 1);
});
