'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryTool, REMEMBER_TOOL, REMEMBER_DOMAIN } = require('../src/reasoning/memoryTool');

function fakeHindsight() {
  const calls = [];
  return {
    calls,
    async reflect(reflection) {
      if (reflection && reflection.summary === 'explode') throw new Error('down');
      calls.push(reflection);
    },
  };
}

test('the tool schema exposes a single remember function', () => {
  assert.equal(REMEMBER_TOOL.type, 'function');
  assert.equal(REMEMBER_TOOL.function.name, 'remember');
  assert.deepEqual(REMEMBER_TOOL.function.parameters.required, ['text']);
});

test('remember writes the statement to the system-memory bank and reports back', async () => {
  const hindsight = fakeHindsight();
  const tool = createMemoryTool({ hindsight, now: () => new Date('2026-10-06T00:00:00Z') });

  const result = await tool.onToolCall('remember', { text: '  Bo likes tea  ', kind: 'preference' });

  assert.equal(result, 'Kept.');
  assert.equal(hindsight.calls.length, 1);
  assert.equal(hindsight.calls[0].summary, 'Bo likes tea');
  assert.equal(hindsight.calls[0].domain, REMEMBER_DOMAIN);
  assert.equal(hindsight.calls[0].metadata.gaia_remembered, 'true');
  assert.equal(hindsight.calls[0].metadata.gaia_remembered_kind, 'preference');
});

test('remember with nothing to keep writes nothing', async () => {
  const hindsight = fakeHindsight();
  const tool = createMemoryTool({ hindsight });

  assert.equal(await tool.onToolCall('remember', { text: '   ' }), 'Nothing to keep.');
  assert.equal(await tool.onToolCall('remember', {}), 'Nothing to keep.');
  assert.equal(hindsight.calls.length, 0);
});

test('an unknown tool name is a calm no-op', async () => {
  const hindsight = fakeHindsight();
  const tool = createMemoryTool({ hindsight });
  assert.equal(await tool.onToolCall('forget', { text: 'x' }), 'Unknown action.');
  assert.equal(hindsight.calls.length, 0);
});

test('a failed write never throws — it reports calmly', async () => {
  const hindsight = fakeHindsight();
  const tool = createMemoryTool({ hindsight });
  assert.equal(await tool.onToolCall('remember', { text: 'explode' }), 'That could not be kept right now.');
});

test('the tool requires a hindsight client', () => {
  assert.throws(() => createMemoryTool({}), /requires a hindsight client/);
});
