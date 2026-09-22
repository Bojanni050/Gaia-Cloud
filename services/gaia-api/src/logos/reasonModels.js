'use strict';

/**
 * ReasonIQ v0.1 — shared vocabulary and lightweight model factories.
 *
 * This file defines the fixed vocabularies ReasonIQ's output is built
 * from (epistemic status, evidence verdicts, hypothesis status) and small
 * factory/validation helpers around them. It intentionally mirrors, but
 * does not import, `services/cognition/src/hypotheses.js`'s hypothesis
 * shape (`statement`, `confidence`, `status`, `verificationPlan`, evidence
 * linkage, and its `VALID_TRANSITIONS` state machine) — that service is a
 * separate deployable with its own database and this phase explicitly
 * does not call it (Hindsight/cognition integration is out of scope; see
 * reasonIQ.js's module comment). Keeping the field names identical is
 * deliberate: it's what lets a later phase hand a ReasonIQ hypothesis to
 * `services/cognition`'s `propose()` with no translation layer.
 *
 * architecture.md §6.2's line runs through this file: Logos (this module)
 * is allowed to *judge* that a hypothesis is confirmed or rejected —
 * that's a reasoning act. It is never allowed to *persist* that judgment
 * anywhere; nothing here writes to a database, calls Hindsight, or calls
 * `services/cognition`. A hypothesis's `status` below is Logos's own
 * epistemic conclusion for this turn, not a completed state transition.
 */

const SCHEMA_VERSION = 'reasoniq.v1';
// 0.2: evidence-aware reasoning — hypotheses/conclusions/contradictions now
// carry provenance links into the assembled evidence list (by stable
// evidence ID). Additive on v0.1's schema; nothing was removed.
// 0.3: hypothesis lifecycle support — the model may reference EXISTING
// hypotheses (existingId) and emit explicit per-evidence hypothesisUpdates;
// actual state transitions belong to reasoning/hypothesisManager.js, never
// to a raw model output.
// v1.0 (Cognitive Analysis Model): the background analysis now explicitly
// covers the completed conversation — observations (concrete derived
// information, never hypotheses), openQuestions (unresolved questions that
// are NEVER automatically asked of the user) and a reflection block
// (background self-assessment, observability-only). Additive again;
// nothing was removed.
// v1.1 (Cognitive Analysis Model, Part 4): relationships between existing
// knowledge (observation↔hypothesis, hypothesis↔pattern, pattern↔pattern,
// new-evidence↔existing-knowledge) become an explicit analysis product —
// they ride existing structures and persist as gaia:relationship world
// facts, never a separate store. The reflection block gains the remaining
// Part 4 axes: directionChange (where the conversation turned) and
// patternImpact (which patterns emerged/changed). Still additive; nothing
// was removed, and openQuestions keep their never-asked posture.
const REASONER_VERSION = 'reasoniq-v1.1';

/** FACT/INFERENCE/HYPOTHESIS/UNKNOWN — the epistemic distinctions ReasonIQ must never collapse (§11). */
const EPISTEMIC_STATUS = Object.freeze(['fact', 'inference', 'hypothesis', 'unknown']);

/** Stash's four-way evidence verdict, adopted as-is (design research, §10). */
const EVIDENCE_VERDICTS = Object.freeze(['supports', 'weakens', 'contradicts', 'irrelevant']);

/**
 * Kept identical to services/cognition/src/hypotheses.js's VALID_TRANSITIONS
 * — see this file's module comment for why it is duplicated rather than
 * imported. `status` here is a same-turn epistemic judgment, never a
 * persisted transition.
 */
const HYPOTHESIS_STATUSES = Object.freeze(['proposed', 'testing', 'confirmed', 'rejected']);

const REASONING_DEPTHS = Object.freeze(['shallow', 'deep']);

/** How much a contradiction matters — ReasonIQ reports it, Gaia weighs it. */
const CONTRADICTION_SIGNIFICANCE = Object.freeze(['low', 'medium', 'high']);

/**
 * v1.1 (Part 4 §Relationships): the kinds of existing knowledge a
 * relationship can connect. Observations and hypotheses arrive as input
 * context; patterns arrive as input context; evidence is the assembled
 * evidence list. No kind outside this set can ever be claimed as a
 * relationship endpoint.
 */
const RELATIONSHIP_NODE_KINDS = Object.freeze(['evidence', 'observation', 'hypothesis', 'pattern']);

/**
 * v1.1 (Part 4 §Relationships): what a relationship asserts about its two
 * endpoints. The four evidence verdicts (supports/weakens/contradicts/
 * irrelevant) cover evidence-driven pressure; relates_to covers
 * topic/theme kinship that carries no directional verdict — the same
 * vocabulary the hypothesisManager already applies to evidence updates.
 */
