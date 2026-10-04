const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fakePool');

const { pool } = require('../src/db/pool');
const patterns = require('../src/patterns');

function row(overrides = {}) {
  return {
    id: 'p1',
    bank_id: 'gaia',
    content: 'Bo tends to start creative work after 22:00',
    confidence: 0.6,
    coherence_score: 0.8,
    source_memory_ids: ['m1', 'm2'],
    sources: ['chronicle:obs1'],
    created_at: '2026-08-15T00:00:00Z',
    updated_at: '2026-08-15T00:00:00Z',
    ...overrides,
  };
}

test('create() rejects empty content', async () => {
  await assert.rejects(() => patterns.create('gaia', { content: '' }), /content is required/);
});

test('create() inserts and returns the new row', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row()] }));
  pool.query = fake.pool.query;

  const p = await patterns.create('gaia', { content: row().content, sourceMemoryIds: ['m1', 'm2'], sources: ['chronicle:obs1'] });
  assert.equal(p.content, row().content);
  assert.deepEqual(p.sources, ['chronicle:obs1']);
  assert.match(fake.calls[0].sql, /INSERT INTO patterns/);
  assert.deepEqual(fake.calls[0].params[5], ['chronicle:obs1']); // sources
});

test('get() throws NotFoundError when missing', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => patterns.get('gaia', 'missing'),
    (err) => err.name === 'NotFoundError',
  );
});

test('list() returns rows scoped to the bank', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row(), row({ id: 'p2' })] }));
  pool.query = fake.pool.query;

  const list = await patterns.list('gaia');
  assert.equal(list.length, 2);
  assert.match(fake.calls[0].sql, /WHERE bank_id = \$1/);
});

test('softDelete() throws NotFoundError when nothing was deleted', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rowCount: 0 }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => patterns.softDelete('gaia', 'missing'),
    (err) => err.name === 'NotFoundError',
  );
});
