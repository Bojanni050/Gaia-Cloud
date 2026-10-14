'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_TITLE_CHARS,
  buildTitleMessages,
  parseTitle,
  generateConversationTitle,
  withDeadline,
} = require('../src/conversationTitle');

// --- parseTitle (the model's answer, as a name) -----------------------------

test('parseTitle takes the first non-empty line', () => {
  assert.equal(parseTitle('\n  VPS omzetten naar Tailscale\n\nLaat maar weten.'), 'VPS omzetten naar Tailscale');
});

test('parseTitle drops a prefix and surrounding quotes a model adds anyway', () => {
  assert.equal(parseTitle('Title: "VPS omzetten naar Tailscale"'), 'VPS omzetten naar Tailscale');
  assert.equal(parseTitle('Titel: VPS omzetten naar Tailscale'), 'VPS omzetten naar Tailscale');
  assert.equal(parseTitle('“VPS omzetten naar Tailscale”'), 'VPS omzetten naar Tailscale');
});

test('parseTitle drops a trailing period but keeps punctuation inside the name', () => {
  assert.equal(parseTitle('Budget Q3 doornemen.'), 'Budget Q3 doornemen');
  assert.equal(parseTitle('Wat kost de nieuwe VPS?'), 'Wat kost de nieuwe VPS?');
  assert.equal(parseTitle('Update naar v2.1 uitrollen.'), 'Update naar v2.1 uitrollen');
});

test('parseTitle caps a long name the way the store does', () => {
  const title = parseTitle('x'.repeat(200));
  assert.equal(title.length, MAX_TITLE_CHARS + 1); // + the ellipsis
  assert.ok(title.endsWith('…'));
});

test('parseTitle refuses anything that is not a usable name', () => {
  assert.equal(parseTitle(''), null);
  assert.equal(parseTitle('   \n  \n'), null);
  assert.equal(parseTitle('...'), null);
  assert.equal(parseTitle('""'), null);
  assert.equal(parseTitle('Title:'), null);
  assert.equal(parseTitle(null), null);
  assert.equal(parseTitle(42), null);
});

// --- buildTitleMessages (what the namer is shown) ---------------------------

test('buildTitleMessages shows both sides of the exchange, capped', () => {
  const messages = buildTitleMessages(
    [{ role: 'user', content: '  kun je kijken waarom   de vps niet bereikbaar is?  ' }],
    'Dan kijk ik even mee.'
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /ONLY the title/);
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /kun je kijken waarom de vps niet bereikbaar is\?/); // collapsed
  assert.match(messages[1].content, /Dan kijk ik even mee\./);
});

test('buildTitleMessages has nothing to name without a user message', () => {
  assert.equal(buildTitleMessages([], 'een antwoord'), null);
  assert.equal(buildTitleMessages([{ role: 'assistant', content: 'hoi' }], 'hoi'), null);
  assert.equal(buildTitleMessages([{ role: 'user', content: '   ' }], 'x'), null);
});

test('buildTitleMessages stays small even with a pasted document', () => {
  const messages = buildTitleMessages([{ role: 'user', content: 'y'.repeat(5000) }], 'z'.repeat(5000));
  assert.ok(messages[1].content.length < 2600, 'the naming prompt is bounded');
});

// --- generateConversationTitle (never throws, never required) ---------------

test('generateConversationTitle asks the generator and returns the name', async () => {
  const calls = [];
  const title = await generateConversationTitle({
    generator: { generate: async (messages) => { calls.push(messages); return 'VPS omzetten naar Tailscale'; } },
    messages: [{ role: 'user', content: 'de vps is down' }],
    replyText: 'Ik kijk even.',
  });
  assert.equal(title, 'VPS omzetten naar Tailscale');
  assert.equal(calls.length, 1);
});

test('generateConversationTitle accepts a { content } answer too', async () => {
  const title = await generateConversationTitle({
    generator: { generate: async () => ({ content: 'VPS omzetten naar Tailscale' }) },
    messages: [{ role: 'user', content: 'de vps is down' }],
    replyText: 'Ik kijk even.',
  });
  assert.equal(title, 'VPS omzetten naar Tailscale');
});

test('generateConversationTitle is silent where there is nothing to ask', async () => {
  assert.equal(await generateConversationTitle({ messages: [{ role: 'user', content: 'x' }] }), null);
  assert.equal(await generateConversationTitle({ generator: {}, messages: [{ role: 'user', content: 'x' }] }), null);
  assert.equal(await generateConversationTitle({ generator: { generate: async () => 'naam' }, messages: [] }), null);
});

test('generateConversationTitle swallows a failing or unusable naming call', async () => {
  const boom = { generate: async () => { throw new Error('provider down'); } };
  assert.equal(
    await generateConversationTitle({ generator: boom, messages: [{ role: 'user', content: 'x' }], replyText: 'y' }),
    null
  );
  const empty = { generate: async () => '' };
  assert.equal(
    await generateConversationTitle({ generator: empty, messages: [{ role: 'user', content: 'x' }], replyText: 'y' }),
    null
  );
});

// --- withDeadline (the reply never waits for a name) ------------------------

test('withDeadline resolves the value when it is in time', async () => {
  assert.equal(await withDeadline(Promise.resolve('naam'), 50), 'naam');
});

test('withDeadline gives up quietly on a slow namer, and the promise keeps running', async () => {
  let settle;
  const late = new Promise((resolve) => { settle = resolve; });
  assert.equal(await withDeadline(late, 5), null);
  // A late answer is still the caller's to use (turn.js writes it into the store).
  settle('te laat');
  assert.equal(await late, 'te laat');
});

test('withDeadline never rejects, whatever the namer does', async () => {
  assert.equal(await withDeadline(Promise.reject(new Error('nope')), 50), null);
});
