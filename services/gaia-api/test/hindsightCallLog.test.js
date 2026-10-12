'use strict';

/**
 * Every Hindsight call that fails emits a structured, content-free line
 * (`kind: 'hindsight.call_failed'`) before it throws — so a timed-out or
 * dropped call is visible instead of being silently swallowed by the
 * best-effort recall path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHindsightClient } = require('../src/hindsightClient');

function withCapturedWarn(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.join(' ')); };
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.warn = original; })
    .then(() => lines);
}

function throwingFetch(name) {
  return async () => { const e = new Error('boom'); if (name) e.name = name; throw e; };
}

test('a timed-out Hindsight call logs hindsight.call_failed with reason "timeout"', async () => {
  const client = createHindsightClient({
    baseUrl: 'http://hindsight.test',
    bankId: 'bojan',
    timeoutMs: 8000,
    fetchImpl: throwingFetch('TimeoutError'),
  });

  const lines = await withCapturedWarn(async () => {
    await assert.rejects(() => client.recall('anything'), /recall unreachable/);
  });

  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.kind, 'hindsight.call_failed');
  assert.equal(logged.bank, 'bojan');
  assert.equal(logged.op, 'recall');
  assert.equal(logged.reason, 'timeout');
  assert.equal(logged.timeoutMs, 8000);
  assert.equal(typeof logged.ms, 'number');
});

test('a non-timeout failure logs reason "unreachable", and the op follows the endpoint', async () => {
  const client = createHindsightClient({
    baseUrl: 'http://hindsight.test',
    bankId: 'gaia-logos',
    fetchImpl: throwingFetch(),
  });

  const lines = await withCapturedWarn(async () => {
    await assert.rejects(() => client.listMemories({ q: 'x' }));
  });

  const logged = JSON.parse(lines[0]);
  assert.equal(logged.bank, 'gaia-logos');
  assert.equal(logged.op, 'memories_list');
  assert.equal(logged.reason, 'unreachable');
});

test('the failure log never carries memory content', async () => {
  const client = createHindsightClient({
    baseUrl: 'http://hindsight.test',
    bankId: 'bojan',
    fetchImpl: throwingFetch('TimeoutError'),
  });
  const lines = await withCapturedWarn(async () => {
    await assert.rejects(() => client.recall('SECRET QUERY ABOUT BO'));
  });
  assert.doesNotMatch(lines[0], /SECRET QUERY/);
});
