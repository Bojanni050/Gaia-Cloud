'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTurnTiming, trackFirstToken } = require('../src/timing');

// --- createTurnTiming ---

test('timing: creates context with traceId', () => {
  const logs = [];
  const t = createTurnTiming('trace-1', { log: (line) => logs.push(line) });
  t.start('turn');
  t.end('turn');
  assert.ok(logs.length > 0);
  const event = JSON.parse(logs[0]);
  assert.equal(event.kind, 'gaia.timing');
  assert.equal(event.traceId, 'trace-1');
  assert.equal(event.stage, 'turn');
  assert.ok(typeof event.durationMs === 'number');
  assert.ok(event.durationMs >= 0);
});

test('timing: start/end measures duration', () => {
  const logs = [];
  const t = createTurnTiming('trace-2', { log: (line) => logs.push(line) });
  t.start('intent');
  // Simulate some work
  const start = Date.now();
  while (Date.now() - start < 5) {}
  t.end('intent');
  const event = JSON.parse(logs.find((l) => JSON.parse(l).stage === 'intent'));
  assert.ok(event.durationMs >= 3);
});

test('timing: multiple stages', () => {
  const logs = [];
  const t = createTurnTiming('trace-3', { log: (line) => logs.push(line) });
  t.start('intent');
  t.end('intent');
  t.start('reasoniq');
  t.end('reasoniq');
  t.start('decision');
  t.end('decision');
  const stages = logs.map((l) => JSON.parse(l).stage);
  assert.deepEqual(stages, ['intent', 'reasoniq', 'decision']);
});

test('timing: extra fields are included', () => {
  const logs = [];
  const t = createTurnTiming('trace-4', { log: (line) => logs.push(line) });
  t.start('capability.web');
  t.end('capability.web', { capability: 'web', stepId: 'step-1' });
  const event = JSON.parse(logs[0]);
  assert.equal(event.capability, 'web');
  assert.equal(event.stepId, 'step-1');
});

test('timing: fail logs failed stage', () => {
  const logs = [];
  const t = createTurnTiming('trace-5', { log: (line) => logs.push(line) });
  t.start('capability.hermes');
  t.fail('capability.hermes', 'TimeoutError', { capability: 'hermes' });
  const event = JSON.parse(logs[0]);
  assert.equal(event.stage, 'capability.hermes.failed');
  assert.equal(event.errorType, 'TimeoutError');
  assert.equal(event.capability, 'hermes');
});

test('timing: done logs turn.done with breakdown', () => {
  const logs = [];
  const t = createTurnTiming('trace-6', { log: (line) => logs.push(line) });
  t.start('turn');
  t.start('intent');
  t.end('intent');
  t.end('turn');
  t.done({ intentMs: 5, retrievalMs: 0, reasoningMs: 0, decisionMs: 1, capabilityMs: 0 });
  const doneEvent = JSON.parse(logs.find((l) => JSON.parse(l).stage === 'turn.done'));
  assert.equal(doneEvent.kind, 'gaia.timing');
  assert.equal(doneEvent.stage, 'turn.done');
  assert.ok(doneEvent.totalDurationMs >= 0);
  assert.equal(doneEvent.intentMs, 5);
  assert.equal(doneEvent.retrievalMs, 0);
});

test('timing: getDuration returns completed stage duration', () => {
  const logs = [];
  const t = createTurnTiming('trace-7', { log: (line) => logs.push(line) });
  t.start('intent');
  t.end('intent');
  const duration = t.getDuration('intent');
  assert.ok(typeof duration === 'number');
  assert.ok(duration >= 0);
  assert.equal(t.getDuration('nonexistent'), null);
});

test('timing: getEvents returns all events', () => {
  const logs = [];
  const t = createTurnTiming('trace-8', { log: (line) => logs.push(line) });
  t.start('intent');
  t.end('intent');
  t.start('decision');
  t.end('decision');
  const events = t.getEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].stage, 'intent');
  assert.equal(events[1].stage, 'decision');
});

test('timing: never throws on log failure', () => {
  const brokenLog = () => { throw new Error('log broken'); };
  const t = createTurnTiming('trace-9', { log: brokenLog });
  t.start('intent');
  t.end('intent'); // should not throw
  t.start('capability.x');
  t.fail('capability.x', 'Error'); // should not throw
  t.done(); // should not throw
});

test('timing: durationMs is rounded to 2 decimals', () => {
  const logs = [];
  const t = createTurnTiming('trace-10', { log: (line) => logs.push(line) });
  t.start('intent');
  t.end('intent');
  const event = JSON.parse(logs[0]);
  const parts = String(event.durationMs).split('.');
  assert.ok(parts.length <= 2);
  if (parts.length === 2) {
    assert.ok(parts[1].length <= 2);
  }
});

