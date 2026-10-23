'use strict';

/**
 * Cognition Knowledge Adapter — routes Logos's non-hypothesis derived output
 * (Cognitive Analysis Model v1.0) through the right store, replacing the
 * retired hindsightCognitionAdapter's direct Hindsight writes:
 *
 *   observation   → Foundation's Ingestie Gateway (POST /api/ingest/*) — a
 *                   registered raw record, NEVER a Hindsight write.
 *   openQuestion  → Cognition record (kind open_question), mirrored to
 *                   Hindsight as gaia:open_question by cognitionSync. The
 *                   question carries the shape it is answered with
 *                   (question_shape/question_options), so the review card can
 *                   offer that control instead of always Ja/Nee.
 *   relationship  → Cognition record (kind relationship), mirrored as
 *                   gaia:relationship.
 *
 * Pure mapping. Open questions / relationships carry a `proposed` lifecycle
 * (Cognition owns it); observations have no lifecycle.
 */

const { normalizeOpenQuestion } = require('../logos/logosValidate');
const { indexEvidence, snapshotsFor } = require('./evidenceSnapshots');

function renderRelationship(relationship) {
  const from = `${relationship.fromKind}:${relationship.fromId != null ? relationship.fromId : relationship.fromStatement}`;
  const to = `${relationship.toKind}:${relationship.toId != null ? relationship.toId : relationship.toStatement}`;
  return `${from} ${relationship.type} ${to}`;
}

/**
 * A claim reduced to the thing that makes two wordings "the same sentence":
 * case, accents, punctuation and spacing. Deliberately not a paraphrase
 * detector — a fuzzy match here would silently drop a claim that is merely
 * similar, and the prompt (logosPrompt.js) is what asks for one claim per fact.
 */
function claimKey(statement) {
  return String(statement || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * One claim, one row, within one turn. Logos restates a claim several ways in
 * a single answer — written as-is, one moment looks like four, and the review
 * card shows the same sentence three times. Those rows can never corroborate
 * anyway: same conversation, so the formation pass would refuse them.
 *
 * @param {Array<{statement?: string}>} observations
 */
function dedupeObservations(observations) {
  const seen = new Set();
  const kept = [];
  for (const observation of Array.isArray(observations) ? observations : []) {
    const key = claimKey(observation && observation.statement);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(observation);
  }
  return kept;
}

function createCognitionKnowledgeAdapter({ cognition, sync, foundation } = {}) {
  if (!cognition) throw new Error('cognitionKnowledgeAdapter requires a cognition client');

  async function proposeKind(kind, statement, extra = {}) {
    const record = await cognition.proposeHypothesis({
      statement,
      kind,
      confidence: extra.confidence,
      method: extra.method || 'derived',
      sources: extra.sources || [],
      question_shape: extra.questionShape,
      question_options: extra.questionOptions,
    });
    if (sync && record) {
      try { await sync.syncHypothesis(record); } catch (_) { /* mirroring never breaks the turn */ }
    }
    return record;
  }

  /**
   * A concrete derived observation → Foundation's observation stream, and a
   * second, evidence-linked copy into Cognition as the working set a formation
   * pass can aggregate.
   *
   * The two are not the same record twice: Foundation keeps the raw moment
   * (unlinked, `gaia-observation`), while Cognition keeps it with the assembled
   * evidence it stood on. Only the linked form can answer "is this the same
   * ground as last week?", because only it carries sourceRef and the moment.
   *
   * @param {object} observation `{ statement, evidence: [{ id, source }] }`
   * @param {{ evidence?: Array<object>, conversationId?: string, observedAt?: string }} [turn]
   */
  async function retainObservation(observation, { evidence, conversationId, observedAt } = {}) {
    const statement = String((observation && observation.statement) || '').trim();
    if (!statement) throw new Error('observation statement is required');
    if (foundation && typeof foundation.submitObservation === 'function') {
      await foundation.submitObservation({
        content: statement,
        source: 'gaia-observation',
        tags: ['gaia-observation'],
      });
    }
    // Provenance: only the ids the model actually named, resolved against the
    // evidence the turn really offered — an invented id has nothing to resolve.
    const cited = (Array.isArray(observation && observation.evidence) ? observation.evidence : [])
      .map((item) => (item && item.id != null ? String(item.id) : null))
      .filter(Boolean);
    const index = indexEvidence(evidence, observedAt);
    const snapshots = snapshotsFor(index, cited);
    try {
      await cognition.createObservation({
        statement,
        ...(snapshots.length > 0 ? { evidence_items: snapshots } : {}),
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(observedAt ? { observed_at: observedAt } : {}),
      });
    } catch (err) {
      // The raw record is already safe with Foundation; the linked working set
      // is best-effort, like every other write in this phase.
      console.warn(`[gaia:observations] linked copy failed (non-fatal): ${err && err.message}`);
    }
    return { submitted: Boolean(foundation), linked: snapshots.length };
  }

  /**
   * An open question, with the shape the person answers it with. Accepts the
   * validated { question, shape, options } as well as the v1.0 bare string, and
   * falls back to reading the shape off the text when a caller passes a string
   * directly. An unreadable question is refused here too — the same guard as the
   * validator's, so no route to the card can bypass it.
   */
  async function retainOpenQuestion(question) {
    const normalized = normalizeOpenQuestion(question);
    if (!normalized) throw new Error('open question is required');
    return proposeKind('open_question', normalized.question, {
      questionShape: normalized.shape,
      questionOptions: normalized.options,
    });
  }

  async function retainRelationship(relationship) {
    if (!relationship || typeof relationship !== 'object') throw new Error('relationship is required');
    if (!relationship.fromKind || !relationship.toKind || !relationship.type) {
      throw new Error('relationship endpoints and type are required');
    }
    return proposeKind('relationship', renderRelationship(relationship), {
      confidence: typeof relationship.confidence === 'number' ? relationship.confidence : undefined,
    });
  }

  return { retainObservation, retainOpenQuestion, retainRelationship };
}

module.exports = { createCognitionKnowledgeAdapter, renderRelationship, dedupeObservations, claimKey };
