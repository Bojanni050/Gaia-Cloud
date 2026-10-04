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
 *                                                 │
 *                                   reopen (HUMAN only, reason) ──▶ testing
 *
 * `rejected` is terminal in VALID_TRANSITIONS: every automatic verb refuses it.
 * reopen() is the single human-initiated exception (like supersede()).
 *
 * Cognition only persists. It never forms, judges, tests, confirms, rejects or
 * refines on its own initiative — every judgment is Logos's, and only a human
 * reaches `confirmed` (Absolute Override). It does NOT write to Hindsight:
 * Logos's sync job mirrors Cognition into the derived knowledge store.
 */
const { pool } = require('./db/pool');
const { NotFoundError, InvalidTransitionError, ValidationError } = require('./errors');

const KINDS = ['hypothesis', 'mental_model', 'relationship', 'open_question'];
const VERWERP_BRONNEN = ['mens', 'consolidatie'];
const PERSISTENCES = ['ephemeral', 'durable'];
const METHODS = ['asserted', 'derived', 'tested'];
// V3 epistemic entrenchment. `macro` is the safe default enforced by the
// column default: an unclassified statement is one a human must look at.
const SCOPES = ['micro', 'macro'];

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

function assertPersistence(p) {
  if (p !== undefined && p !== null && !PERSISTENCES.includes(p)) {
    throw new ValidationError(`unknown persistence: ${p}`);
  }
}

function assertMethod(m) {
  if (m !== undefined && m !== null && !METHODS.includes(m)) {
    throw new ValidationError(`unknown method: ${m}`);
  }
}

function assertScope(s) {
  if (s !== undefined && s !== null && !SCOPES.includes(s)) {
    throw new ValidationError(`unknown scope: ${s}`);
  }
}

const COLUMNS = `
  id, bank_id, kind, statement, confidence, status, verification_plan,
  evidence_memory_ids, evidence_for, evidence_against, persistence, method,
  sources, supersedes_id, superseded_by_id,
  counter_hypothesis, scope,
  confirmed_document_id, rejection_reason, verwerp_bron,
  tested_at, confirmed_at, rejected_at, created_at, updated_at
`;

