'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createConversationStore,
  isValidId,
  deriveTitle,
  InvalidConversationIdError,
  ConversationNotFoundError,
} = require('../src/conversationStore');

function tempStore() {
  const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-history-'));
  return createConversationStore({ historyDir });
}

// --- isValidId (path-traversal defense) -----------------------------------

test('isValidId accepts plain alphanumeric/dash/underscore ids', () => {
  assert.equal(isValidId('1755-1'), true);
  assert.equal(isValidId('a_b-C9'), true);
});

test('isValidId rejects anything that could touch the filesystem outside its own directory', () => {
  assert.equal(isValidId('../escape'), false);
  assert.equal(isValidId('a/b'), false);
  assert.equal(isValidId('a\\b'), false);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId(null), false);
  assert.equal(isValidId(42), false);
  assert.equal(isValidId('x'.repeat(200)), false);
});

// --- deriveTitle ------------------------------------------------------------

test('deriveTitle uses the first user message, trimmed and collapsed', () => {
  assert.equal(deriveTitle([{ role: 'user', content: '  hello   there  ' }]), 'hello there');
});

test('deriveTitle truncates long titles', () => {
  const long = 'x'.repeat(100);
  const title = deriveTitle([{ role: 'user', content: long }]);
  assert.ok(title.length < long.length);
  assert.ok(title.endsWith('…'));
});

test('deriveTitle falls back to "Untitled" with no user message', () => {
  assert.equal(deriveTitle([]), 'Untitled');
  assert.equal(deriveTitle([{ role: 'assistant', content: 'hi' }]), 'Untitled');
});

// --- saveConversation / getConversation / listConversations / deleteConversation --

test('saveConversation rejects an invalid id', () => {
  const store = tempStore();
  assert.throws(() => store.saveConversation('../escape', [{ role: 'user', content: 'hi' }]), InvalidConversationIdError);
});

test('saveConversation with an empty message array is a no-op', () => {
  const store = tempStore();
  store.saveConversation('conv-1', []);
  assert.deepEqual(store.listConversations(), []);
});

test('saveConversation then getConversation round-trips the transcript and derives a title', () => {
  const store = tempStore();
  const messages = [
    { role: 'user', content: 'Why is my website crashing?' },
    { role: 'assistant', content: 'Let\'s look at the logs.' },
  ];
  store.saveConversation('conv-1', messages);

  const { meta, messages: read } = store.getConversation('conv-1');
  assert.equal(meta.id, 'conv-1');
  assert.equal(meta.title, 'Why is my website crashing?');
  assert.equal(meta.messageCount, 2);
  assert.ok(meta.createdAt);
  assert.ok(meta.updatedAt);
  assert.deepEqual(read.map(({ role, content }) => ({ role, content })), messages);
  assert.ok(read.every((m) => typeof m.createdAt === 'string' && m.createdAt));
});

test('saveConversation keeps a per-turn createdAt the client supplied', () => {
  const store = tempStore();
  store.saveConversation('conv-1', [
    { role: 'user', content: 'hi', createdAt: '2026-10-03T10:15:00.000Z' },
    { role: 'assistant', content: 'hello', createdAt: '2026-10-03T10:15:04.000Z' },
  ]);
  const { messages } = store.getConversation('conv-1');
  assert.equal(messages[0].createdAt, '2026-10-03T10:15:00.000Z');
  assert.equal(messages[1].createdAt, '2026-10-03T10:15:04.000Z');
});

test('saveConversation stamps a message that arrives without a createdAt', () => {
  const store = tempStore();
  store.saveConversation('conv-1', [{ role: 'user', content: 'hi' }]);
  const { messages } = store.getConversation('conv-1');
  assert.ok(!Number.isNaN(Date.parse(messages[0].createdAt)));
});

test('saveConversation reuses the stored time for an unchanged message and stamps a new one', () => {
  const store = tempStore();
  store.saveConversation('conv-1', [
    { role: 'user', content: 'first', createdAt: '2026-10-03T10:15:00.000Z' },
    { role: 'assistant', content: 'first reply', createdAt: '2026-10-03T10:15:05.000Z' },
  ]);

  // A client that doesn't send times re-sends the history and appends a turn.
  store.saveConversation('conv-1', [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: 'second' },
  ]);
  const { messages } = store.getConversation('conv-1');
  assert.equal(messages[0].createdAt, '2026-10-03T10:15:00.000Z');
  assert.equal(messages[1].createdAt, '2026-10-03T10:15:05.000Z');
  assert.ok(!Number.isNaN(Date.parse(messages[2].createdAt)));
});

