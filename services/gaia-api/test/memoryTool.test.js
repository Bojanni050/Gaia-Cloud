'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryTool, withKeptNotifier, REMEMBER_TOOL, KEEP_TOOL, RETRACT_TOOL, FORGET_TOOL, SHARED_DOMAIN, OWN_DOMAIN } = require('../src/reasoning/memoryTool');

function fakeHindsight(boomOn) {
  const calls = [];
  return {
    calls,
    async reflect(reflection) {
      if (boomOn && reflection && reflection.summary === boomOn) throw new Error('down');
      calls.push(reflection);
    },
  };
}

test('the two tools expose remember (shared) and keep (her own)', () => {
  assert.equal(REMEMBER_TOOL.function.name, 'remember');
  assert.equal(KEEP_TOOL.function.name, 'keep');
});

test('remember writes to the shared system-memory bank', async () => {
  const hindsight = fakeHindsight();
  const own = fakeHindsight();
  const tool = createMemoryTool({ hindsight, ownHindsight: own, now: () => new Date('2026-10-06T00:00:00Z') });

  const result = await tool.onToolCall('remember', { text: '  Bo likes tea  ', kind: 'preference' });

  assert.equal(result, 'Kept.');
  assert.equal(hindsight.calls.length, 1);
  assert.equal(own.calls.length, 0);
  assert.equal(hindsight.calls[0].summary, 'Bo likes tea');
  assert.equal(hindsight.calls[0].domain, SHARED_DOMAIN);
  assert.equal(hindsight.calls[0].metadata.gaia_remembered, 'true');
});

test('keep writes to HER own bank, under the gaia:aion namespace', async () => {
  const hindsight = fakeHindsight();
  const own = fakeHindsight();
  const tool = createMemoryTool({ hindsight, ownHindsight: own, now: () => new Date('2026-10-06T00:00:00Z') });

  const result = await tool.onToolCall('keep', { text: 'I liked that quiet evening', kind: 'moment' });

  assert.equal(result, 'Kept, as yours.');
  assert.equal(hindsight.calls.length, 0);
  assert.equal(own.calls.length, 1);
  assert.equal(own.calls[0].summary, 'I liked that quiet evening');
  assert.equal(own.calls[0].domain, OWN_DOMAIN);
  assert.equal(own.calls[0].metadata.gaia_aion, 'true');
  assert.equal(own.calls[0].metadata.gaia_aion_source, 'tool');
});

test('without her own bank client, only remember is offered and keep is a calm no-op', async () => {
  const hindsight = fakeHindsight();
  const tool = createMemoryTool({ hindsight });

  assert.deepEqual(tool.TOOLS, [REMEMBER_TOOL]);
  assert.equal(await tool.onToolCall('keep', { text: 'x' }), 'That could not be kept right now.');
});

test('nothing to keep writes nothing', async () => {
  const hindsight = fakeHindsight();
  const own = fakeHindsight();
  const tool = createMemoryTool({ hindsight, ownHindsight: own });

  assert.equal(await tool.onToolCall('remember', { text: '   ' }), 'Nothing to keep.');
  assert.equal(await tool.onToolCall('keep', { text: '' }), 'Nothing to keep.');
  assert.equal(hindsight.calls.length + own.calls.length, 0);
});

test('an unknown tool name is a calm no-op', async () => {
  const tool = createMemoryTool({ hindsight: fakeHindsight(), ownHindsight: fakeHindsight() });
  assert.equal(await tool.onToolCall('forget', { text: 'x' }), 'Unknown action.');
});

test('a failed write never throws — it reports calmly', async () => {
  const tool = createMemoryTool({ hindsight: fakeHindsight('explode'), ownHindsight: fakeHindsight('explode') });
  assert.equal(await tool.onToolCall('remember', { text: 'explode' }), 'That could not be kept right now.');
  assert.equal(await tool.onToolCall('keep', { text: 'explode' }), 'That could not be kept right now.');
});

test('the tool requires a shared hindsight client', () => {
  assert.throws(() => createMemoryTool({}), /requires a hindsight client/);
});

// --- announcing what was kept (the light next to her reply) ----------------------------------

test('a remember that succeeds is announced to the turn it ran in, with the statement she kept', async () => {
  const tool = createMemoryTool({ hindsight: fakeHindsight(), ownHindsight: fakeHindsight() });
  const heard = [];
  const result = await withKeptNotifier((kept) => heard.push(kept), () => tool.onToolCall('remember', { text: ' Bo likes tea ', kind: 'preference' }));
  assert.equal(result, 'Kept.');
  assert.deepEqual(heard, [{ bank: 'bojan', kind: 'preference', text: 'Bo likes tea' }]);
});

