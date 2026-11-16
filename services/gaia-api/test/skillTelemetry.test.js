'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeSkillUse,
  buildSkillTelemetry,
} = require('../src/skillTelemetry');

function call(tool, outcome, extra = {}) {
  return {
    kind: 'tool.call',
    timestamp: '2026-11-16T10:00:00.000Z',
    tool,
    outcome,
    resultChars: 10,
    latencyMs: 20,
    conversationId: 'conv-1',
    ...extra,
  };
}

function gap(reason, extra = {}) {
  return {
    kind: 'skill.gap',
    timestamp: '2026-11-16T10:05:00.000Z',
    reason,
    capability: null,
    skill: null,
    tool: null,
    conversationId: 'conv-1',
    ...extra,
  };
}

test('offered, used and usable are counted apart', () => {
  const summary = summarizeSkillUse([
    { kind: 'tool.offered', timestamp: '2026-11-16T10:00:00.000Z', tools: ['search_memory', 'web_search'] },
    { kind: 'tool.offered', timestamp: '2026-11-16T10:01:00.000Z', tools: ['search_memory'] },
    call('search_memory', 'answered'),
    call('search_memory', 'empty'),
    call('search_memory', 'failed'),
  ]);

  const search = summary.tools.find((row) => row.tool === 'search_memory');
  assert.equal(search.offered, 2);
  assert.equal(search.calls, 3);
  assert.equal(search.answered, 1);
  assert.equal(search.empty, 1);
  assert.equal(search.failed, 1);
  assert.equal(search.capability, 'memory');

  // Offered twice, never called: the description is the problem, not the tool.
  const web = summary.tools.find((row) => row.tool === 'web_search');
  assert.equal(web.offered, 1);
  assert.equal(web.calls, 0);

  assert.ok(summary.unreached.includes('desktop'), 'a tool with no line at all is unreached');
  assert.ok(!summary.unreached.includes('search_memory'));
});

test('only an absent ability is learnable; a client limit and a wiring gap are not', () => {
  const summary = summarizeSkillUse([
    gap('unknown-tool', { tool: 'open_website' }),
    gap('unknown-tool', { tool: 'open_website' }),
    gap('unknown-skill', { capability: 'desktop', skill: 'send-email', tool: 'desktop' }),
    gap('not-carried', { capability: 'desktop', skill: 'run-command', tool: 'desktop' }),
    gap('not-configured', { capability: 'memory', tool: 'search_memory' }),
  ]);

  const invented = summary.gaps.find((row) => row.tool === 'open_website');
  assert.equal(invented.count, 2);
  assert.equal(invented.conversations, 1);
  assert.equal(invented.learnable, true);

  assert.equal(summary.gaps.find((row) => row.skill === 'send-email').learnable, true);
  assert.equal(summary.gaps.find((row) => row.skill === 'run-command').learnable, false);
  assert.equal(summary.gaps.find((row) => row.reason === 'not-configured').learnable, false);
});

test('gaps keep their conversations apart, so one repeated moment is not evidence', () => {
  const summary = summarizeSkillUse([
    gap('unknown-skill', { skill: 'send-email', tool: 'desktop', conversationId: 'conv-1' }),
    gap('unknown-skill', { skill: 'send-email', tool: 'desktop', conversationId: 'conv-1' }),
    gap('unknown-skill', { skill: 'send-email', tool: 'desktop', conversationId: 'conv-2' }),
  ]);
  assert.equal(summary.gaps[0].count, 3);
  assert.equal(summary.gaps[0].conversations, 2);
});

test('capabilities carry their own tools and a gap total', () => {
  const summary = summarizeSkillUse([
    call('web_search', 'answered'),
    gap('unknown-tool', { tool: 'open_website' }),
  ]);
  const web = summary.capabilities.find((row) => row.capability === 'web_search');
  assert.equal(web.calls, 1);
  assert.deepEqual(web.tools, ['web_search']);

  const memory = summary.capabilities.find((row) => row.capability === 'memory');
  assert.equal(memory.calls, 0);
  assert.ok(memory.unusedTools.includes('search_memory'));
});

test('the window reports what it actually read', () => {
  const summary = summarizeSkillUse([
    call('search_memory', 'answered', { timestamp: '2026-11-14T08:00:00.000Z' }),
    call('search_memory', 'answered', { timestamp: '2026-11-16T09:00:00.000Z' }),
  ]);
  assert.equal(summary.window.records, 2);
  assert.equal(summary.window.since, '2026-11-14T08:00:00.000Z');
  assert.equal(summary.window.until, '2026-11-16T09:00:00.000Z');
});

test('a store that is absent or broken yields an empty window, never a throw', () => {
  assert.equal(buildSkillTelemetry(null).window.records, 0);
  assert.equal(buildSkillTelemetry({ list() { throw new Error('disk gone'); } }).window.records, 0);
  assert.equal(buildSkillTelemetry({ list: 'not a function' }).window.records, 0);
  const quiet = summarizeSkillUse([null, 42, {}, { kind: 'something.else' }]);
  assert.equal(quiet.window.records, 4);
  assert.deepEqual(quiet.tools, []);
});