const RELATIONSHIP_TYPES = Object.freeze(['supports', 'weakens', 'contradicts', 'irrelevant', 'relates_to']);

function isValidEpistemicStatus(v) {
  return EPISTEMIC_STATUS.includes(v);
}
function isValidVerdict(v) {
  return EVIDENCE_VERDICTS.includes(v);
}
function isValidHypothesisStatus(v) {
  return HYPOTHESIS_STATUSES.includes(v);
}

/**
 * @typedef {Object} EvidenceItem
 * @property {string} content
 * @property {'fact'|'inference'|'hypothesis'|'unknown'} type
 * @property {'conversation'|'supplied'|'unknown'} origin - where this evidence item came from, distinct from IntentIQ's sourceOfTruth
 */

/**
 * @typedef {Object} EvidenceAssessment
 * @property {string} evidence - the evidence content being assessed
 * @property {'supports'|'weakens'|'contradicts'|'irrelevant'} verdict
 * @property {number} confidence - confidence in THIS VERDICT being correct (§10)
 * @property {string} reasoning - short rationale for the verdict, not a hidden chain-of-thought (§13)
 * @property {number} newConfidence - the hypothesis's confidence AFTER this evidence (§10) — distinct from `confidence` above
 */

/**
 * @typedef {Object} Hypothesis
 * @property {string} id - local, in-memory id only (crypto.randomUUID()) — never a persisted identifier
 * @property {string} statement
 * @property {number} confidence
 * @property {'proposed'|'testing'|'confirmed'|'rejected'} status - Logos's judgment for this turn, not a stored transition
 * @property {string|null} verificationPlan
 * @property {EvidenceAssessment[]} evidenceAssessments
 * @property {string[]} evidenceFor - ids of assembled evidence items that SUPPORT this hypothesis (0.2 provenance)
 * @property {string[]} evidenceAgainst - ids of assembled evidence items that WEAKEN/CONTRADICT it
 * @property {string|null} [existingId] - 0.3: when this turn recognized an EXISTING hypothesis (supplied via input.existingHypotheses), its stable id — validated against that input list, never invented
 */

/**
 * @typedef {Object} HypothesisUpdate
 * 0.3 (brief §6): one explicit, reasoning-backed evidence update for a
 * hypothesis. Applied only through reasoning/hypothesisManager.js — never
 * by the model itself, never by ReasonIQ writing anywhere.
 * @property {string} hypothesisId - which existing hypothesis this updates (validated against the supplied list)
 * @property {string|null} statement - the matched statement, for auditability when present
 * @property {string|null} evidenceId - the assembled evidence id driving it (provenance-filtered like every id)
 * @property {'supports'|'weakens'|'contradicts'|'irrelevant'} relation
 * @property {number} confidenceDelta - explicit, bounded delta — no arbitrary score changes
 * @property {string|null} rationale - why this update follows from the reasoning
 */

/**
 * @typedef {Object} Contradiction
 * @property {string} a - first side, as content text (v0.1 shape, kept)
 * @property {string} b - second side, as content text (v0.1 shape, kept)
 * @property {string} explanation
 * @property {string|null} evidenceA - id of the assembled evidence item on side A, when it has one (0.2)
 * @property {string|null} evidenceB - id of the assembled evidence item on side B, when it has one (0.2)
 * @property {string|null} description - what exactly conflicts (0.2)
 * @property {'low'|'medium'|'high'} significance - reported honestly; Gaia weighs it (0.2)
 */

/**
 * @typedef {Object} Observation
 * v1.0 (Cognitive Analysis Model §2): a CONCRETE piece of information
 * derived from the conversation or available context — e.g. "the user
 * explicitly decided X". Deliberately NOT a hypothesis: an observation
 * reports what was actually said/established, never an interpretation of
 * it, and it must never be treated as an interpreted fact beyond its
 * evidence. Durable observations persist to Hindsight (via the cognition
 * adapter, tag gaia:observation) — there is no separate observation store.
 * @property {string} statement
 * @property {Array<{id: string, source: string}>} evidence - provenance: which assembled evidence this observation stands on — only ids that were actually supplied
 * @property {string|null} relatedHypothesisId - 0.3-style relationship: the EXISTING hypothesis this observation is relevant to, when one does — validated against the supplied list, never invented. Relationships travel through existing structures (evidence links, hypothesisUpdates, pattern membership); there is no separate relationship store.
 */

