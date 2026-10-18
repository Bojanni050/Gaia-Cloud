'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { skipWhileRunning } = require('../src/skipWhileRunning');

test('a tick that fires while the previous run is going is skipped', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  const guarded = skipWhileRunning(async () => { runs += 1; await gate; return 'done'; });

  const first = guarded();
  const second = await guarded();
  assert.equal(second, undefined, 'the overlapping tick did nothing');
  release();
  assert.equal(await first, 'done');
  assert.equal(runs, 1);
});

test('the guard is released after a run, also when it rejects', async () => {
  let runs = 0;
  const guarded = skipWhileRunning(async () => {
    runs += 1;
    if (runs === 1) throw new Error('boom');
    return 'ok';
  });
  await assert.rejects(guarded(), /boom/);
  assert.equal(await guarded(), 'ok', 'the next tick runs normally');
  assert.equal(runs, 2);
});
