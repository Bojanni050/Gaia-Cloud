'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { logToolCall, logToolUnavailable, classifyToolResult } = require('../src/toolLog');
const { createMemoryTool } = require('../src/reasoning/memoryTool');
const { createWebSearchTool } = require('../src/reasoning/webSearchTool');

test('logToolCall emits a counts-only tool.call record, never content', () => {
  const lines = [];
  const record = logToolCall({
    tool: 'search_memory',
    resultText: '- Bo heeft vrienden Luca en Yassine. (confirmed by the person, 2d)',
    round: 1,
    conversationId: 'conv-1',
    latencyMs: 42,
  }, (line) => lines.push(line));

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.kind, 'tool.call');
  assert.equal(parsed.tool, 'search_memory');
  assert.equal(parsed.round, 1);
  assert.equal(parsed.conversationId, 'conv-1');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.outcome, 'answered');
  assert.equal(parsed.resultChars, 66);
  assert.equal(parsed.latencyMs, 42);
  assert.deepEqual(record, parsed);
  assert.ok(!lines[0].includes('Yassine'), 'no tool result text leaks into tool.call');
  assert.ok(!lines[0].includes('Luca'), 'no names leak into tool.call');
});

test('logToolCall never throws on a broken sink and defaults missing fields', () => {
  const record = logToolCall({ tool: 'search_memory', resultText: 'Nothing in memory about that.' }, { not: 'a function' });
  assert.equal(record.outcome, 'empty');
  assert.equal(record.round, null);
  assert.equal(record.conversationId, null);
  assert.equal(record.latencyMs, null);
});

test('classifyToolResult separates "nothing found" from "could not look it up"', () => {
  assert.equal(classifyToolResult('Nothing in memory about that.'), 'empty');
  assert.equal(classifyToolResult('Nothing to search for.'), 'empty');
  assert.equal(classifyToolResult('That could not be looked up right now.'), 'failed');
  assert.equal(classifyToolResult('Unknown action.'), 'failed');
  assert.equal(classifyToolResult('The web lookup failed (ECONNREFUSED).'), 'failed');
  assert.equal(classifyToolResult('- Bo houdt van thee. (confirmed by the person, 1d)'), 'answered');
  assert.equal(classifyToolResult('Kept.'), 'answered');
  assert.equal(classifyToolResult(undefined), 'answered');
  assert.equal(classifyToolResult(null), 'answered');
});

// The classifiers match on the tools' own sentences, so a reworded tool would
// quietly turn "she found nothing" into "she answered". These two tests bind
// the map to the real tools: they call the actual no-result paths.
test('memoryTool no-result replies classify the way the log claims', async () => {
  const tool = createMemoryTool({
    hindsight: { reflect: async () => {} },
    searchHindsight: { recall: async () => [] },
    ownHindsight: { reflect: async () => {} },
  });

  assert.equal(classifyToolResult(await tool.onToolCall('search_memory', { query: 'unheard of' })), 'empty');
  assert.equal(classifyToolResult(await tool.onToolCall('search_memory', { query: '   ' })), 'empty');
  assert.equal(classifyToolResult(await tool.onToolCall('remember', {})), 'empty');
  assert.equal(classifyToolResult(await tool.onToolCall('keep', {})), 'empty');
  assert.equal(classifyToolResult(await tool.onToolCall('search_memory', { query: 'x' })), 'empty');
});

test('memoryTool failure and success replies classify correctly', async () => {
  const failing = createMemoryTool({
    hindsight: { reflect: async () => { throw new Error('down'); } },
    searchHindsight: { recall: async () => { throw new Error('down'); } },
  });

  assert.equal(classifyToolResult(await failing.onToolCall('search_memory', { query: 'x' })), 'failed');
  assert.equal(classifyToolResult(await failing.onToolCall('remember', { text: 'x' })), 'failed');

  const working = createMemoryTool({
    hindsight: { reflect: async () => {} },
    searchHindsight: { recall: async () => [
      { text: 'Bo houdt van thee.', tags: ['gaia:confirmed_fact'], scores: { final: 0.9 } },
    ] },
  });
  const hit = await working.onToolCall('search_memory', { query: 'thee' });
  assert.equal(classifyToolResult(hit), 'answered');
  assert.equal(classifyToolResult(await working.onToolCall('remember', { text: 'iets' })), 'answered');
});

test('webSearchTool replies classify the way the log claims', async () => {
  const tool = createWebSearchTool({ search: { search: async () => ({ results: [], text: 'no results text' }) } });
  assert.equal(classifyToolResult(await tool.onToolCall('web_search', {})), 'empty');

  const failing = createWebSearchTool({ search: { search: async () => { throw new Error('ECONNREFUSED'); } } });
  assert.equal(classifyToolResult(await failing.onToolCall('web_search', { query: 'x' })), 'failed');
});

test('logToolUnavailable records a turn that was retried without tools', () => {
  const lines = [];
  const record = logToolUnavailable({ status: 400, conversationId: 'conv-1' }, (line) => lines.push(line));

  assert.equal(record.kind, 'tool.unavailable');
  assert.equal(record.reason, 'tools_rejected');
  assert.equal(record.status, 400);
  assert.equal(record.conversationId, 'conv-1');
  assert.deepEqual(JSON.parse(lines[0]), record);
});
