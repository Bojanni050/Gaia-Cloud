/**
 * Derived-statement lifecycle — Cognition's storage-only record of what Logos
 * derived: hypotheses, candidate mental models and candidate relationships
 * (the `kind` discriminator). The state machine concept is adapted from
 * Stash's internal/brain package, reimplemented against our own schema.
 *
 * V3 lifecycle:
 *   proposed ──▶ testing ──▶ corroborated (machine, C >= 0.80) ──▶ confirmed (HUMAN ONLY)
 *       │           │                    │
 *       └───────────┴────────────────────┴──▶ rejected  ({ verwerp_bron: 'mens' | 'consolidatie' })
 *
 * Cognition only persists. It never forms, judges, tests, confirms, rejects or
 * refines on its own initiative — every judgment is Logos's, and only a human
 * reaches `confirmed` (Absolute Override). It does NOT write to Hindsight:
 * Logos's sync job mirrors Cognition into the derived knowledge store.
 */
const { pool } = require('./db/pool');
const { NotFoundError, InvalidTransitionError, ValidationError } = require('./errors');

const KINDS = ['hypothesis', 'mental_model', 'relationship'];
const VERWERP_BRONNEN = ['mens', 'consolidatie'];

const VALID_TRANSITIONS = {
  proposed: ['testing', 'rejected'],
  testing: ['corroborated', 'confirmed', 'rejected', 'proposed'],
  corroborated: ['confirmed', 'rejected', 'testing'],
  confirmed: [],
  rejected: [],
};

