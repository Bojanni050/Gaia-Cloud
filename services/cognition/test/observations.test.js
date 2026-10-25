const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fakePool');

const { pool } = require('../src/db/pool');
const observations = require('../src/observations');

function row(overrides = {}) {
  return {
    id: 'o1',
    bank_id: 'gaia',
    statement: 'They prefer short answers.',
    evidence_items: [],
    conversation_id: 'conv-7',
    observed_at: '2026-10-22T09:15:00Z',
    consumed_by_id: null,
    consumed_at: null,
    created_at: '2026-10-22T09:15:00Z',
    ...overrides,
  };
}

test('create() refuses an observation without a statement', async () => {
  await assert.rejects(
    () => observations.create('gaia', { statement: '   ' }),
    (err) => err.name === 'ValidationError',
  );
});

test('create() stores the statement with its evidence snapshot and moment', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row()] }));
  pool.query = fake.pool.query;

  await observations.create('gaia', {
    statement: '  They prefer short answers.  ',
    evidenceItems: [{ id: 'hindsight-1', source: 'hindsight', sourceRef: 'fact-88', content: 'short answers' }],
    conversationId: 'conv-7',
    observedAt: '2026-10-22T09:15:00.000Z',
  });

  assert.equal(fake.calls[0].params[1], 'They prefer short answers.');
  assert.deepEqual(JSON.parse(fake.calls[0].params[2]), [
    { id: 'hindsight-1', source: 'hindsight', sourceRef: 'fact-88', content: 'short answers' },
  ]);
  assert.equal(fake.calls[0].params[3], 'conv-7');
  assert.equal(fake.calls[0].params[4], '2026-10-22T09:15:00.000Z');
});

test('create() drops an evidence entry nobody could read', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row()] }));
  pool.query = fake.pool.query;

  await observations.create('gaia', {
    statement: 'x',
    evidenceItems: [{ id: 'hindsight-1', content: '  ' }, { content: 'no id' }],
  });

  assert.deepEqual(JSON.parse(fake.calls[0].params[2]), []);
});

test('list() reads the open observations unless consumed is asked for', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row()] }));
  pool.query = fake.pool.query;

  await observations.list('gaia');
  assert.equal(fake.calls[0].params[1], false);
  assert.equal(fake.calls[0].params[2], 200);

  await observations.list('gaia', { consumed: true, limit: 5 });
  assert.equal(fake.calls[1].params[1], true);
  assert.equal(fake.calls[1].params[2], 5);
});

test('markConsumed() never takes an observation away from the statement it already fed', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [], rowCount: 1 }));
  pool.query = fake.pool.query;

  const outcome = await observations.markConsumed('gaia', ['o1', 'o2'], 'h-9');

  assert.deepEqual(fake.calls[0].params[1], ['o1', 'o2']);
  assert.equal(fake.calls[0].params[2], 'h-9');
  assert.match(fake.calls[0].sql, /consumed_at IS NULL/);
  assert.deepEqual(outcome, { consumed: 1 });
});

test('markConsumed() with no ids touches nothing', async () => {
  const fake = makeFakePool();
  pool.query = fake.pool.query;

  assert.deepEqual(await observations.markConsumed('gaia', [], 'h-9'), { consumed: 0 });
  assert.equal(fake.calls.length, 0);
});

test('mergeRecallGround() unions the new unit ids with the existing ground and reports the size', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [{ recall_ground: ['unit-1', 'unit-2', 'unit-3'] }] }));
  pool.query = fake.pool.query;

  const outcome = await observations.mergeRecallGround('gaia', 'o1', ['unit-2', 'unit-3', '  ', null]);

  assert.match(fake.calls[0].sql, /recall_ground/);
  assert.match(fake.calls[0].sql, /array_agg\(DISTINCT unit_id\)/);
  assert.equal(fake.calls[0].params[0], 'gaia');
  assert.equal(fake.calls[0].params[1], 'o1');
  assert.deepEqual(fake.calls[0].params[2], ['unit-2', 'unit-3']);
  assert.deepEqual(outcome, { merged: 3 });
});

test('mergeRecallGround() with no usable ids touches nothing and keeps NULL distinct from empty', async () => {
  const fake = makeFakePool();
  pool.query = fake.pool.query;

  assert.deepEqual(await observations.mergeRecallGround('gaia', 'o1', []), { merged: 0 });
  assert.deepEqual(await observations.mergeRecallGround('gaia', 'o1', null), { merged: 0 });
  assert.deepEqual(await observations.mergeRecallGround('gaia', 'o1', ['  ', 42]), { merged: 0 });
  assert.equal(fake.calls.length, 0);
});
