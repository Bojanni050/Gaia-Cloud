'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createConversationTool, LOOK_BACK_TOOL, snippet } = require('../src/reasoning/conversationTool');

const HISTORY = [
  { role: 'user', content: 'Wat vond je van de brief van Luca?' },
  { role: 'assistant', content: 'Die brief sloot af met "kocham cię" en dat raakte me.' },
  { role: 'user', content: 'En de player, doet die het weer?' },
  { role: 'assistant', content: 'Die werkt weer met de nieuwe afspeellijst.' },
  { role: 'user', content: 'wat zei ik ook alweer over die brief?' },
];

test('tool: it reads back a line that was actually said, with its place in the thread', async () => {
  const tool = createConversationTool({ messages: HISTORY });
  const result = await tool.onToolCall('read_back', { query: 'brief van Luca' });
  assert.match(result, /^Earlier in this conversation:/);
  assert.match(result, /\[2\] Gaia: "Die brief sloot af met "kocham cię" en dat raakte me\."/);
  assert.match(result, /\[1\] Bojan: "Wat vond je van de brief van Luca\?"/);
  assert.doesNotMatch(result, /afspeellijst/);
});

test('tool: the question being asked now is not "earlier"', async () => {
  const tool = createConversationTool({ messages: HISTORY });
  const result = await tool.onToolCall('read_back', { query: 'wat zei ik ook alweer over die brief' });
  // "over die brief" does occur earlier, so those lines come back — but the
  // current question itself is never quoted.
  assert.doesNotMatch(result, /wat zei ik ook alweer over die brief/);
  const only = createConversationTool({ messages: [{ role: 'user', content: 'hallo daar' }] });
  assert.equal(await only.onToolCall('read_back', { query: 'hallo daar' }), 'There is nothing earlier in this conversation.');
});

test('tool: no query, no words, nothing earlier — each says so plainly', async () => {
  const tool = createConversationTool({ messages: HISTORY });
  assert.equal(await tool.onToolCall('read_back', {}), 'Nothing to look for.');
  assert.equal(await tool.onToolCall('read_back', { query: '   ' }), 'Nothing to look for.');
  assert.equal(
    await tool.onToolCall('read_back', { query: 'ok ja' }),
    'The search phrase had no words in it, so nothing was looked up.'
  );
  const empty = createConversationTool({ messages: [] });
  assert.equal(await empty.onToolCall('read_back', { query: 'brief' }), 'There is nothing earlier in this conversation.');
  const firstTurn = createConversationTool({ messages: [{ role: 'user', content: 'een langere eerste vraag' }] });
  assert.equal(await firstTurn.onToolCall('read_back', { query: 'eerste vraag' }), 'There is nothing earlier in this conversation.');
});

test('tool: a miss says it found nothing rather than inventing a line', async () => {
  const tool = createConversationTool({ messages: HISTORY });
  assert.equal(await tool.onToolCall('read_back', { query: 'hypotheek rente' }), 'Nothing in this conversation matches that.');
});

test('tool: it owns one verb and refuses everything else', async () => {
  const tool = createConversationTool({ messages: HISTORY });
  assert.equal(tool.TOOLS.length, 1);
  assert.equal(tool.TOOLS[0].function.name, 'read_back');
  assert.equal(await tool.onToolCall('search_memory', { query: 'brief' }), 'Unknown action.');
  assert.equal(await tool.onToolCall('desktop', {}), 'Unknown action.');
});

test('tool: long lines are cut and at most six come back', async () => {
  const long = 'x'.repeat(900);
  const messages = [];
  for (let i = 0; i < 8; i += 1) {
    messages.push({ role: 'user', content: `vraag ${i} over de brief` });
    messages.push({ role: 'assistant', content: `${long} brief ${i}` });
    void i;
  }
  const tool = createConversationTool({ messages });
  const result = await tool.onToolCall('read_back', { query: 'brief' });
  assert.equal(result.split('\n').length - 1, 6);
  for (const line of result.split('\n').slice(1)) assert.ok(line.length < 300, 'each line stays quotable');
  assert.match(snippet(long), /…$/);
});

test('tool: garbage in the history or the call never throws', async () => {
  const tool = createConversationTool({ messages: [null, { role: 'system', content: 'S' }, { role: 'user' }, 42, { role: 'assistant', content: '  ' }, { role: 'user', content: 'de brief' }] });
  assert.equal(await tool.onToolCall('read_back'), 'Nothing to look for.');
  assert.equal(typeof (await tool.onToolCall('read_back', { query: 'brief' })), 'string');
  const noMessages = createConversationTool();
  assert.equal(await noMessages.onToolCall('read_back', { query: 'brief' }), 'There is nothing earlier in this conversation.');
  assert.match(LOOK_BACK_TOOL.function.description, /only this conversation/);
});

test('streamed turn: read_back is offered to the model and quotes the conversation it is in', async () => {
  const { performStreamingTurn } = require('../src/turn');
  const res = {
    writableEnded: false,
    writeHead() {}, status() { return this; }, json() {},
    write() {}, end() { this.writableEnded = true; },
  };
  let names = null;
  let quoted = null;
  const generator = {
    stream: async (messages, opts) => {
      names = (opts.tools || []).map((tool) => tool.function.name);
      quoted = await opts.onToolCall('read_back', { query: 'kocham' });
      opts.onDelta('ok', false);
      return 'ok';
    },
  };
  await performStreamingTurn({
    messages: HISTORY,
    documents: { 'soul.md': 'S', 'principles.md': 'P', 'lexicon.md': 'L' },
    res,
    generator,
  });
  assert.deepEqual(names, ['read_back']);
  assert.match(quoted, /kocham cię/);
});
