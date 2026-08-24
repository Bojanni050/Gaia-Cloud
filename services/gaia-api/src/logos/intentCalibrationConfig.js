'use strict';

/**
 * IntentIQ 2.3 — the calibration configuration seam.
 *
 * A single, read-only place where the calibration-relevant thresholds that
 * govern IntentIQ's behavior are *documented and reported*, so the offline
 * evaluation runner (eval/evaluationRunner.js) can show exactly which
 * values produced a given report — "no magic numbers scattered across the
 * code" (IntentIQ 2.3 brief §15).
 *
 * Deliberately NOT here (yet): making intentIQ.js read its constants from
 * this module. 2.3's own rule is that every calibration change must be an
 * explicit, human-reviewed code change — so this file first becomes the
 * honest mirror of the values that are live in intentIQ.js. Rewiring the
 * classifier to consume these values (with identical defaults) is a later,
 * separate, reviewed step; until then the two must be kept in sync BY
 * HAND, and test/intentFeedbackAnalyzer.test.js asserts they still agree
 * with what intentIQ.js actually exports via __internals.
 *
 * Never mutated at runtime; nothing here tunes anything online.
 */

/** The live heuristic-tier constants (see intentIQ.js). */
const RUNTIME_CONSTANTS = Object.freeze({
  /** Top candidate must hold at least this share of total signal weight to resolve as accepted (AMBIGUITY_SHARE_THRESHOLD). */
  ambiguityShareThreshold: 0.6,
  /** ...or lead the runner-up by more than this many raw matches (AMBIGUITY_RAW_MARGIN). */
  ambiguityRawMargin: 1,
  /** Confidence is never reported at or above this — "she never pretends certainty" (MAX_CONFIDENCE). */
  maxConfidenceCap: 0.95,
  /** confidenceLevel 'high' starts here (CONFIDENCE_LEVEL_HIGH). */
  confidenceLevelHigh: 0.85,
  /** confidenceLevel 'medium' starts here; below it is 'low' (CONFIDENCE_LEVEL_MEDIUM). */
  confidenceLevelMedium: 0.6,
  /** An inherited (follow-up) intent needs at least this confidence to be accepted rather than ambiguous. */
  inheritedAcceptThreshold: 0.4,
  /**
   * The semantic tier's escalation rule — structural, not numeric: a real
   * model call happens when `status !== 'accepted' || needsSemanticCheck`
   * (interpret()'s cascade condition). There is deliberately no
   * "semanticCheckThreshold" number in the current runtime; if one is ever
   * introduced, it gets documented here.
   */
  semanticEscalationRule: "status !== 'accepted' || needsSemanticCheck",
});

/**
 * Calibration-report confidence bands (IntentIQ 2.3 brief §4). Edges are
 * [inclusiveMin, exclusiveMax); the last band catches everything below the
 * lowest edge. Used by intentFeedbackAnalyzer.calibration() — changing
 * these changes only how reports are bucketed, never runtime behavior.
 */
const CONFIDENCE_BANDS = Object.freeze([
  Object.freeze({ range: '0.90-1.00', min: 0.9, max: 1.0000000001 }),
  Object.freeze({ range: '0.70-0.89', min: 0.7, max: 0.9 }),
  Object.freeze({ range: '<0.70', min: -1, max: 0.7 }),
]);

/** A resolved referent below this confidence counts as "low-confidence reference" (brief §10). */
const LOW_REFERENT_CONFIDENCE = 0.5;

/**
 * The heuristic-confidence level under which a semantic call that merely
 * CONFIRMS the heuristic is still counted as having reduced uncertainty
 * rather than being redundant (brief §7: "een semantic call die hetzelfde
 * resultaat teruggeeft is niet per definitie nutteloos").
 */
const UNCERTAINTY_REDUCTION_THRESHOLD = 0.7;

function bandFor(confidence) {
  return CONFIDENCE_BANDS.find((b) => confidence >= b.min && confidence < b.max) || null;
}

module.exports = {
  RUNTIME_CONSTANTS,
  CONFIDENCE_BANDS,
  LOW_REFERENT_CONFIDENCE,
  UNCERTAINTY_REDUCTION_THRESHOLD,
  bandFor,
};