test('saveConversation ignores an unparseable client createdAt and stamps the turn instead', () => {
  const store = tempStore();
  store.saveConversation('conv-1', [{ role: 'user', content: 'hi', createdAt: 'not a date' }]);
  const { messages } = store.getConversation('conv-1');
  assert.ok(!Number.isNaN(Date.parse(messages[0].createdAt)));
});

test('saveConversation strips any extra client-side fields down to role/content/createdAt', () => {
  const store = tempStore();
  store.saveConversation('conv-1', [{ id: 'local-1', role: 'user', content: 'hi', failed: false }]);
  const { messages } = store.getConversation('conv-1');
  assert.deepEqual(Object.keys(messages[0]).sort(), ['content', 'createdAt', 'role']);
});

test('saveConversation called again overwrites messages and keeps the original title/createdAt', () => {
  const store = tempStore();
  store.saveConversation('conv-1', [{ role: 'user', content: 'first message here' }]);
  const first = store.getConversation('conv-1').meta;

  store.saveConversation('conv-1', [
    { role: 'user', content: 'first message here' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'a follow-up' },
  ]);
  const second = store.getConversation('conv-1').meta;

  assert.equal(second.title, first.title);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.messageCount, 3);
  assert.ok(second.updatedAt >= first.updatedAt);
});

test('getConversation throws ConversationNotFoundError for an unknown id', () => {
  const store = tempStore();
  assert.throws(() => store.getConversation('does-not-exist'), ConversationNotFoundError);
});

test('getConversation throws InvalidConversationIdError for a malformed id, without touching the filesystem', () => {
  const store = tempStore();
  assert.throws(() => store.getConversation('../../etc/passwd'), InvalidConversationIdError);
});

test('listConversations returns all saved conversations, newest first', () => {
  const store = tempStore();
  store.saveConversation('conv-a', [{ role: 'user', content: 'a' }]);
  store.saveConversation('conv-b', [{ role: 'user', content: 'b' }]);
  const list = store.listConversations();
  assert.equal(list.length, 2);
  assert.ok(list.some((c) => c.id === 'conv-a'));
  assert.ok(list.some((c) => c.id === 'conv-b'));
});

test('listConversations returns [] when the history directory does not exist yet', () => {
  const historyDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-history-')), 'not-created');
  const store = createConversationStore({ historyDir });
  assert.deepEqual(store.listConversations(), []);
});

test('listConversations skips a directory with no readable meta.json rather than failing', () => {
  const store = tempStore();
  store.saveConversation('conv-good', [{ role: 'user', content: 'ok' }]);
  fs.mkdirSync(path.join(store.historyDir, 'corrupted'));
  const list = store.listConversations();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'conv-good');
});

test('deleteConversation removes the conversation entirely', () => {
  const store = tempStore();
  store.saveConversation('conv-1', [{ role: 'user', content: 'gone soon' }]);
  store.deleteConversation('conv-1');
  assert.throws(() => store.getConversation('conv-1'), ConversationNotFoundError);
  assert.deepEqual(store.listConversations(), []);
});

test('deleteConversation throws ConversationNotFoundError for an unknown id', () => {
  const store = tempStore();
  assert.throws(() => store.deleteConversation('does-not-exist'), ConversationNotFoundError);
});

test('deleteConversation throws InvalidConversationIdError for a malformed id', () => {
  const store = tempStore();
  assert.throws(() => store.deleteConversation('../escape'), InvalidConversationIdError);
});

// --- events (push notifications for historyRoutes.js's SSE endpoint) -----

test('saveConversation emits "changed" on the store\'s events emitter', () => {
  const store = tempStore();
  let fired = 0;
  store.events.on('changed', () => { fired += 1; });
  store.saveConversation('conv-1', [{ role: 'user', content: 'hi' }]);
  assert.equal(fired, 1);
});

test('saveConversation with an empty message array does not emit "changed" (it is a no-op)', () => {
  const store = tempStore();
  let fired = 0;
  store.events.on('changed', () => { fired += 1; });
  store.saveConversation('conv-1', []);
  assert.equal(fired, 0);
});

test('deleteConversation emits "changed" on the store\'s events emitter', () => {
  const store = tempStore();
  store.saveConversation('conv-1', [{ role: 'user', content: 'hi' }]);
  let fired = 0;
  store.events.on('changed', () => { fired += 1; });
  store.deleteConversation('conv-1');
  assert.equal(fired, 1);
});
