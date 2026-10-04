'use strict';

/**
 * Cognition Knowledge Adapter — routes Logos's non-hypothesis derived output
 * (Cognitive Analysis Model v1.0) through the right store, replacing the
 * retired hindsightCognitionAdapter's direct Hindsight writes:
 *
 *   observation   → Foundation's Ingestie Gateway (POST /api/ingest/*) — a
 *                   registered raw record, NEVER a Hindsight write.
 *   openQuestion  → Cognition record (kind open_question), mirrored to
 *                   Hindsight as gaia:open_question by cognitionSync.
 *   relationship  → Cognition record (kind relationship), mirrored as
 *                   gaia:relationship.
 *
 * Pure mapping. Open questions / relationships carry a `proposed` lifecycle
 * (Cognition owns it); observations have no lifecycle.
 */

function renderRelationship(relationship) {
  const from = `${relationship.fromKind}:${relationship.fromId != null ? relationship.fromId : relationship.fromStatement}`;
  const to = `${relationship.toKind}:${relationship.toId != null ? relationship.toId : relationship.toStatement}`;
  return `${from} ${relationship.type} ${to}`;
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
    });
    if (sync && record) {
      try { await sync.syncHypothesis(record); } catch (_) { /* mirroring never breaks the turn */ }
    }
    return record;
  }

  /** A concrete derived observation → Foundation's observation stream. */
  async function retainObservation(observation) {
    const statement = String((observation && observation.statement) || '').trim();
    if (!statement) throw new Error('observation statement is required');
    if (foundation && typeof foundation.submitObservation === 'function') {
      await foundation.submitObservation({
        content: statement,
        source: 'gaia-observation',
        tags: ['gaia-observation'],
      });
    }
    // Never a Hindsight write: an observation is a raw record in Foundation.
    return { submitted: Boolean(foundation) };
  }

  async function retainOpenQuestion(question) {
    const statement = String(question || '').trim();
    if (!statement) throw new Error('open question is required');
    return proposeKind('open_question', statement);
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

module.exports = { createCognitionKnowledgeAdapter, renderRelationship };
