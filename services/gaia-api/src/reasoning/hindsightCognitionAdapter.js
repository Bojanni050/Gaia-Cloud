'use strict';

/**
 * Hindsight Cognition Adapter — ReasonIQ Cognitive Analysis Model v1.0.
 *
 * Persistence for the cognitive results that are durable knowledge but not
 * hypotheses/patterns (those have their own managers and adapters):
 *
 *   observation  → retained world fact, tag gaia:observation,
 *                  context "gaia observation", gaia_observation_* metadata
 *   openQuestion → retained world fact, tag gaia:open-question,
 *                  context "gaia open question", gaia_open_question_* metadata
 *   relationship → retained world fact, tag gaia:relationship,
 *                  context "gaia relationship", gaia_relationship_* metadata
 *
 * Exactly the same principles as hindsightHypothesisAdapter.js: a thin
 * mapping layer onto Hindsight's existing REST primitives (retainSync +
 * document_id). There is deliberately NO second database, no recall logic
 * and no reasoning here — durable cognitive material becomes ordinary
 * world facts, so a FUTURE turn's normal context recall (memory.js) and
 * evidence assembly (evidenceAssembler.js) can find them with zero new
 * retrieval machinery. ReasonIQ identifies; Hindsight stores; Gaia decides.
 *
 * Boundary details:
 *   - An observation's relationship to an existing hypothesis rides as
 *     gaia_observation_related_hypothesis metadata — relationships travel
 *     through existing structures (evidence ids, hypothesisUpdates, pattern
 *     membership), never a separate relationship store.
 *   - Open questions are STORED ONLY. ReasonIQ never asks the user about
 *     them; whether one ever becomes conversationally relevant is Gaia's
 *     later decision.
 *   - The reflection block is deliberately NOT persisted — it is internal
 *     background self-assessment (observability only, see reasonLog.js).
 *   - A relationship (v1.1, Part 4) is stored as an ordinary world fact
 *     whose metadata carries both structured endpoints; a FUTURE turn's
 *     normal recall finds it like any other fact. There is NO relationship
 *     database and no graph store — Hindsight's world facts ARE the
 *     mechanism the Part 4 brief said to reuse.
 *   - Failures are the caller's to catch (best-effort persistence must
 *     never break the deferred phase); this module stays honest and throws.
 */

const OBSERVATION_TAG = 'gaia:observation';
const OBSERVATION_CONTEXT = 'gaia observation';
const OPEN_QUESTION_TAG = 'gaia:open-question';
const OPEN_QUESTION_CONTEXT = 'gaia open question';
const RELATIONSHIP_TAG = 'gaia:relationship';
const RELATIONSHIP_CONTEXT = 'gaia relationship';
const UPDATED_BY = 'gaia-reasoniq';

/**
 * @param {{ client: ReturnType<import('../hindsightClient').createHindsightClient> }} options
 */
