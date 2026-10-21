'use strict';

/**
 * Observations — what the machine saw in one conversation, with the assembled
 * evidence it stood on. Raw material, not knowledge: no lifecycle, no status,
 * no mirror. A statement is formed from these (see the belief formation pass in
 * gaia-api); until then an observation is only a record of a moment.
 *
 * Two fields make aggregation possible at all:
 *   evidence_items[].sourceRef   the store-side identity of what was cited, so
 *                                "the same ground came back" is answerable;
 *   conversation_id              a second sighting only counts from ANOTHER
 *                                conversation — twice in one breath proves
 *                                nothing.
 */
const { pool } = require('./db/pool');
const { sanitizeEvidenceItems } = require('./evidenceItems');
const { ValidationError } = require('./errors');

const COLUMNS = `
  id, bank_id, statement, evidence_items, conversation_id,
  observed_at, consumed_by_id, consumed_at, created_at
`;

/**
 * @param {string} bankId
 * @param {{ statement?: string, evidenceItems?: Array<object>, conversationId?: string|null, observedAt?: string|null }} entry
 */
async function create(bankId, { statement, evidenceItems = [], conversationId = null, observedAt = null } = {}) {
  const text = typeof statement === 'string' ? statement.trim() : '';
  if (!text) throw new ValidationError('statement is required');
  const { rows } = await pool.query(
    `INSERT INTO observations (bank_id, statement, evidence_items, conversation_id, observed_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
     RETURNING ${COLUMNS}`,
    [
      bankId,
      text,
      JSON.stringify(sanitizeEvidenceItems(evidenceItems)),
      typeof conversationId === 'string' && conversationId.trim() ? conversationId.trim() : null,
      typeof observedAt === 'string' && observedAt.trim() ? observedAt.trim() : null,
    ],
  );
  return rows[0];
}

/**
 * The open observations for a bank, newest first — what the formation pass
 * reads. `consumed` shows the other side (what already fed a statement).
 */
async function list(bankId, { consumed = false, limit = 200 } = {}) {
  const bounded = Math.max(1, Math.min(1000, Number(limit) || 200));
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM observations
     WHERE bank_id = $1 AND ($2::boolean = (consumed_at IS NOT NULL))
     ORDER BY observed_at DESC
     LIMIT $3`,
    [bankId, Boolean(consumed), bounded],
  );
  return rows;
}

/**
 * Marks observations as fed into one statement. Idempotent: an already consumed
 * observation keeps the first statement it fed, so a retried pass can never
 * steal it away from a belief that already rests on it.
 * @returns {Promise<{ consumed: number }>}
 */
async function markConsumed(bankId, ids, hypothesisId) {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.trim());
  if (list.length === 0) return { consumed: 0 };
  const { rowCount } = await pool.query(
    `UPDATE observations
        SET consumed_by_id = COALESCE(consumed_by_id, $3),
            consumed_at = COALESCE(consumed_at, now())
      WHERE bank_id = $1 AND id = ANY($2::uuid[]) AND consumed_at IS NULL`,
    [bankId, list, hypothesisId],
  );
  return { consumed: rowCount };
}

module.exports = { create, list, markConsumed, COLUMNS };
