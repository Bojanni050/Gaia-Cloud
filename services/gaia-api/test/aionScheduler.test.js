'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAionScheduler } = require('../src/reasoning/aionScheduler');

function fakeTimer() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
  };
}

function recordingWriter() {
  const writes = [];
  return {
    writes,
    writer: {
      async write({ messages }) {
        writes.push(messages);
        return { written: 1, candidates: 1 };
      },
    },
  };
}

const msg = (t) => [{ role: 'user', content: t }];

test('runs the pass every N turns, not on every turn', async () => {
  const { writes, writer } = recordingWriter();
  const sched = createAionScheduler({ getWriter: () => writer, everyTurns: 3, idleMs: 0 });

  for (let i = 0; i < 5; i += 1) {
    await sched.noteTurn({ conversationId: 'c1', messages: msg(`m${i}`) });
  }

  assert.equal(writes.length, 1); // only on the 3rd turn
});

test('flushes the previous conversation when a new one starts (session end)', async () => {
  const { writes, writer } = recordingWriter();
  const sched = createAionScheduler({ getWriter: () => writer, everyTurns: 5, idleMs: 0 });

  await sched.noteTurn({ conversationId: 'c1', messages: msg('a') });
  assert.equal(writes.length, 0);
  await sched.noteTurn({ conversationId: 'c2', messages: msg('b') });

  assert.equal(writes.length, 1); // c1 flushed when c2 arrived
  assert.equal(sched.size(), 1);
});

test('flushes a conversation once it goes idle', async () => {
  const { writes, writer } = recordingWriter();
  const timer = fakeTimer();
  const sched = createAionScheduler({
    getWriter: () => writer, everyTurns: 5, idleMs: 60000,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer,
  });

  await sched.noteTurn({ conversationId: 'c1', messages: msg('a') });
  assert.equal(writes.length, 0);
  assert.equal(timer.timers.length, 1);

  await timer.timers[0].fn();

  assert.equal(writes.length, 1);
  assert.equal(sched.size(), 0);
});

test('a later turn re-arms the idle timer instead of flushing early', async () => {
  const { writes, writer } = recordingWriter();
  const timer = fakeTimer();
  const sched = createAionScheduler({
    getWriter: () => writer, everyTurns: 5, idleMs: 60000,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer,
  });

  await sched.noteTurn({ conversationId: 'c1', messages: msg('a') });
  await sched.noteTurn({ conversationId: 'c1', messages: msg('b') });

  assert.equal(timer.timers[0].cleared, true);
  assert.equal(timer.timers.length, 2);
  assert.equal(writes.length, 0);
});

test('flushAll drains every tracked conversation', async () => {
  const { writes, writer } = recordingWriter();
  const sched = createAionScheduler({ getWriter: () => writer, everyTurns: 5, idleMs: 0 });

  await sched.noteTurn({ conversationId: 'c1', messages: msg('a') });
  await sched.flushAll();

  assert.equal(writes.length, 1);
  assert.equal(sched.size(), 0);
});

test('never throws when no writer is configured or the writer fails', async () => {
  const none = createAionScheduler({ getWriter: () => null, everyTurns: 1, idleMs: 0 });
  assert.deepEqual(await none.noteTurn({ conversationId: 'c', messages: msg('a') }), { written: 0, skipped: 'no-writer' });

  const boom = createAionScheduler({
    getWriter: () => ({ write: async () => { throw new Error('boom'); } }),
    everyTurns: 1, idleMs: 0,
  });
  assert.deepEqual(await boom.noteTurn({ conversationId: 'c', messages: msg('a') }), { written: 0, skipped: 'failed' });
});