async function propose(bankId, {
  statement, confidence = 0.5, verificationPlan = '', evidenceMemoryIds = [],
  evidenceFor = [], evidenceAgainst = [], persistence = 'ephemeral', method = 'asserted',
  sources = [], kind = 'hypothesis', supersedesId = null,
  counterHypothesis = null, scope = undefined,
} = {}) {
  if (!statement) throw new ValidationError('statement is required');
  assertKind(kind);
  assertPersistence(persistence);
  assertMethod(method);
  assertScope(scope);
  const { rows } = await pool.query(
    `INSERT INTO hypotheses
       (bank_id, statement, confidence, verification_plan, evidence_memory_ids,
        evidence_for, evidence_against, persistence, method, sources, kind, supersedes_id,
        counter_hypothesis, scope)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, 'macro'))
     RETURNING ${COLUMNS}`,
    [bankId, statement, confidence, verificationPlan, evidenceMemoryIds,
      evidenceFor, evidenceAgainst, persistence, method, sources, kind, supersedesId,
      (typeof counterHypothesis === 'string' && counterHypothesis.trim()) ? counterHypothesis.trim() : null,
      scope ?? null],
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

/** Update statement/confidence/verification_plan/sources/evidence/persistence/method. From `testing` or `corroborated`, this is a refine and resets status to `proposed` (mirrors Stash's RefineHypothesis). */
async function update(bankId, id, {
  statement, confidence, verificationPlan, evidenceMemoryIds,
  evidenceFor, evidenceAgainst, persistence, method, sources,
  counterHypothesis, scope,
} = {}) {
  assertPersistence(persistence);
  assertMethod(method);
  assertScope(scope);
  const current = await get(bankId, id);
  if (current.status === 'confirmed' || current.status === 'rejected') {
    throw new InvalidTransitionError(current.status, 'edited');
  }

  const refines = (current.status === 'testing' || current.status === 'corroborated')
    && statement !== undefined && statement !== null && String(statement) !== current.statement;
  const nextStatus = refines ? 'proposed' : current.status;
  const { rows } = await pool.query(
    `UPDATE hypotheses SET
       statement = COALESCE($3, statement),
       confidence = COALESCE($4, confidence),
       verification_plan = COALESCE($5, verification_plan),
       evidence_memory_ids = COALESCE($6, evidence_memory_ids),
       sources = COALESCE($7, sources),
       evidence_for = COALESCE($9, evidence_for),
       evidence_against = COALESCE($10, evidence_against),
       persistence = COALESCE($11, persistence),
       method = COALESCE($12, method),
       counter_hypothesis = COALESCE($13, counter_hypothesis),
       scope = COALESCE($14, scope),
       status = $8,
       tested_at = CASE WHEN $8 = 'proposed' THEN NULL ELSE tested_at END,
       updated_at = now()
     WHERE bank_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [bankId, id, statement ?? null, confidence ?? null, verificationPlan ?? null, evidenceMemoryIds ?? null, sources ?? null, nextStatus,
      evidenceFor ?? null, evidenceAgainst ?? null, persistence ?? null, method ?? null,
      (typeof counterHypothesis === 'string' && counterHypothesis.trim()) ? counterHypothesis.trim() : null,
      scope ?? null],
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
async function confirm(bankId, id, { statement } = {}) {
  const current = await get(bankId, id);
  assertTransition(current.status, 'confirmed');
  // V3: the anti-lexicographic counter-hypothesis must exist before a human
  // can settle the statement. Absence is honest and blocks the override —
  // it is never satisfied by inventing an opposition here.
  if (!(typeof current.counter_hypothesis === 'string' && current.counter_hypothesis.trim())) {
    throw new ValidationError('a counter-hypothesis is required before confirmation');
  }
  // `statement` is the human's own nuanced re-wording ("Nuanceren"): it is
  // written together with the confirmation as one audited act, bypassing the
  // testing→proposed refine reset that a plain PATCH would trigger.
  const nuanced = (typeof statement === 'string' && statement.trim()) ? statement.trim() : null;
  const { rows } = await pool.query(
    `UPDATE hypotheses SET status = 'confirmed', confirmed_at = now(), updated_at = now(),
       statement = COALESCE($3, statement)
     WHERE bank_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [bankId, id, nuanced],
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
 * Human reopen — the ONLY way out of the rejected quarantine. `rejected` is
 * terminal in VALID_TRANSITIONS, so every automatic verb (test, corroborate,
 * confirm, evidence, update) refuses it; this function is the one deliberate,
 * human-initiated exception (same posture as supersede() below). A reason is
 * required: the person is lifting their own earlier rejection, and the "why"
 * must be recorded.
 */
async function reopen(bankId, id, { reason } = {}) {
  if (!reason || !String(reason).trim()) {
    throw new ValidationError('a reason is required to reopen a rejected hypothesis');
  }
  const current = await get(bankId, id);
  if (current.status !== 'rejected') {
    throw new InvalidTransitionError(current.status, 'reopened');
  }
  const { rows } = await pool.query(
    `UPDATE hypotheses SET status = 'testing', rejection_reason = NULL,
       verwerp_bron = NULL, updated_at = now()
     WHERE bank_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [bankId, id],
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

const RELATIONS = ['supports', 'weakens', 'contradicts', 'irrelevant'];

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // soul.md: never claim certainty — capped at 0.95, 4-decimal rounding.
  return Math.round(Math.min(0.95, Math.max(0, n)) * 10000) / 10000;
}

/**
 * Applies one evidence verdict to a derived statement — the lifecycle owner's
 * own transition rule. Logos supplies the verdict and delta; Cognition stores
 * the evidence and books the consequence:
 *   supports     → evidence_for,     confidence + delta,  proposed → testing
 *   weakens      → evidence_against, confidence − |delta|, proposed → testing
 *   contradicts  → evidence_against, confidence − |delta|, confirmed/proposed → testing
 *   irrelevant   → recorded as a no-op (updated_at only)
 * Only a human reaches `confirmed` (Absolute Override); this never confirms.
 */
async function applyEvidence(bankId, id, { relation, evidenceId, confidenceDelta, rationale } = {}) {
  if (!RELATIONS.includes(relation)) throw new ValidationError(`unknown relation: ${relation}`);
  const current = await get(bankId, id);
  if (current.status === 'rejected') {
    throw new InvalidTransitionError('rejected', 'evidence');
  }

  const evidenceFor = [...(current.evidence_for || [])];
  const evidenceAgainst = [...(current.evidence_against || [])];
  let confidence = clampConfidence(current.confidence);
  let status = current.status;
  let testedAt = current.tested_at;

  const add = (list, value) => { if (value && !list.includes(value)) list.push(value); };
  if (relation === 'supports') {
    add(evidenceFor, evidenceId);
    confidence = clampConfidence(confidence + (Number(confidenceDelta) || 0));
    if (status === 'proposed') status = 'testing';
  } else if (relation === 'weakens') {
    add(evidenceAgainst, evidenceId);
    confidence = clampConfidence(confidence - Math.abs(Number(confidenceDelta) || 0));
    if (status === 'proposed') status = 'testing';
  } else if (relation === 'contradicts') {
    add(evidenceAgainst, evidenceId);
    confidence = clampConfidence(confidence - Math.abs(Number(confidenceDelta) || 0.15));
    if (status === 'confirmed' || status === 'proposed') status = 'testing';
  }

  if (status === 'testing' && !testedAt) testedAt = new Date().toISOString();

  const { rows } = await pool.query(
    `UPDATE hypotheses SET
       evidence_for = $3,
       evidence_against = $4,
       confidence = $5,
       status = $6,
       tested_at = $7,
       updated_at = now()
     WHERE bank_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [bankId, id, evidenceFor, evidenceAgainst, confidence, status, testedAt],
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
  propose, list, get, update, markTesting, markCorroborated, confirm, reject, reopen, supersede, applyEvidence, softDelete,
  VALID_TRANSITIONS, KINDS, RELATIONS, SCOPES,
};
