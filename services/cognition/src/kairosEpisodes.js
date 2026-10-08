/**
 * Kairos episode storage — a DERIVED narrative synthesis over a span of raw
 * observations, always epistemic_status 'interpretation'. This module only
 * persists what the Kairos synthesizer (services/gaia-api) produced; the
 * clustering and the synthesis happen there. Mirrors the storage-only
 * posture of patterns.js / hypotheses.js: no reasoning lives here.
 *
 * `sources` points back to the raw records (['foundation:<uuid>']),
 * exactly like patterns.sources and hypotheses.sources.
 */
const { pool } = require('./db/pool');
const { NotFoundError, ValidationError } = require('./errors');

const COLUMNS = `
  id, bank_id, start_time, end_time, summary, primary_app, involved_apps,
  epistemic_status, sources, created_at, updated_at
`;

const EPISTEMIC_STATUS = 'interpretation';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Upsert one Kairos episode. The writer owns the id (deterministic from the
 * cluster's first/last observation), so re-processing the same cluster is an
 * idempotent update rather than a duplicate.
 */
async function create(bankId, {
  id, startTime, endTime, summary, primaryApp = '', involvedApps = [], sources = [],
}) {
  if (!id) throw new ValidationError('id is required');
  if (!startTime || !endTime) throw new ValidationError('start_time and end_time are required');
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new ValidationError('summary is required');
  }
  const { rows } = await pool.query(
    `INSERT INTO kairos_episodes
       (id, bank_id, start_time, end_time, summary, primary_app, involved_apps, epistemic_status, sources)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (bank_id, id) DO UPDATE SET
       start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time,
       summary = EXCLUDED.summary,
       primary_app = EXCLUDED.primary_app,
       involved_apps = EXCLUDED.involved_apps,
       sources = EXCLUDED.sources,
       updated_at = now()
     RETURNING ${COLUMNS}`,
    [id, bankId, startTime, endTime, summary.trim(), primaryApp, involvedApps, EPISTEMIC_STATUS, sources],
  );
  return rows[0];
}

/**
 * Paged listing, newest first. `since` filters on start_time >= since.
 * @returns {{ data: object[], pagination: { page, limit, total_records, has_more } }}
 */
async function list(bankId, { page = 1, limit = DEFAULT_LIMIT, since } = {}) {
  const pageNum = Math.max(1, Math.floor(Number(page) || 1));
  const limitNum = clampLimit(limit);
  const offset = (pageNum - 1) * limitNum;

  const where = ['bank_id = $1'];
  const values = [bankId];
  if (since) {
    values.push(since);
    where.push(`start_time >= $${values.length}`);
  }
  const whereSql = where.join(' AND ');

  const { rows: countRows } = await pool.query(
    `SELECT count(*)::int AS total FROM kairos_episodes WHERE ${whereSql}`,
    values,
  );
  const total = countRows[0].total;

  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM kairos_episodes
     WHERE ${whereSql}
     ORDER BY start_time DESC, created_at DESC
     LIMIT ${limitNum} OFFSET ${offset}`,
    values,
  );

  return {
    data: rows,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total_records: total,
      has_more: offset + rows.length < total,
    },
  };
}

async function get(bankId, id) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM kairos_episodes WHERE bank_id = $1 AND id = $2`,
    [bankId, id],
  );
  if (rows.length === 0) throw new NotFoundError(`kairos episode not found: ${id}`);
  return rows[0];
}

/**
 * Read the worker watermark for a bank. Missing row / never advanced -> null,
 * meaning "start from the beginning" (the caller decides what that means).
 */
async function getState(bankId) {
  const { rows } = await pool.query(
    'SELECT last_captured_at FROM kairos_state WHERE bank_id = $1',
    [bankId],
  );
  return rows.length === 0 ? null : rows[0].last_captured_at;
}

/** Advance the worker watermark. Monotonic: never moves backwards. */
async function setState(bankId, lastCapturedAt) {
  if (!lastCapturedAt) throw new ValidationError('last_captured_at is required');
  const { rows } = await pool.query(
    `INSERT INTO kairos_state (bank_id, last_captured_at, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (bank_id) DO UPDATE SET
       last_captured_at = GREATEST(kairos_state.last_captured_at, EXCLUDED.last_captured_at),
       updated_at = now()
     RETURNING bank_id, last_captured_at`,
    [bankId, lastCapturedAt],
  );
  return rows[0];
}

module.exports = {
  EPISTEMIC_STATUS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  create,
  list,
  get,
  getState,
  setState,
};
