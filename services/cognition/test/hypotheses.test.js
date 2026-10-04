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
    evidence_for: [],
    evidence_against: [],
    persistence: 'ephemeral',
    method: 'asserted',
    sources: [],
    supersedes_id: null,
    superseded_by_id: null,
    counter_hypothesis: 'a plausible opposing reading',
    scope: 'macro',
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
  assert.deepEqual(fake.calls[0].params[9], ['chronicle:abc']); // sources
});

test('propose() carries evidence, persistence and method', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ persistence: 'durable', method: 'derived' })] }));
  pool.query = fake.pool.query;

  const h = await hypotheses.propose('gaia', {
    statement: 'x', evidenceFor: ['m1'], evidenceAgainst: ['m2'], persistence: 'durable', method: 'derived',
  });

  assert.equal(h.persistence, 'durable');
  assert.equal(h.method, 'derived');
  assert.deepEqual(fake.calls[0].params[5], ['m1']); // evidence_for
  assert.deepEqual(fake.calls[0].params[6], ['m2']); // evidence_against
  assert.equal(fake.calls[0].params[7], 'durable');  // persistence
  assert.equal(fake.calls[0].params[8], 'derived');  // method
});

test('propose() carries the counter-hypothesis and scope', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ counter_hypothesis: 'the opposite reading', scope: 'micro' })] }));
  pool.query = fake.pool.query;

  const h = await hypotheses.propose('gaia', {
    statement: 'x', counterHypothesis: 'the opposite reading', scope: 'micro',
  });

  assert.equal(h.counter_hypothesis, 'the opposite reading');
  assert.equal(h.scope, 'micro');
  assert.equal(fake.calls[0].params[12], 'the opposite reading'); // counter_hypothesis
  assert.equal(fake.calls[0].params[13], 'micro');               // scope
});

test('propose() rejects an unknown scope', async () => {
  await assert.rejects(
    () => hypotheses.propose('gaia', { statement: 'x', scope: 'enormous' }),
    (err) => err.name === 'ValidationError',
  );
});

test('propose() rejects an unknown persistence or method', async () => {
  await assert.rejects(
    () => hypotheses.propose('gaia', { statement: 'x', persistence: 'forever' }),
    (err) => err.name === 'ValidationError',
  );
  await assert.rejects(
    () => hypotheses.propose('gaia', { statement: 'x', method: 'guessed' }),
    (err) => err.name === 'ValidationError',
  );
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
  assert.equal(fake.calls[1].params.length, 3, 'confirm writes no document id — sync is Logos\' job');
});

test('confirm() refuses when the counter-hypothesis is missing', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ status: 'corroborated', counter_hypothesis: null })] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.confirm('gaia', 'h1'),
    (err) => err.name === 'ValidationError' && /counter-hypothesis/.test(err.message),
  );
});

test('confirm() writes the human nuanced statement as one audited act', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'testing' })] };
    return { rows: [row({ status: 'confirmed', statement: 'only late at night when nobody asks' })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.confirm('gaia', 'h1', { statement: 'only late at night when nobody asks' });
  assert.equal(h.statement, 'only late at night when nobody asks');
  assert.equal(fake.calls[1].params[2], 'only late at night when nobody asks');
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

test('reopen() lifts a rejected record back to testing and clears the rejection', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async (sql) => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'rejected', rejection_reason: 'old', verwerp_bron: 'mens' })] };
    assert.match(sql, /UPDATE hypotheses SET status = 'testing'/);
    return { rows: [row({ status: 'testing', rejection_reason: null, verwerp_bron: null })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.reopen('gaia', 'h1', { reason: 'the disproof was retracted' });
  assert.equal(h.status, 'testing');
  assert.equal(h.rejection_reason, null);
});

test('reopen() requires a reason', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ status: 'rejected' })] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.reopen('gaia', 'h1', {}),
    (err) => err.name === 'ValidationError' && /reason/.test(err.message),
  );
});

test('reopen() refuses a non-rejected record', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ status: 'testing' })] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.reopen('gaia', 'h1', { reason: 'why not' }),
    (err) => err.name === 'InvalidTransitionError',
  );
});

test('markTesting() still refuses a rejected record (reopen is the only exit)', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ status: 'rejected' })] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.markTesting('gaia', 'h1'),
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

test('update() demotes testing -> proposed only when the statement changes (refine)', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async (sql) => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'testing', statement: 'old formulation' })] };
    assert.match(sql, /UPDATE hypotheses/);
    return { rows: [row({ status: 'proposed', statement: 'a new formulation' })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.update('gaia', 'h1', { statement: 'a new formulation' });
  assert.equal(h.status, 'proposed');
});

test('update() keeps testing when only confidence changes (no silent demotion)', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'testing' })] };
    return { rows: [row({ status: 'testing', confidence: 0.4 })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.update('gaia', 'h1', { confidence: 0.4 });
  assert.equal(h.status, 'testing');
});

test('update() from corroborated also demotes to proposed on a statement change', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'corroborated', statement: 'old' })] };
    return { rows: [row({ status: 'proposed', statement: 'new' })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.update('gaia', 'h1', { statement: 'new' });
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

test('applyEvidence: supports records evidence_for, raises confidence and opens testing', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'proposed', confidence: 0.5, evidence_for: [] })] };
    return { rows: [row({ status: 'testing', confidence: 0.6, evidence_for: ['m1'] })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.applyEvidence('gaia', 'h1', { relation: 'supports', evidenceId: 'm1', confidenceDelta: 0.1 });
  assert.equal(h.status, 'testing');
  assert.deepEqual(h.evidence_for, ['m1']);
  assert.equal(fake.calls[1].params[4], 0.6); // confidence
});

test('applyEvidence: contradicts demotes a confirmed statement back to testing', async () => {
  const fake = makeFakePool();
  let call = 0;
  fake.setImpl(async () => {
    call += 1;
    if (call === 1) return { rows: [row({ status: 'confirmed', confidence: 0.9, evidence_against: [] })] };
    return { rows: [row({ status: 'testing', confidence: 0.75, evidence_against: ['m9'] })] };
  });
  pool.query = fake.pool.query;

  const h = await hypotheses.applyEvidence('gaia', 'h1', { relation: 'contradicts', evidenceId: 'm9' });
  assert.equal(h.status, 'testing');
  assert.deepEqual(h.evidence_against, ['m9']);
  assert.equal(fake.calls[1].params[4], 0.75); // 0.9 - default 0.15
});

test('applyEvidence: rejects an unknown relation and never confirms', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row({ status: 'testing' })] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => hypotheses.applyEvidence('gaia', 'h1', { relation: 'confirmed' }),
    (err) => err.name === 'ValidationError',
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
