const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fakePool');

const { pool } = require('../src/db/pool');
const digests = require('../src/kairosDigests');

function row(overrides = {}) {
  return {
    id: 'kdi_gaia_2026-11-06',
    bank_id: 'gaia',
    digest_date: '2026-11-06',
    timezone: 'Europe/Amsterdam',
    title: 'Werken aan Gaia en een WordPress-wachtwoord',
    summary: 'Bojan werkte aan Gaia en herstelde een wachtwoord.',
    episode_count: 2,
    episode_ids: ['kei_1', 'kei_2'],
    apps: ['msedge', 'whatsapp'],
    model: 'akash/gpt-oss-120b',
    created_at: '2026-11-07T06:00:00.000Z',
    updated_at: '2026-11-07T06:00:00.000Z',
    ...overrides,
  };
}

test('upsert() refuses a date that is not YYYY-MM-DD', async () => {
  await assert.rejects(
    () => digests.upsert('gaia', { date: '6-11-2026', summary: 's' }),
    /digest_date must be YYYY-MM-DD/,
  );
  await assert.rejects(
    () => digests.upsert('gaia', { date: '2026-02-31', summary: 's' }),
    /not a real date/,
  );
});

test('upsert() requires a non-empty summary', async () => {
  await assert.rejects(
    () => digests.upsert('gaia', { date: '2026-11-06', summary: '   ' }),
    /summary is required/,
  );
});

test('upsert() writes the deterministic id and derives episode_count', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row()] }));
  pool.query = fake.pool.query;

  const saved = await digests.upsert('gaia', {
    date: '2026-11-06',
    title: '  Werken aan Gaia  ',
    summary: '  Bojan werkte aan Gaia.  ',
    episodeIds: ['kei_1', 'kei_2', 'kei_2', '  '],
    apps: ['msedge', 'msedge', 'whatsapp'],
    model: 'akash/gpt-oss-120b',
  });

  assert.equal(saved.digest_date, '2026-11-06');
  assert.match(fake.calls[0].sql, /INSERT INTO kairos_digests/);
  assert.match(fake.calls[0].sql, /ON CONFLICT \(bank_id, digest_date\) DO UPDATE/);
  assert.equal(fake.calls[0].params[0], 'kdi_gaia_2026-11-06');
  assert.equal(fake.calls[0].params[4], 'Werken aan Gaia'); // title, trimmed
  assert.equal(fake.calls[0].params[5], 'Bojan werkte aan Gaia.'); // summary, trimmed
  assert.equal(fake.calls[0].params[6], 2); // episode_count, duplicates dropped
  assert.deepEqual(fake.calls[0].params[7], ['kei_1', 'kei_2']);
  assert.deepEqual(fake.calls[0].params[8], ['msedge', 'whatsapp']);
});

test('get() throws NotFoundError when the day has no digest', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [] }));
  pool.query = fake.pool.query;

  await assert.rejects(() => digests.get('gaia', '2026-11-01'), /kairos digest not found/);
});

test('find() returns null instead of throwing', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [] }));
  pool.query = fake.pool.query;

  assert.equal(await digests.find('gaia', '2026-11-01'), null);
});

test('list() clamps the limit and reads newest first', async () => {
  const fake = makeFakePool();
  fake.setImpl(async () => ({ rows: [row()] }));
  pool.query = fake.pool.query;

  const result = await digests.list('gaia', { limit: 500 });
  assert.equal(result.data.length, 1);
  assert.match(fake.calls[0].sql, /ORDER BY digest_date DESC/);
  assert.match(fake.calls[0].sql, new RegExp(`LIMIT ${digests.MAX_LIMIT}`));
});
