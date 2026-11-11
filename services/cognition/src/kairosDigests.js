/**
 * Kairos day-digest storage — one generated overview per bank per closed day.
 * A DERIVED narrative, like kairos_episodes, and therefore always the result
 * of an interpretation, never a raw record.
 *
 * Storage-only, like kairosEpisodes.js: filtering, prompt and the model call
 * live in services/gaia-api (src/kairos/digest.js). This module persists what
 * that writer produced and hands it back verbatim.
 *
 * `episode_ids` is the auditability seam: the overview can be walked back to
 * the episodes of that day, and each episode carries `sources` back to
 * Foundation.
 */
const { pool } = require('./db/pool');
const { NotFoundError, ValidationError } = require('./errors');

const COLUMNS = `
  id, bank_id, digest_date, timezone, title, summary, episode_count,
  episode_ids, apps, model, created_at, updated_at
`;

const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 4000;
const MAX_EPISODE_IDS = 500;
const MAX_APPS = 32;
const DEFAULT_LIMIT = 14;
const MAX_LIMIT = 90;
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * A digest date must be a real calendar date, not just nine digits and two
 * dashes: `2026-02-31` passing would make every later day comparison lie.
 * @param {unknown} date
 * @returns {string}
 */
function assertDate(date) {
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) {
    throw new ValidationError('digest_date must be YYYY-MM-DD');
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new ValidationError(`digest_date is not a real date: ${date}`);
  }
  return date;
}

/** Deterministic id, like the episode ids the worker owns. */
function digestIdFor(bankId, date) {
  return `kdi_${bankId}_${date}`;
}

function cleanStringList(values, max) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const clean = value.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Upsert one digest for a bank + day. Same day twice is a replacement, not a
 * second row: the unique key is (bank_id, digest_date).
 *
 * @param {string} bankId
 * @param {{ date: string, timezone?: string, title?: string, summary: string,
 *   episodeIds?: string[], apps?: string[], model?: string }} record
 */
async function upsert(bankId, {
  date, timezone = 'Europe/Amsterdam', title = '', summary, episodeIds = [], apps = [], model = '',
} = {}) {
  const digestDate = assertDate(date);
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new ValidationError('summary is required');
  }
  const cleanTitle = typeof title === 'string' ? title.trim().slice(0, MAX_TITLE_CHARS) : '';
  const ids = cleanStringList(episodeIds, MAX_EPISODE_IDS);
  const cleanApps = cleanStringList(apps, MAX_APPS);

  const { rows } = await pool.query(
    `INSERT INTO kairos_digests
       (id, bank_id, digest_date, timezone, title, summary, episode_count, episode_ids, apps, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (bank_id, digest_date) DO UPDATE SET
       timezone = EXCLUDED.timezone,
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       episode_count = EXCLUDED.episode_count,
       episode_ids = EXCLUDED.episode_ids,
       apps = EXCLUDED.apps,
       model = EXCLUDED.model,
       updated_at = now()
     RETURNING ${COLUMNS}`,
    [
      digestIdFor(bankId, digestDate),
      bankId,
      digestDate,
      String(timezone || 'Europe/Amsterdam'),
      cleanTitle,
      summary.trim().slice(0, MAX_SUMMARY_CHARS),
      ids.length,
      ids,
      cleanApps,
      typeof model === 'string' ? model.trim().slice(0, MAX_TITLE_CHARS) : '',
    ],
  );
  return rows[0];
}

/** Newest first — the Command Center reads the latest overview off the top. */
async function list(bankId, { limit } = {}) {
  const limitNum = clampLimit(limit);
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM kairos_digests
     WHERE bank_id = $1
     ORDER BY digest_date DESC
     LIMIT ${limitNum}`,
    [bankId],
  );
  return { data: rows };
}

async function get(bankId, date) {
  const digestDate = assertDate(date);
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM kairos_digests WHERE bank_id = $1 AND digest_date = $2`,
    [bankId, digestDate],
  );
  if (rows.length === 0) throw new NotFoundError(`kairos digest not found: ${digestDate}`);
  return rows[0];
}

/** Used by the writer before generating: null instead of a throw. */
async function find(bankId, date) {
  const digestDate = assertDate(date);
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM kairos_digests WHERE bank_id = $1 AND digest_date = $2`,
    [bankId, digestDate],
  );
  return rows.length === 0 ? null : rows[0];
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_TITLE_CHARS,
  digestIdFor,
  assertDate,
  upsert,
  list,
  get,
  find,
};