function createHindsightCognitionAdapter(options = {}) {
  const client = options.client;
  if (!client) throw new Error('hindsightCognitionAdapter requires a hindsight client');

  /**
   * One concrete derived observation → one retained world fact. Append-only
   * by design: an observation reports what was established, it has no
   * lifecycle to version. The stable native fact ids come back so callers
   * can log what was stored.
   * @param {{ statement: string, evidence?: Array<{id: string, source: string|null}>, relatedHypothesisId?: string|null }} observation
   * @returns {Promise<{documentId: string, factId: string|null}>}
   */
  async function retainObservation(observation) {
    const statement = String(observation && observation.statement || '').trim();
    if (!statement) throw new Error('observation statement is required');
    const documentId = `gaia-obs-${require('crypto').randomUUID()}`;
    await client.retainSync({
      content: statement,
      context: OBSERVATION_CONTEXT,
      tags: [OBSERVATION_TAG],
      metadata: {
        gaia_observation_statement: statement,
        // string→string API: structured values ride as JSON.
        gaia_observation_evidence: JSON.stringify(
          Array.isArray(observation.evidence)
            ? observation.evidence.map((e) => (e && e.id != null ? String(e.id) : null)).filter(Boolean)
            : []
        ),
        gaia_observation_related_hypothesis: observation.relatedHypothesisId != null
          ? String(observation.relatedHypothesisId)
          : '',
        gaia_observation_updated_by: UPDATED_BY,
      },
      documentId,
    });
    const units = await client.listMemories({ documentId, type: 'world' });
    const factId = units[0] && units[0].id != null ? String(units[0].id) : null;
    return { documentId, factId };
  }

  /**
   * One unresolved question → one retained world fact. Stored for future
   * context only — nothing here ever surfaces a question to the user.
   * @param {string} question
   * @returns {Promise<{documentId: string, factId: string|null}>}
   */
  async function retainOpenQuestion(question) {
    const statement = String(question || '').trim();
    if (!statement) throw new Error('open question is required');
    const documentId = `gaia-oq-${require('crypto').randomUUID()}`;
    await client.retainSync({
      content: statement,
      context: OPEN_QUESTION_CONTEXT,
      tags: [OPEN_QUESTION_TAG],
      metadata: {
        gaia_open_question_statement: statement,
        gaia_open_question_updated_by: UPDATED_BY,
      },
      documentId,
    });
    const units = await client.listMemories({ documentId, type: 'world' });
    const factId = units[0] && units[0].id != null ? String(units[0].id) : null;
    return { documentId, factId };
  }

  /**
   * One knowledge relationship (v1.1, Part 4 §Relationships) → one retained
   * world fact. The statement is a human-readable rendering; the structured
   * endpoints/type/confidence ride as gaia_relationship_* metadata — the
   * same string→string API discipline as observations. Append-only:
   * identifying a relationship is not a lifecycle, there is nothing to
   * version. Endpoint validation happened upstream (reasonValidate.js);
   * this layer stays a pure mapping and never invents an endpoint.
   * @param {{ fromKind: string, fromId: string|null, fromStatement: string, toKind: string, toId: string|null, toStatement: string, type: string, confidence: number, rationale?: string|null }} relationship
   * @returns {Promise<{documentId: string, factId: string|null}>}
   */
  async function retainRelationship(relationship) {
    if (!relationship || typeof relationship !== 'object') throw new Error('relationship is required');
    if (!relationship.fromKind || !relationship.toKind || !relationship.type) {
      throw new Error('relationship endpoints and type are required');
    }
    const from = `${relationship.fromKind}:${relationship.fromId != null ? relationship.fromId : relationship.fromStatement}`;
    const to = `${relationship.toKind}:${relationship.toId != null ? relationship.toId : relationship.toStatement}`;
    const statement = `${from} ${relationship.type} ${to}`;
    const documentId = `gaia-rel-${require('crypto').randomUUID()}`;
    await client.retainSync({
      content: statement,
      context: RELATIONSHIP_CONTEXT,
      tags: [RELATIONSHIP_TAG],
      metadata: {
        gaia_relationship_from_kind: String(relationship.fromKind),
        gaia_relationship_from_id: relationship.fromId != null ? String(relationship.fromId) : '',
        gaia_relationship_from_statement: String(relationship.fromStatement || ''),
        gaia_relationship_to_kind: String(relationship.toKind),
        gaia_relationship_to_id: relationship.toId != null ? String(relationship.toId) : '',
        gaia_relationship_to_statement: String(relationship.toStatement || ''),
        gaia_relationship_type: String(relationship.type),
        gaia_relationship_confidence: String(
          typeof relationship.confidence === 'number' && Number.isFinite(relationship.confidence)
            ? relationship.confidence
            : ''
        ),
        gaia_relationship_rationale: String(relationship.rationale || ''),
        gaia_relationship_updated_by: UPDATED_BY,
      },
      documentId,
    });
    const units = await client.listMemories({ documentId, type: 'world' });
    const factId = units[0] && units[0].id != null ? String(units[0].id) : null;
    return { documentId, factId };
  }
  return {
    retainObservation,
    retainOpenQuestion,
    retainRelationship,
    OBSERVATION_TAG,
    OPEN_QUESTION_TAG,
    RELATIONSHIP_TAG,
  };
}

module.exports = {
  createHindsightCognitionAdapter,
  OBSERVATION_TAG,
  OBSERVATION_CONTEXT,
  OPEN_QUESTION_TAG,
  OPEN_QUESTION_CONTEXT,
  RELATIONSHIP_TAG,
  RELATIONSHIP_CONTEXT,
};
