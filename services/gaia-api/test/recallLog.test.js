'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { logRecallMeasure } = require('../src/recallLog');

test('logRecallMeasure emits counts-only recall.measure record, never content', () => {
  const lines = [];
  const record = logRecallMeasure({
    traceId: 'trace-1',
    gated: true,
    hasHindsight: true,
    reflectionCount: 2,
    mentalModelCount: 7,
    patternCount: 0,
    knowledgePageCount: 1,
    queryLength: 42,
    wantPatterns: false,
  }, (line) => lines.push(line));

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.kind, 'recall.measure');
  assert.equal(parsed.traceId, 'trace-1');
  assert.equal(parsed.gated, true);
  assert.equal(parsed.reflectionCount, 2);
  assert.deepEqual(record, parsed);
  const blob = lines[0];
  assert.ok(!blob.includes('weet je nog'), 'no user text leaks into recall.measure');
});