// --- trackFirstToken ---

test('firstToken: captures time to first token', (_, done) => {
  let capturedMs = null;
  const wrapped = trackFirstToken(null, { onFirstToken: (ms) => { capturedMs = ms; } });
  // Simulate a small delay then first token
  setTimeout(() => {
    wrapped('hello', false);
    assert.ok(capturedMs !== null);
    assert.ok(capturedMs >= 0);
    done();
  }, 5);
});

test('firstToken: does not fire on reasoning chunks', (_, done) => {
  let captured = false;
  const wrapped = trackFirstToken(null, { onFirstToken: () => { captured = true; } });
  wrapped('thinking...', true); // reasoning
  assert.equal(captured, false);
  wrapped('actual content', false); // content
  assert.equal(captured, true);
  done();
});

test('firstToken: does not fire on empty chunks', () => {
  let captured = false;
  const wrapped = trackFirstToken(null, { onFirstToken: () => { captured = true; } });
  wrapped('', false);
  wrapped(null, false);
  wrapped(undefined, false);
  assert.equal(captured, false);
});

test('firstToken: forwards to original onDelta', () => {
  const received = [];
  const wrapped = trackFirstToken((chunk, isReasoning) => { received.push({ chunk, isReasoning }); });
  wrapped('hello', false);
  wrapped('thinking', true);
  assert.equal(received.length, 2);
  assert.equal(received[0].chunk, 'hello');
  assert.equal(received[1].isReasoning, true);
});

test('firstToken: works without original onDelta', () => {
  const wrapped = trackFirstToken(null, { onFirstToken: () => {} });
  wrapped('hello', false); // should not throw
});

// --- Integration with runTurnCore timing ---

test('timing: runTurnCore produces timing events', async () => {
  const { performTurn } = require('../src/turn');
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => { if (typeof line === 'string' && line.includes('gaia.timing')) logs.push(line); };

  try {
    const result = await performTurn({
      messages: [{ role: 'user', content: 'hello' }],
      documents: {},
      hermes: { chat: async () => 'hi there' },
      nativeGenerator: { generate: async () => 'hi there', stream: async (msgs, { onDelta }) => { onDelta('hi there', false); return 'hi there'; } },
      traceId: 'test-trace',
    });
    assert.equal(result.status, 200);

    const timingEvents = logs.map((l) => JSON.parse(l));
    // Should have turn.done
    const turnDone = timingEvents.find((e) => e.stage === 'turn.done');
    assert.ok(turnDone, 'turn.done event should exist');
    assert.equal(turnDone.traceId, 'test-trace');
    assert.ok(turnDone.totalDurationMs >= 0);
    assert.ok(typeof turnDone.intentMs === 'number');
    assert.ok(typeof turnDone.retrievalMs === 'number');
    assert.ok(typeof turnDone.reasoningMs === 'number');
    assert.ok(typeof turnDone.decisionMs === 'number');
    assert.ok(typeof turnDone.capabilityMs === 'number');
  } finally {
    console.log = originalLog;
  }
});

test('timing: no secrets in timing events', async () => {
  const { performTurn } = require('../src/turn');
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => { if (typeof line === 'string') logs.push(line); };

  try {
    await performTurn({
      messages: [{ role: 'user', content: 'hello' }],
      documents: {},
      hermes: { chat: async () => 'response' },
      nativeGenerator: { generate: async () => 'response' },
      traceId: 'test-trace',
    });

    const allOutput = logs.join('\n');
    // Should not contain API keys or secrets
    assert.ok(!allOutput.includes('sk-'), 'should not contain API keys');
    assert.ok(!allOutput.includes('Bearer '), 'should not contain auth tokens');
    assert.ok(!allOutput.includes('Authorization'), 'should not contain auth headers');
  } finally {
    console.log = originalLog;
  }
});

test('timing: stages appear in correct order', async () => {
  const { performTurn } = require('../src/turn');
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => { if (typeof line === 'string' && line.includes('gaia.timing')) logs.push(line); };

  try {
    await performTurn({
      messages: [{ role: 'user', content: 'hello' }],
      documents: {},
      hermes: { chat: async () => 'response' },
      nativeGenerator: { generate: async () => 'response' },
      traceId: 'test-trace',
    });

    const timingEvents = logs.map((l) => JSON.parse(l));
    const stageOrder = timingEvents.map((e) => e.stage);
    // turn.done should be last
    assert.equal(stageOrder[stageOrder.length - 1], 'turn.done');
    // capability should come before turn.done
    const capIdx = stageOrder.findIndex((s) => s === 'capability');
    const turnIdx = stageOrder.findIndex((s) => s === 'turn.done');
    if (capIdx >= 0) assert.ok(capIdx < turnIdx);
  } finally {
    console.log = originalLog;
  }
});