function assertTransition(from, to) {
  if (!(VALID_TRANSITIONS[from] || []).includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

function assertKind(kind) {
  if (kind !== undefined && kind !== null && !KINDS.includes(kind)) {
    throw new ValidationError(`unknown kind: ${kind}`);
  }
}

function assertVerwerpBron(bron) {
  if (bron !== undefined && bron !== null && !VERWERP_BRONNEN.includes(bron)) {
    throw new ValidationError(`unknown verwerp_bron: ${bron}`);
  }
}

const COLUMNS = `
  id, bank_id, kind, statement, confidence, status, verification_plan,
  evidence_memory_ids, sources, supersedes_id, superseded_by_id,
  confirmed_document_id, rejection_reason, verwerp_bron,
  tested_at, confirmed_at, rejected_at, created_at, updated_at
`;

async function propose(bankId, {
  statement, confidence = 0.5, verificationPlan = '', evidenceMemoryIds = [],
  sources = [], kind = 'hypothesis', supersedesId = null,
} = {}) {
  if (!statement) throw new ValidationError('statement is required');
  assertKind(kind);
  const { rows } = await pool.query(
    `INSERT INTO hypotheses
       (bank_id, statement, confidence, verification_plan, evidence_memory_ids, sources, kind, supersedes_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [bankId, statement, confidence, verificationPlan, evidenceMemoryIds, sources, kind, supersedesId],
  );
  return rows[0];
}

async function list(bankId, { status, kind } = {}) {
  const clauses = ['bank_id = $1', 'deleted_at IS NULL'];
  const params = [bankId];
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  if (kind) {
    params.push(kind);
    clauses.push(`kind = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM hypotheses
     WHERE ${clauses.join(' AND ')}
     ORDER BY updated_at DESC`,
    params,
  );
  return rows;
}

async function get(bankId, id) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM hypotheses WHERE bank_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [bankId, id],
  );
  if (rows.length === 0) throw new NotFoundError(`hypothesis not found: ${id}`);
  return rows[0];
}

/** Update statement/confidence/verification_plan/sources. From `testing` or `corroborated`, this is a refine and resets status to `proposed` (mirrors Stash's RefineHypothesis). */
async function update(bankId, id, { statement, confidence, verificationPlan, evidenceMemoryIds, sources } = {}) {
  const current = await get(bankId, id);
  if (current.status === 'confirmed' || current.status === 'rejected') {
    throw new InvalidTransitionError(current.status, 'edited');
  }

  const refines = current.status === 'testing' || current.status === 'corroborated';
  const nextStatus = refines ? 'proposed' : current.status;
  const { rows } = await pool.query(
    `UPDATE hypotheses SET
       statement = COALESCE($3, statement),
       confidence = COALESCE($4, confidence),
       verification_plan = COALESCE($5, verification_plan),
       evidence_memory_ids = COALESCE($6, evidence_memory_ids),
       sources = COALESCE($7, sources),
       status = $8,
       tested_at = CASE WHEN $8 = 'proposed' THEN NULL ELSE tested_at END,
       updated_at = now()
     WHERE bank_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [bankId, id, statement ?? null, confidence ?? null, verificationPlan ?? null, evidenceMemoryIds ?? null, sources ?? null, nextStatus],
  );
  return rows[0];
}

async function markTesting(bankId, id) {
  const current = await get(bankId, id);
  assertTransition(current.status, 'testing');
  const { rows } = await pool.query(
    `UPDATE hypotheses SET status = 'testing', tested_at = COALESCE(tested_at, now()), updated_at = now()
     WHERE bank_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [bankId, id],
  );
  return rows[0];
}

/** Soft-promotion: a high-confidence micro-hypothesis (C >= 0.80) reaches `corroborated`. Machine-driven; never `confirmed`. */
async function markCorroborated(bankId, id) {
  const current = await get(bankId, id);
  assertTransition(current.status, 'corroborated');
  const { rows } = await pool.query(
    `UPDATE hypotheses SET status = 'corroborated', tested_at = COALESCE(tested_at, now()), updated_at = now()
     WHERE bank_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [bankId, id],
  );
  return rows[0];
}

/**
 * Human Absolute Override: only this path reaches `confirmed`. The statement
 * is not written to Hindsight here — Logos's sync job mirrors it.
 */
async function confirm(bankId, id) {
  const current = await get(bankId, id);
  assertTransition(current.status, 'confirmed');
  const { rows } = await pool.query(
    `UPDATE hypotheses SET status = 'confirmed', confirmed_at = now(), updated_at = now()
     WHERE bank_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [bankId, id],
  );
  return rows[0];
}

async function reject(bankId, id, reason, verwerpBron = 'mens') {
  assertVerwerpBron(verwerpBron);
  const current = await get(bankId, id);
  assertTransition(current.status, 'rejected');
  const { rows } = await pool.query(
    `UPDATE hypotheses SET status = 'rejected', rejected_at = now(), rejection_reason = $3,
       verwerp_bron = $4, updated_at = now()
     WHERE bank_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [bankId, id, reason || null, verwerpBron],
  );
  return rows[0];
}

/**
 * Consolidation: a newer confirmed statement supersedes an older one. This is
 * a system act (Logos's promotion/sync), so it is the ONE deliberate exception
 * to the transition table — it may move even a `confirmed` statement to
 * `rejected`, tagging verwerp_bron 'consolidatie' and pointing at the winner.
 * Idempotent: superseding an already-superseded record is a no-op.
 */
async function supersede(bankId, id, { supersededById, reason } = {}) {
  if (!supersededById) throw new ValidationError('superseded_by_id is required');
  const current = await get(bankId, id);
  if (current.status === 'rejected' && current.superseded_by_id) return current;
  const { rows } = await pool.query(
    `UPDATE hypotheses SET status = 'rejected', rejected_at = now(), rejection_reason = $3,
       verwerp_bron = 'consolidatie', superseded_by_id = $4, updated_at = now()
     WHERE bank_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [bankId, id, reason || null, supersededById],
  );
  return rows[0];
}

async function softDelete(bankId, id) {
  const { rowCount } = await pool.query(
    `UPDATE hypotheses SET deleted_at = now(), updated_at = now()
     WHERE bank_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [bankId, id],
  );
  if (rowCount === 0) throw new NotFoundError(`hypothesis not found: ${id}`);
}

module.exports = {
  propose, list, get, update, markTesting, markCorroborated, confirm, reject, supersede, softDelete,
  VALID_TRANSITIONS, KINDS,
};
