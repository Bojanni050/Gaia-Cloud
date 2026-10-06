'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryTool, REMEMBER_TOOL, KEEP_TOOL, SHARED_DOMAIN, OWN_DOMAIN } = require('../src/reasoning/memoryTool');

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