test('nothing is announced when the keep fails, when there is nothing to keep, or for her own bank', async () => {
  const tool = createMemoryTool({ hindsight: fakeHindsight('boom'), ownHindsight: fakeHindsight() });
  const heard = [];
  await withKeptNotifier((kept) => heard.push(kept), async () => {
    assert.equal(await tool.onToolCall('remember', { text: 'boom' }), 'That could not be kept right now.');
    assert.equal(await tool.onToolCall('remember', { text: '   ' }), 'Nothing to keep.');
    assert.equal(await tool.onToolCall('keep', { text: 'I like rain' }), 'Kept, as yours.');
  });
  assert.deepEqual(heard, []);
});

test('remember works as before when no turn is listening, and a throwing listener never breaks it', async () => {
  const tool = createMemoryTool({ hindsight: fakeHindsight(), ownHindsight: fakeHindsight() });
  assert.equal(await tool.onToolCall('remember', { text: 'a fact' }), 'Kept.');
  const result = await withKeptNotifier(() => { throw new Error('listener broke'); }, () => tool.onToolCall('remember', { text: 'a fact' }));
  assert.equal(result, 'Kept.');
});

test('two turns at once only hear their own keeps', async () => {
  const tool = createMemoryTool({ hindsight: fakeHindsight(), ownHindsight: fakeHindsight() });
  const a = [];
  const b = [];
  await Promise.all([
    withKeptNotifier((k) => a.push(k.text), async () => { await new Promise((r) => setTimeout(r, 15)); await tool.onToolCall('remember', { text: 'for a' }); }),
    withKeptNotifier((k) => b.push(k.text), async () => { await tool.onToolCall('remember', { text: 'for b' }); }),
  ]);
  assert.deepEqual(a, ['for a']);
  assert.deepEqual(b, ['for b']);
});

// --- search_memory: reading back on demand --------------------------------------------------

function fakeRecall(results, { boom } = {}) {
  const queries = [];
  return {
    queries,
    async recall(query) {
      queries.push(query);
      if (boom) throw new Error('down');
      return results;
    },
  };
}

test('search_memory is offered when a recall client is present, and only then', () => {
  const withSearch = createMemoryTool({
    hindsight: fakeHindsight(),
    ownHindsight: fakeHindsight(),
    searchHindsight: fakeRecall([]),
  });
  assert.deepEqual(withSearch.TOOLS.map((t) => t.function.name), ['remember', 'search_memory', 'keep']);

  const withoutSearch = createMemoryTool({ hindsight: fakeHindsight(), ownHindsight: fakeHindsight() });
  assert.deepEqual(withoutSearch.TOOLS.map((t) => t.function.name), ['remember', 'keep']);
});

test('retract_memory is offered when the banks are wired, and only then', async () => {
  const bank = { name: 'bojan', client: { async listMemories() { return []; } } };
  const withBanks = createMemoryTool({ hindsight: fakeHindsight(), banks: [bank], home: bank });

  assert.deepEqual(withBanks.TOOLS.map((t) => t.function.name), ['remember', 'retract_memory', 'forget_memory']);
  assert.equal(RETRACT_TOOL.function.name, 'retract_memory');
  assert.deepEqual(RETRACT_TOOL.function.parameters.required, ['quote']);

  const withoutBanks = createMemoryTool({ hindsight: fakeHindsight() });
  assert.deepEqual(withoutBanks.TOOLS.map((t) => t.function.name), ['remember']);
  assert.equal(
    await withoutBanks.onToolCall('retract_memory', { quote: 'Yassine is een vriend' }),
    'That could not be taken back right now.'
  );
  assert.equal(
    await withoutBanks.onToolCall('forget_memory', { quote: 'Yassine is een vriend' }),
    'That could not be forgotten right now.'
  );
});

