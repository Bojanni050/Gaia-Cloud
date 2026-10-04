const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fakePool');

const { pool } = require('../src/db/pool');
const kairos = require('../src/kairosEpisodes');

function row(overrides = {}) {
  return {
    id: 'kei_gaia_obs1_obs9',
    bank_id: 'gaia',
    start_time: '2026-10-04T10:01:02.000Z',
    end_time: '2026-10-04T10:02:41.000Z',
    summary: 'Bojan bekeek een inkomende e-mail en antwoordde.',
    primary_app: 'Outlook',
    involved_apps: ['Outlook'],
    epistemic_status: 'interpretation',
    sources: ['chronicle:ingest:obs1', 'chronicle:ingest:obs9'],
    created_at: '2026-10-04T10:02:43.000Z',
    updated_at: '2026-10-04T10:02:43.000Z',
    ...overrides,
  };
}

test('create() requires id, times and a non-empty summary', async () => {
  await assert.rejects(() => kairos.create('gaia', { startTime: 'x', endTime: 'y', summary: 's' }), /id is required/);
  await assert.rejects(() => kairos.create('gaia', { id: 'e1', summary: 's' }), /start_time and end_time are required/);
  await assert.rejects(() => kairos.create('gaia', { id: 'e1', startTime: 'x', endTime: 'y', summary: '   ' }), /summary is required/);
});

test('create() upserts with the writer-owned id and always interpretation', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row()] }));
  pool.query = fake.pool.query;

  const e = await kairos.create('gaia', {
    id: row().id,
    startTime: row().start_time,
    endTime: row().end_time,
    summary: row().summary,
    primaryApp: 'Outlook',
    involvedApps: ['Outlook'],
    sources: ['chronicle:ingest:obs1', 'chronicle:ingest:obs9'],
  });
  assert.equal(e.epistemic_status, 'interpretation');
  assert.match(fake.calls[0].sql, /INSERT INTO kairos_episodes/);
  assert.match(fake.calls[0].sql, /ON CONFLICT \(bank_id, id\) DO UPDATE/);
  assert.equal(fake.calls[0].params[0], row().id); // id — writer-owned
  assert.equal(fake.calls[0].params[7], 'interpretation'); // epistemic_status literal
  assert.deepEqual(fake.calls[0].params[8], ['chronicle:ingest:obs1', 'chronicle:ingest:obs9']);
});

test('get() throws NotFoundError when missing', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [] }));
  pool.query = fake.pool.query;

  await assert.rejects(
    () => kairos.get('gaia', 'missing'),
    (err) => err.name === 'NotFoundError',
  );
});

test('list() is bank-scoped, newest-first, and reports pagination', async () => {
  const fake = makeFakePool();
  fake.setImpl(async (sql) => {
    if (/count\(\*\)/.test(sql)) return { rows: [{ total: 5 }] };
    return { rows: [row(), row({ id: 'kei_gaia_o2_o3', start_time: '2026-10-04T09:00:00.000Z' })] };
  });
  pool.query = fake.pool.query;

  const result = await kairos.list('gaia', { page: 2, limit: 2 });
  assert.equal(result.data.length, 2);
  assert.deepEqual(result.pagination, { page: 2, limit: 2, total_records: 5, has_more: true });
  assert.match(fake.calls[0].sql, /WHERE bank_id = \$1/);
  assert.match(fake.calls[1].sql, /ORDER BY start_time DESC/);
});

test('list() clamps limit to the maximum', async () => {
  const fake = makeFakePool();
  fake.setImpl(async (sql) => (/count\(\*\)/.test(sql) ? { rows: [{ total: 0 }] } : { rows: [] }));
  pool.query = fake.pool.query;

  const result = await kairos.list('gaia', { limit: 9999 });
  assert.equal(result.pagination.limit, kairos.MAX_LIMIT);
});

test('list() adds a start_time filter when since is supplied', async () => {
  const fake = makeFakePool();
  fake.setImpl(async (sql) => (/count\(\*\)/.test(sql) ? { rows: [{ total: 0 }] } : { rows: [] }));
  pool.query = fake.pool.query;

  await kairos.list('gaia', { since: '2026-10-01T00:00:00.000Z' });
  assert.match(fake.calls[0].sql, /start_time >= \$2/);
  assert.equal(fake.calls[0].params[1], '2026-10-01T00:00:00.000Z');
});

test('getState() returns null when the bank has no watermark row', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [] }));
  pool.query = fake.pool.query;

  assert.equal(await kairos.getState('gaia'), null);
});

test('setState() advances monotonically (GREATEST, never backwards)', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [{ bank_id: 'gaia', last_captured_at: '2026-10-04T10:02:41.000Z' }] }));
  pool.query = fake.pool.query;

  const r = await kairos.setState('gaia', '2026-10-04T10:02:41.000Z');
  assert.equal(r.last_captured_at, '2026-10-04T10:02:41.000Z');
  assert.match(fake.calls[0].sql, /GREATEST\(kairos_state\.last_captured_at, EXCLUDED\.last_captured_at\)/);
});

test('setState() rejects an empty timestamp', async () => {
  await assert.rejects(() => kairos.setState('gaia', ''), /last_captured_at is required/);
});
