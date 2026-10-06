'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAionWriter,
  buildAionPrompt,
  parseAionMemories,
  AION_TAG,
} = require('../src/reasoning/aion');

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

// --- parseAionMemories ----------------------------------------------------

test('parseAionMemories reads the memories array', () => {
  const out = parseAionMemories('{"memories":[{"text":"Ik hou van late nachten","kind":"preference"}]}');
  assert.deepEqual(out, [{ text: 'Ik hou van late nachten', kind: 'preference' }]);
});

test('parseAionMemories tolerates surrounding prose and unknown kinds', () => {
  const out = parseAionMemories('Here you go:\n{"memories":[{"text":"x","kind":"nonsense"}]}\nDone.');
  assert.deepEqual(out, [{ text: 'x', kind: 'other' }]);
});

test('parseAionMemories returns [] on empty, malformed or missing list', () => {
  assert.deepEqual(parseAionMemories(''), []);
  assert.deepEqual(parseAionMemories('not json at all'), []);
  assert.deepEqual(parseAionMemories('{"memories":"nope"}'), []);
  assert.deepEqual(parseAionMemories('{"memories":[]}'), []);
});

test('parseAionMemories drops blanks and duplicates', () => {
  const out = parseAionMemories(JSON.stringify({ memories: [
    { text: '  ', kind: 'self' },
    { text: 'keep', kind: 'self' },
    { text: 'keep', kind: 'self' },
  ] }));
  assert.deepEqual(out, [{ text: 'keep', kind: 'self' }]);
});

// --- buildAionPrompt ------------------------------------------------

test('buildAionPrompt renders the conversation window', () => {
  const msgs = buildAionPrompt({ messages: convo });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[1].content, /Bo: hoi/);
  assert.match(msgs[1].content, /Gaia: hey Bo/);
});

// --- createAionWriter -----------------------------------------------

test('writer stores each memory in Gaia\'s bank, ungated, under the gaia:aion tag', async () => {
  const model = fakeModel('{"memories":[{"text":"Ik hou van late nachten","kind":"preference"},{"text":"Ik voelde me trots","kind":"feeling"}]}');
  const hindsight = fakeHindsight();
  const writer = createAionWriter({ model, hindsight, now: () => new Date('2026-10-06T00:00:00Z') });

  const outcome = await writer.write({ messages: convo });

  assert.deepEqual(outcome, { written: 2, candidates: 2 });
  assert.equal(hindsight.retained.length, 2);
  assert.equal(hindsight.retained[0].content, 'Ik hou van late nachten');
  assert.deepEqual(hindsight.retained[0].tags, [AION_TAG]);
  assert.equal(hindsight.retained[0].metadata.gaia_aion, 'true');
  assert.equal(hindsight.retained[0].metadata.gaia_aion_kind, 'preference');
});

test('writer is silent when Gaia keeps nothing', async () => {
  const hindsight = fakeHindsight();
  const writer = createAionWriter({ model: fakeModel('{"memories":[]}'), hindsight });
  assert.deepEqual(await writer.write({ messages: convo }), { written: 0, candidates: 0 });
  assert.equal(hindsight.retained.length, 0);
});

test('writer never throws on a failed model call, missing model or empty window', async () => {
  const hindsight = fakeHindsight();
  const failing = createAionWriter({ model: fakeModel(new Error('boom')), hindsight });
  assert.equal((await failing.write({ messages: convo })).skipped, 'model-failed');

  const unconfigured = createAionWriter({
    model: { isConfigured: () => false, chat: async () => '{}' },
    hindsight,
  });
  assert.equal((await unconfigured.write({ messages: convo })).skipped, 'model-unconfigured');

  const noModel = createAionWriter({ hindsight });
  assert.equal((await noModel.write({ messages: convo })).skipped, 'model-unconfigured');

  const empty = createAionWriter({ model: fakeModel('{}'), hindsight });
  assert.equal((await empty.write({ messages: [] })).skipped, 'no-conversation');
});

test('one failed write does not stop the rest', async () => {
  const model = fakeModel('{"memories":[{"text":"explode"},{"text":"survives"}]}');
  const hindsight = fakeHindsight();
  const writer = createAionWriter({ model, hindsight });

  const outcome = await writer.write({ messages: convo });

  assert.deepEqual(outcome, { written: 1, candidates: 2 });
  assert.equal(hindsight.retained.length, 1);
  assert.equal(hindsight.retained[0].content, 'survives');
});