test('forget_memory is the second half: the person asked, so it goes, and nothing is kept', async () => {
  const patched = [];
  const kept = [];
  const bank = {
    name: 'bojan',
    client: {
      async listMemories() { return [{ id: 'f1', text: 'Bo deed een afscheidsritueel met Luca', state: 'valid' }]; },
      async patchMemoryState(id, state, reason) { patched.push({ id, state, reason }); },
      async retainSync(payload) { kept.push(payload); },
    },
  };
  const tool = createMemoryTool({ hindsight: fakeHindsight(), banks: [bank], home: bank });

  const result = await tool.onToolCall('forget_memory', { quote: 'Bo deed een afscheidsritueel met Luca' });

  assert.match(result, /^Forgotten: "Bo deed een afscheidsritueel met Luca"$/m);
  assert.equal(result.includes('Kept instead'), false);
  assert.deepEqual(patched, [{ id: 'f1', state: 'invalidated', reason: 'the person asked for this to be forgotten' }]);
  assert.deepEqual(kept, []);

  assert.equal(await tool.onToolCall('forget_memory', { quote: '   ' }), 'Nothing named to forget.');
  assert.equal(FORGET_TOOL.function.name, 'forget_memory');
  assert.deepEqual(FORGET_TOOL.function.parameters.required, ['quote']);
});

test('a retraction through the tool takes the memory back, and reports which one went', async () => {
  const patched = [];
  const bank = {
    name: 'bojan',
    client: {
      async listMemories() { return [{ id: 'f1', text: 'Yassine is een vriend van je', state: 'valid' }]; },
      async patchMemoryState(id, state, reason) { patched.push({ id, state, reason }); },
    },
  };
  const tool = createMemoryTool({ hindsight: fakeHindsight(), banks: [bank], home: bank });

  const result = await tool.onToolCall('retract_memory', { quote: '  Yassine is een vriend van je  ' });

  assert.match(result, /^Taken back: "Yassine is een vriend van je"$/m);
  assert.deepEqual(patched, [{ id: 'f1', state: 'invalidated', reason: 'the person said this is not correct' }]);

  assert.equal(await tool.onToolCall('retract_memory', { quote: '   ' }), 'Nothing named to take back.');
});

test('a retraction that matches nothing is a calm sentence, not an error', async () => {
  const bank = {
    name: 'bojan',
    client: {
      async listMemories() { return [{ id: 'f1', text: 'Bo drinkt graag koffie in de ochtend', state: 'valid' }]; },
      async patchMemoryState() { throw new Error('should not be called'); },
    },
  };
  const tool = createMemoryTool({ hindsight: fakeHindsight(), banks: [bank], home: bank });

  const result = await tool.onToolCall('retract_memory', { quote: 'Yassine is een vriend van je' });

  assert.equal(result, 'Nothing in memory matches that closely enough to take back.');
});

test('a failed retraction never throws at the model', async () => {
  const bank = { name: 'bojan', client: { async listMemories() { throw new Error('down'); } } };
  const tool = createMemoryTool({ hindsight: fakeHindsight(), banks: [bank], home: bank });

  assert.equal(await tool.onToolCall('retract_memory', { quote: 'iets' }), 'Nothing in memory matches that closely enough to take back.');
});

test('search_memory reads back through the recall client and renders the matches', async () => {
  const recall = fakeRecall([
    { text: 'Bo works on Gaia', scores: { final: 0.9 } },
    { text: 'Bo prefers late nights', scores: { final: 0.4 } },
  ]);
  const tool = createMemoryTool({ hindsight: fakeHindsight(), searchHindsight: recall });

  const result = await tool.onToolCall('search_memory', { query: '  what do I know about Bo  ' });

  assert.equal(result, '- Bo works on Gaia\n- Bo prefers late nights (uncertain)');
  assert.deepEqual(recall.queries, ['what do I know about Bo']);
});

test('search_memory says so plainly when memory has nothing, or the query is empty', async () => {
  const tool = createMemoryTool({ hindsight: fakeHindsight(), searchHindsight: fakeRecall([]) });
  assert.equal(await tool.onToolCall('search_memory', { query: 'unheard of' }), 'Nothing in memory about that.');
  assert.equal(await tool.onToolCall('search_memory', { query: '   ' }), 'Nothing to search for.');
});

test('a failed lookup never throws — it reports calmly', async () => {
  const tool = createMemoryTool({ hindsight: fakeHindsight(), searchHindsight: fakeRecall([], { boom: true }) });
  assert.equal(await tool.onToolCall('search_memory', { query: 'anything' }), 'That could not be looked up right now.');
});

test('search_memory is a calm no-op when no lookup path is wired', async () => {
  const tool = createMemoryTool({ hindsight: fakeHindsight() });
  assert.equal(await tool.onToolCall('search_memory', { query: 'anything' }), 'That could not be looked up right now.');
});
