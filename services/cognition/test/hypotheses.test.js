const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fakePool');

const { pool } = require('../src/db/pool');
const hypotheses = require('../src/hypotheses');

function row(overrides = {}) {
  return {
    id: 'h1',
    bank_id: 'gaia',
    kind: 'hypothesis',
    statement: 'Bo is more creatively productive late at night',
    confidence: 0.7,
    status: 'proposed',
    verification_plan: '',
    evidence_memory_ids: [],
    sources: [],
    supersedes_id: null,
    superseded_by_id: null,
    confirmed_document_id: null,
    rejection_reason: null,
    verwerp_bron: null,
    tested_at: null,
    confirmed_at: null,
    rejected_at: null,
    created_at: '2026-08-15T00:00:00Z',
    updated_at: '2026-08-15T00:00:00Z',
    ...overrides,
  };
}

test('propose() rejects an empty statement', async () => {
  await assert.rejects(() => hypotheses.propose('gaia', { statement: '' }), /statement is required/);
});

test('propose() rejects an unknown kind', async () => {
  await assert.rejects(
    () => hypotheses.propose('gaia', { statement: 'x', kind: 'fact' }),
    (err) => err.name === 'ValidationError',
  );
});

test('propose() inserts and returns the new row (defaults kind=hypothesis)', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row()] }));
  pool.query = fake.pool.query;

  const h = await hypotheses.propose('gaia', { statement: row().statement, confidence: 0.7, sources: ['chronicle:abc'] });

  assert.equal(h.kind, 'hypothesis');
  assert.match(fake.calls[0].sql, /INSERT INTO hypotheses/);
  assert.deepEqual(fake.calls[0].params[5], ['chronicle:abc']); // sources
});

test('propose() can store a candidate mental model', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ kind: 'mental_model' })] }));
  pool.query = fake.pool.query;

  const h = await hypotheses.propose('gaia', { statement: 'Bo prefers directness', kind: 'mental_model' });
  assert.equal(h.kind, 'mental_model');
});

test('markTesting() transitions proposed -> testing', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'proposed' })] }; // get()
    return { rows: [row({ status: 'testing' })] }; // update
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.markTesting('gaia', 'h1');
  assert.equal(h.status, 'testing');
});

test('markTesting() refuses to leave a confirmed hypothesis', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ status: 'confirmed' })] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.markTesting('gaia', 'h1'),
    (err) => err.name === 'InvalidTransitionError',
  );
});

test('markCorroborated() soft-promotes testing -> corroborated', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'testing' })] };
    return { rows: [row({ status: 'corroborated', confidence: 0.82 })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.markCorroborated('gaia', 'h1');
  assert.equal(h.status, 'corroborated');
});

test('markCorroborated() cannot touch a confirmed hypothesis (Absolute Override holds)', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ status: 'confirmed' })] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.markCorroborated('gaia', 'h1'),
    (err) => err.name === 'InvalidTransitionError',
  );
});

test('confirm() promotes corroborated -> confirmed and does NOT write to Hindsight', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async (sql) => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'corroborated' })] }; // get()
    assert.match(sql, /UPDATE hypotheses SET status = 'confirmed'/);
    return { rows: [row({ status: 'confirmed' })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.confirm('gaia', 'h1');
  assert.equal(h.status, 'confirmed');
  assert.equal(fake.calls[1].params.length, 2, 'confirm writes no document id — sync is Logos\' job');
});

test('confirm() refuses to confirm a rejected hypothesis', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ status: 'rejected' })] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.confirm('gaia', 'h1'),
    (err) => err.name === 'InvalidTransitionError',
  );
});

test('reject() is allowed directly from proposed and defaults verwerp_bron to mens', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'proposed' })] };
    return { rows: [row({ status: 'rejected', rejection_reason: 'no evidence', verwerp_bron: 'mens' })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.reject('gaia', 'h1', 'no evidence');
  assert.equal(h.status, 'rejected');
  assert.equal(h.rejection_reason, 'no evidence');
  assert.equal(h.verwerp_bron, 'mens');
  assert.equal(fake.calls[1].params[3], 'mens');
});

test('reject() accepts verwerp_bron consolidation', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'testing' })] };
    return { rows: [row({ status: 'rejected', verwerp_bron: 'consolidatie' })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.reject('gaia', 'h1', 'superseded', 'consolidatie');
  assert.equal(h.verwerp_bron, 'consolidatie');
});

test('reject() rejects an unknown verwerp_bron', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ status: 'testing' })] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.reject('gaia', 'h1', 'x', 'because'),
    (err) => err.name === 'ValidationError',
  );
});

test('supersede() rejects the old statement marking it consolidatie and pointing at the winner', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'confirmed' })] }; // get() — even a confirmed one may be superseded
    return { rows: [row({ status: 'rejected', verwerp_bron: 'consolidatie', superseded_by_id: 'h2' })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.supersede('gaia', 'h1', { supersededById: 'h2', reason: 'newer value' });
  assert.equal(h.status, 'rejected');
  assert.equal(h.verwerp_bron, 'consolidatie');
  assert.equal(h.superseded_by_id, 'h2');
});

test('supersede() requires a superseded_by_id', async () => {
  await assert.rejects(
    () => hypotheses.supersede('gaia', 'h1', {}),
    (err) => err.name === 'ValidationError',
  );
});

test('supersede() is idempotent for an already-superseded record', async () => {
  const fake = makeFakePool();
  let calls = 0;
  fake.setImpl(async () => {
    calls += 1;
    return { rows: [row({ status: 'rejected', verwerp_bron: 'consolidatie', superseded_by_id: 'h2' })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.supersede('gaia', 'h1', { supersededById: 'h2' });
  assert.equal(h.superseded_by_id, 'h2');
  assert.equal(calls, 1, 'no UPDATE when already superseded');
});

test('update() from testing status resets to proposed (refine)', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async (sql) => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'testing' })] };
    assert.match(sql, /UPDATE hypotheses/);
    return { rows: [row({ status: 'proposed', confidence: 0.4 })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.update('gaia', 'h1', { confidence: 0.4 });
  assert.equal(h.status, 'proposed');
});

test('update() from corroborated also resets to proposed (refine invalidates the soft-promotion)', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'corroborated' })] };
    return { rows: [row({ status: 'proposed', confidence: 0.4 })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.update('gaia', 'h1', { confidence: 0.4 });
  assert.equal(h.status, 'proposed');
});

test('update() refuses to edit a confirmed hypothesis', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ status: 'confirmed' })] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.update('gaia', 'h1', { confidence: 0.9 }),
    (err) => err.name === 'InvalidTransitionError',
  );
});

test('get() throws NotFoundError when the row is missing', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.get('gaia', 'missing'),
    (err) => err.name === 'NotFoundError',
  );
});

test('softDelete() throws NotFoundError when nothing was deleted', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rowCount: 0 }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.softDelete('gaia', 'missing'),
    (err) => err.name === 'NotFoundError',
  );
});
