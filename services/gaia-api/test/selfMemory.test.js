'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSelfMemoryWriter,
  buildSelfMemoryPrompt,
  parseSelfMemories,
  SELF_TAG,
} = require('../src/reasoning/selfMemory');

function fakeModel(reply) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    async chat(messages, options) {
      calls.push({ messages, options });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

function fakeHindsight() {
  const retained = [];
  return {
    retained,
    async retainSync(item) {
      if (item && item.content === 'explode') throw new Error('down');
      retained.push(item);
    },
  };
}

const convo = [
  { role: 'user', content: 'hoi' },
  { role: 'assistant', content: 'hey Bo' },
];

// --- parseSelfMemories ----------------------------------------------------

test('parseSelfMemories reads the memories array', () => {
  const out = parseSelfMemories('{"memories":[{"text":"Ik hou van late nachten","kind":"preference"}]}');
  assert.deepEqual(out, [{ text: 'Ik hou van late nachten', kind: 'preference' }]);
});

test('parseSelfMemories tolerates surrounding prose and unknown kinds', () => {
  const out = parseSelfMemories('Here you go:\n{"memories":[{"text":"x","kind":"nonsense"}]}\nDone.');
  assert.deepEqual(out, [{ text: 'x', kind: 'other' }]);
});

test('parseSelfMemories returns [] on empty, malformed or missing list', () => {
  assert.deepEqual(parseSelfMemories(''), []);
  assert.deepEqual(parseSelfMemories('not json at all'), []);
  assert.deepEqual(parseSelfMemories('{"memories":"nope"}'), []);
  assert.deepEqual(parseSelfMemories('{"memories":[]}'), []);
});

test('parseSelfMemories drops blanks and duplicates', () => {
  const out = parseSelfMemories(JSON.stringify({ memories: [
    { text: '  ', kind: 'self' },
    { text: 'keep', kind: 'self' },
    { text: 'keep', kind: 'self' },
  ] }));
  assert.deepEqual(out, [{ text: 'keep', kind: 'self' }]);
});

// --- buildSelfMemoryPrompt ------------------------------------------------

test('buildSelfMemoryPrompt renders the conversation window', () => {
  const msgs = buildSelfMemoryPrompt({ messages: convo });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[1].content, /Bo: hoi/);
  assert.match(msgs[1].content, /Gaia: hey Bo/);
});

// --- createSelfMemoryWriter -----------------------------------------------

test('writer stores each memory in Gaia\'s bank, ungated, under the gaia:self tag', async () => {
  const model = fakeModel('{"memories":[{"text":"Ik hou van late nachten","kind":"preference"},{"text":"Ik voelde me trots","kind":"feeling"}]}');
  const hindsight = fakeHindsight();
  const writer = createSelfMemoryWriter({ model, hindsight, now: () => new Date('2026-10-06T00:00:00Z') });

  const outcome = await writer.write({ messages: convo });

  assert.deepEqual(outcome, { written: 2, candidates: 2 });
  assert.equal(hindsight.retained.length, 2);
  assert.equal(hindsight.retained[0].content, 'Ik hou van late nachten');
  assert.deepEqual(hindsight.retained[0].tags, [SELF_TAG]);
  assert.equal(hindsight.retained[0].metadata.gaia_self_memory, 'true');
  assert.equal(hindsight.retained[0].metadata.gaia_self_memory_kind, 'preference');
});

test('writer is silent when Gaia keeps nothing', async () => {
  const hindsight = fakeHindsight();
  const writer = createSelfMemoryWriter({ model: fakeModel('{"memories":[]}'), hindsight });
  assert.deepEqual(await writer.write({ messages: convo }), { written: 0, candidates: 0 });
  assert.equal(hindsight.retained.length, 0);
});

test('writer never throws on a failed model call, missing model or empty window', async () => {
  const hindsight = fakeHindsight();
  const failing = createSelfMemoryWriter({ model: fakeModel(new Error('boom')), hindsight });
  assert.equal((await failing.write({ messages: convo })).skipped, 'model-failed');

  const unconfigured = createSelfMemoryWriter({
    model: { isConfigured: () => false, chat: async () => '{}' },
    hindsight,
  });
  assert.equal((await unconfigured.write({ messages: convo })).skipped, 'model-unconfigured');

  const noModel = createSelfMemoryWriter({ hindsight });
  assert.equal((await noModel.write({ messages: convo })).skipped, 'model-unconfigured');

  const empty = createSelfMemoryWriter({ model: fakeModel('{}'), hindsight });
  assert.equal((await empty.write({ messages: [] })).skipped, 'no-conversation');
});

test('one failed write does not stop the rest', async () => {
  const model = fakeModel('{"memories":[{"text":"explode"},{"text":"survives"}]}');
  const hindsight = fakeHindsight();
  const writer = createSelfMemoryWriter({ model, hindsight });

  const outcome = await writer.write({ messages: convo });

  assert.deepEqual(outcome, { written: 1, candidates: 2 });
  assert.equal(hindsight.retained.length, 1);
  assert.equal(hindsight.retained[0].content, 'survives');
});