/**
 * @typedef {Object} KnowledgeRelationship
 * v1.1 (Part 4 §Relationships): one explicit relationship between two nodes
 * of existing knowledge. Endpoints are VALIDATED against what was actually
 * supplied this turn (evidence ids, observation statements, existing
 * hypothesis ids, existing pattern ids) — an invented reference is dropped
 * at the endpoint, never passed upstream. ReasonIQ identifies the
 * relationship; it never acts on it (no lifecycle, no confidence change
 * here). Persistence rides existing structures: gaia:relationship world
 * facts via the cognition adapter — there is no relationship database.
 * @property {'evidence'|'observation'|'hypothesis'|'pattern'} fromKind
 * @property {string|null} fromId - evidence id / hypothesis id / pattern id when the endpoint has one; observations are content-addressed
 * @property {string} fromStatement - endpoint content, for auditability when ids are absent
 * @property {'evidence'|'observation'|'hypothesis'|'pattern'} toKind
 * @property {string|null} toId
 * @property {string} toStatement
 * @property {'supports'|'weakens'|'contradicts'|'irrelevant'|'relates_to'} type
 * @property {number} confidence - confidence in the relationship claim itself, never any endpoint's confidence
 * @property {string|null} rationale - why this relationship follows from the analysis
 */

/**
 * @typedef {Object} Reflection
 * v1.0 (Cognitive Analysis Model §7): background self-assessment of the
 * completed conversation. Internal cognitive material — observability
 * only, never persisted as a memory object, and it can never modify the
 * already-delivered response (ReasonIQ runs after the reply exists).
 * v1.1 (Part 4 §Reflection) adds two axes: directionChange (where the
 * conversation changed direction) and patternImpact (which patterns
 * emerged or changed). Both stay optional nullable strings — honest
 * absence over fabricated narration.
 * @property {boolean|null} goalAchieved - whether the conversation's apparent goal was achieved, when that is assessable
 * @property {string|null} learned - what this turn established/taught
 * @property {string|null} unresolved - what remained unresolved
 * @property {string|null} hypothesisImpact - whether existing hypotheses were strengthened/weakened, and what new hypotheses emerged
 * @property {string|null} directionChange - v1.1: where the conversation changed direction, when it did
 * @property {string|null} patternImpact - v1.1: which patterns emerged or changed, when any did
 */

/**
 * @typedef {Object} Conclusion
 * @property {string} statement
 * @property {'fact'|'inference'|'hypothesis'} basis
 * @property {number} confidence
 * @property {Array<{id: string, source: string}>} evidence - provenance: which assembled evidence this stands on (0.2) — only ids that were actually supplied
 */

/**
 * @typedef {Object} ReasoningResult
 * @property {'reasoniq.v1'} schemaVersion
 * @property {string} interpretation - what Logos understood the turn to mean
 * @property {'shallow'|'deep'} reasoningDepth
 * @property {EvidenceItem[]} evidence
 * @property {Hypothesis[]} hypotheses
 * @property {HypothesisUpdate[]} hypothesisUpdates - 0.3: explicit evidence updates for existing hypotheses (empty on shallow paths)
 * @property {Contradiction[]} contradictions
 * @property {string[]} uncertainties
 * @property {string[]} informationGaps
 * @property {Observation[]} observations - v1.0: concrete derived information (fact-shaped, never hypotheses)
 * @property {string[]} openQuestions - v1.0: unresolved questions — durable cognitive information where appropriate; ReasonIQ NEVER asks the user about them
 * @property {KnowledgeRelationship[]} relationships - v1.1: explicit relationships between existing knowledge — endpoint-validated, persisted via the cognition adapter as gaia:relationship world facts
 * @property {Reflection|null} reflection - v1.0: background self-assessment; observability-only, never persisted as memory
 * @property {Conclusion[]} conclusions
 * @property {boolean} sufficientForConclusion
 * @property {boolean} evidenceSufficient - named alias of sufficientForConclusion (0.2; brief §7's field name)
 * @property {number} confidence - overall confidence in interpretation + conclusions
 * @property {{ reasonerVersion: string, reasoningModelConfigured: boolean, fallbackReason: string|null, evidenceCount: number, evidenceSources: string[] }} meta
 */

function makeHypothesis({ statement, confidence = 0.5, status = 'proposed', verificationPlan = null, evidenceAssessments = [] }) {
  return {
    id: require('crypto').randomUUID(),
    statement,
    confidence,
    status: isValidHypothesisStatus(status) ? status : 'proposed',
    verificationPlan,
    evidenceAssessments,
  };
}

module.exports = {
  SCHEMA_VERSION,
  REASONER_VERSION,
  EPISTEMIC_STATUS,
  EVIDENCE_VERDICTS,
  HYPOTHESIS_STATUSES,
  REASONING_DEPTHS,
  CONTRADICTION_SIGNIFICANCE,
  RELATIONSHIP_NODE_KINDS,
  RELATIONSHIP_TYPES,
  isValidEpistemicStatus,
  isValidVerdict,
  isValidHypothesisStatus,
  makeHypothesis,
};
