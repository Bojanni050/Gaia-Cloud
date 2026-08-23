'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execute } = require('../src/orchestration/orchestrator');

test('execute() rejects an invalid decision before touching any capability', async () => {
  await assert.rejects(
    () => execute({ action: 'nonsense' }, { capabilities: {} }),
    /Orchestrator received an invalid decision/
  );
});

test('execute() native without generator: returns structured error without calling any capability', async () => {
  const capabilities = { hermes: { invoke: async () => { throw new Error('must not be called'); } } };
  const result = await execute({ action: 'native' }, { capabilities });
  assert.equal(result.action, 'native');
  assert.equal(result.output, null);
  assert.match(result.error, /native generator is not available/);
});

test('execute() native with generator: invokes the native generator and returns its output', async () => {
  const capabilities = { hermes: { invoke: async () => { throw new Error('must not be called'); } } };
  const nativeGenerator = {
    generate: async (messages) => {
      assert.deepEqual(messages, ['hello']);
      return 'Gaia says hello';
    }
  };
  const result = await execute(
    { action: 'native' },
    { capabilities, messages: ['hello'], nativeGenerator }
  );
  assert.equal(result.action, 'native');
  assert.equal(result.output, 'Gaia says hello');
  assert.equal(result.error, undefined);
});

test('execute() native with generator and onDelta: uses stream() when available', async () => {
  let streamCalled = false;
  let generateCalled = false;
  const capabilities = { hermes: { invoke: async () => { throw new Error('must not be called'); } } };
  const nativeGenerator = {
    generate: async () => {
      generateCalled = true;
      return 'fallback';
    },
    stream: async (messages, { onDelta }) => {
      streamCalled = true;
      assert.deepEqual(messages, ['hello stream']);
      assert.equal(typeof onDelta, 'function');
      return 'Gaia says stream';
    }
  };
  const onDelta = (chunk) => {};
  const result = await execute(
    { action: 'native' },
    { capabilities, messages: ['hello stream'], nativeGenerator, onDelta }
  );
  assert.equal(streamCalled, true);
  assert.equal(generateCalled, false);
  assert.equal(result.action, 'native');
  assert.equal(result.output, 'Gaia says stream');
});

test('execute() native: Hermes is never called even when registered as a capability', async () => {
  const capabilities = { hermes: { invoke: async () => { throw new Error('must not be called'); } } };
  const nativeGenerator = {
    generate: async () => 'native win'
  };
  const result = await execute(
    { action: 'native' },
    { capabilities, nativeGenerator }
  );
  assert.equal(result.action, 'native');
  assert.equal(result.output, 'native win');
});

test('execute() capability: resolves and invokes exactly the named capability, passing through task/input/onDelta', async () => {
  const seen = [];
  const capabilities = {
    hermes: {
      invoke: async (messages, options) => {
        seen.push({ messages, options });
        return 'a reply';
      },
    },
  };
  const onDelta = () => {};
  const result = await execute(
    { action: 'capability', capability: 'hermes', task: 'respond', input: { a: 1 }, reason: 'test' },
    { capabilities, messages: ['m'], onDelta }
  );
  assert.equal(result.action, 'capability');
  assert.equal(result.capability, 'hermes');
  assert.equal(result.output, 'a reply');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].messages, ['m']);
  assert.equal(seen[0].options.onDelta, onDelta);
  assert.equal(seen[0].options.task, 'respond');
  assert.deepEqual(seen[0].options.input, { a: 1 });
});

test('execute() tool: resolves and invokes the named tool capability the same way as "capability"', async () => {
  const calls = [];
  const capabilities = { web: { invoke: async (messages, options) => { calls.push(options.task); return 'search result'; } } };
  const result = await execute(
    { action: 'tool', capability: 'web', task: 'act.perform', input: {}, reason: 'test' },
    { capabilities }
  );
  assert.equal(result.action, 'tool');
  assert.equal(result.output, 'search result');
  assert.deepEqual(calls, ['act.perform']);
});

test('execute() reports an error, without throwing, when the named capability is not available', async () => {
  const result = await execute(
    { action: 'capability', capability: 'ghost', task: 'x', input: {}, reason: 'test' },
    { capabilities: {} }
  );
  assert.equal(result.output, null);
  assert.match(result.error, /"ghost" is not available/);
});

test('execute() clarify: no capability call, structured result carries the decision\'s reason', async () => {
  const capabilities = { hermes: { invoke: async () => { throw new Error('must not be called'); } } };
  const result = await execute({ action: 'clarify', reason: 'ambiguous turn' }, { capabilities });
  assert.deepEqual(result, { action: 'clarify', output: null, reason: 'ambiguous turn' });
});

test('execute() refuse: no capability call, structured result carries the decision\'s reason', async () => {
  const capabilities = { hermes: { invoke: async () => { throw new Error('must not be called'); } } };
  const result = await execute({ action: 'refuse', reason: 'policy' }, { capabilities });
  assert.deepEqual(result, { action: 'refuse', output: null, reason: 'policy' });
});

test('execute() never makes its own judgment call — the same decision always executes the same way', async () => {
  let invokeCount = 0;
  const capabilities = { hermes: { invoke: async () => { invokeCount += 1; return 'x'; } } };
  const decision = { action: 'capability', capability: 'hermes', task: 't', input: {}, reason: 'r' };
  await execute(decision, { capabilities });
  await execute(decision, { capabilities });
  assert.equal(invokeCount, 2);
});
