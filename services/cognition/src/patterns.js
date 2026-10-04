/**
 * Pattern storage — content Logos has already synthesized from recurring
 * facts. This module just persists it; forming the abstraction is Logos's
 * job, not this service's (see README "Explicitly not in this pass").
 */
const { pool } = require('./db/pool');
const { NotFoundError, ValidationError } = require('./errors');

const PATTERN_STATUSES = ['candidate', 'supported', 'established'];

const COLUMNS = `
  id, bank_id, content, confidence, coherence_score,
  source_memory_ids, status, hypothesis_ids, sources, created_at, updated_at
`;

async function create(bankId, {
  content, confidence = 0.5, coherenceScore = 0, sourceMemoryIds = [],
  status = 'candidate', hypothesisIds = [], sources = [],
}) {
  if (!content) throw new ValidationError('content is required');
  if (!PATTERN_STATUSES.includes(status)) throw new ValidationError(`unknown pattern status: ${status}`);
  const { rows } = await pool.query(
    `INSERT INTO patterns (bank_id, content, confidence, coherence_score, source_memory_ids, status, hypothesis_ids, sources)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [bankId, content, confidence, coherenceScore, sourceMemoryIds, status, hypothesisIds, sources],
  );
  return rows[0];
}

async function list(bankId) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM patterns WHERE bank_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
    [bankId],
  );
  return rows;
}

async function get(bankId, id) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM patterns WHERE bank_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [bankId, id],
  );
  if (rows.length === 0) throw new NotFoundError(`pattern not found: ${id}`);
  return rows[0];
}

async function update(bankId, id, {
  content, confidence, coherenceScore, sourceMemoryIds, status, hypothesisIds, sources,
} = {}) {
  if (status !== undefined && status !== null && !PATTERN_STATUSES.includes(status)) {
    throw new ValidationError(`unknown pattern status: ${status}`);
  }
  await get(bankId, id);
  const { rows } = await pool.query(
    `UPDATE patterns SET
       content = COALESCE($3, content),
       confidence = COALESCE($4, confidence),
       coherence_score = COALESCE($5, coherence_score),
       source_memory_ids = COALESCE($6, source_memory_ids),
       sources = COALESCE($7, sources),
       status = COALESCE($8, status),
       hypothesis_ids = COALESCE($9, hypothesis_ids),
       updated_at = now()
     WHERE bank_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [bankId, id, content ?? null, confidence ?? null, coherenceScore ?? null, sourceMemoryIds ?? null, sources ?? null, status ?? null, hypothesisIds ?? null],
  );
  return rows[0];
}

async function softDelete(bankId, id) {
  const { rowCount } = await pool.query(
    `UPDATE patterns SET deleted_at = now(), updated_at = now()
     WHERE bank_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [bankId, id],
  );
  if (rowCount === 0) throw new NotFoundError(`pattern not found: ${id}`);
}

module.exports = { create, list, get, update, softDelete };
