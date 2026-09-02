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
const REASONER_VERSION = 'reasoniq-v0.3';

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
  isValidEpistemicStatus,
  isValidVerdict,
  isValidHypothesisStatus,
  makeHypothesis,
};
