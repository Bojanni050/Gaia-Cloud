'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryTool, withKeptNotifier, REMEMBER_TOOL, KEEP_TOOL, SHARED_DOMAIN, OWN_DOMAIN } = require('../src/reasoning/memoryTool');

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
