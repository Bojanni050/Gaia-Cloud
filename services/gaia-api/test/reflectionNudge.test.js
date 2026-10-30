'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReflectionNudge, DEFAULT_NUDGE_INTERVAL } = require('../src/reasoning/reflectionNudge');

test('fires on every Nth turn of the same conversation, not on every turn', () => {
  const nudge = createReflectionNudge({ everyTurns: 3 });

  assert.equal(nudge.noteTurn('c1'), false); // 1
  assert.equal(nudge.noteTurn('c1'), false); // 2
  assert.equal(nudge.noteTurn('c1'), true);  // 3 — nudge
  assert.equal(nudge.noteTurn('c1'), false); // 1 again
  assert.equal(nudge.noteTurn('c1'), false); // 2
  assert.equal(nudge.noteTurn('c1'), true);  // 3 — nudge again
});

test('counts per conversation, independently', () => {
  const nudge = createReflectionNudge({ everyTurns: 2 });

  assert.equal(nudge.noteTurn('c1'), false);
  assert.equal(nudge.noteTurn('c2'), false); // c2 has its own counter
  assert.equal(nudge.noteTurn('c1'), true);  // c1's 2nd
  assert.equal(nudge.noteTurn('c2'), true);  // c2's 2nd
});

test('defaults to the Hermes interval (10) when nothing valid is configured', () => {
  assert.equal(DEFAULT_NUDGE_INTERVAL, 10);

  const nudge = createReflectionNudge();
  let fired = 0;
  for (let i = 0; i < DEFAULT_NUDGE_INTERVAL; i += 1) {
    if (nudge.noteTurn('c1')) fired += 1;
  }
  assert.equal(fired, 1); // exactly on the 10th retained turn
});

test('ignores invalid intervals and falls back to the default', () => {
  for (const bad of [0, -1, NaN, 'nope', null]) {
    const nudge = createReflectionNudge({ everyTurns: bad });
    assert.equal(nudge.noteTurn('c1'), false); // behaves, never throws
  }
});

test('a missing or invalid conversationId is never a nudge turn', () => {
  const nudge = createReflectionNudge({ everyTurns: 1 });
  assert.equal(nudge.noteTurn(undefined), false);
  assert.equal(nudge.noteTurn(null), false);
  assert.equal(nudge.noteTurn(''), false);
  assert.equal(nudge.noteTurn(42), false);
});
