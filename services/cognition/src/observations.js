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
  observed_at, consumed_by_id, consumed_at, created_at, recall_ground
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
 * Merges recall-derived ground into an observation: the Hindsight memory-unit
 * ids a recall of the observation's statement returned. Idempotent (a unit id
 * already present is not added again) and additive (existing ground is kept),
 * so a retried pass after a partial failure converges instead of duplicating.
 * An empty list is a no-op — NULL ("never recalled") is not overwritten with
 * an empty answer, because the two mean different things.
 * @returns {Promise<{ merged: number }>} the size of the ground after the merge
 */
async function mergeRecallGround(bankId, id, groundIds) {
  const list = (Array.isArray(groundIds) ? groundIds : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
  if (list.length === 0) return { merged: 0 };
  const { rows } = await pool.query(
    `UPDATE observations
        SET recall_ground = (
          SELECT COALESCE(
            (SELECT array_agg(DISTINCT unit_id)
               FROM unnest(COALESCE(recall_ground, '{}'::text[]) || $3::text[]) AS unit_id),
            '{}'::text[]
          )
        )
      WHERE bank_id = $1 AND id = $2::uuid
      RETURNING recall_ground`,
    [bankId, id, list],
  );
  const after = Array.isArray(rows[0] && rows[0].recall_ground) ? rows[0].recall_ground : [];
  return { merged: after.length };
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

module.exports = { create, list, markConsumed, mergeRecallGround, COLUMNS };
