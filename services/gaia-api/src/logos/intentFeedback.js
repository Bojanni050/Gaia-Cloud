'use strict';

/**
 * IntentIQ 2.2/2.3 — the runtime feedback seam.
 *
 * When Gaia later learns that an earlier IntentDecision was wrong (most
 * often a user correction — "no, I meant advice, not an explanation"), this
 * is where that gets written down: a durable, structured, append-only
 * record, never a mutation of the original IntentDecision (which already
 * happened and cannot be un-decided) and never an update to some in-memory
 * classifier state.
 *
 * IntentIQ 2.3 makes the record rich enough to actually analyze offline:
 * alongside the flat compat fields it snapshots the calibration-relevant
 * parts of the original interpretation (confidenceLevel, ambiguous,
 * sourceOfTruth, speechAct) and carries a standardized `feedbackType`.
 * Full tier detail (heuristic vs semantic perspectives, matchedSignals,
 * referents) deliberately does NOT live here — that is already logged on
 * the same correlationId as an 'intentiq.decision' record via
 * logIntentDecision(); the offline analyzer joins the two kinds instead of
 * duplicating data.
 *
 * Explicitly NOT here:
 *   - online model training or threshold self-tuning — recordOutcome()
 *     only writes a record; nothing reads it back into a live decision.
 *   - a persistent per-user profile ("Bo usually wants advice") — that
 *     judgment belongs to Hindsight, not IntentIQ, which only ever
 *     interprets the current turn (see intentIQ.js's own module comment).
 *
 * This reuses decisionStore.js's existing JSONL persistence rather than
 * inventing a second storage mechanism — same day-file layout, same
 * never-throws append discipline, filterable by `kind`.
 */

const { createDecisionStore } = require('./decisionStore');

const FEEDBACK_SCHEMA_VERSION = 'intentiq.feedback.v1';

/** Standardized feedback vocabulary (IntentIQ 2.3 brief §2). */
const FEEDBACK_TYPES = Object.freeze([
  'user_correction',
  'system_override',
  'evaluation_expected_result',
  'test_failure',
]);

let defaultStore;
function defaultAppend(record) {
  if (!defaultStore) defaultStore = createDecisionStore();
  return defaultStore.append(record);
}

/**
 * The calibration-relevant slice of an IntentDecision, snapshotted at
 * feedback time. Deliberately bounded: no entities, no candidates list, no
 * conversational text — just enough for the analyzer's by-intent /
 * by-confidence-level / ambiguity breakdowns.
 */
function snapshotInterpretation(original) {
  return {
    intent: original.intent != null ? original.intent : null,
    status: original.status || null,
    confidence: typeof original.confidence === 'number' ? original.confidence : null,
    confidenceLevel: original.confidenceLevel || null,
    ambiguous: Boolean(original.ambiguous),
    sourceOfTruth: original.sourceOfTruth || null,
    speechAct: original.speechAct || null,
    needsSemanticCheck: Boolean(original.needsSemanticCheck),
  };
}

/**
 * @param {{
 *   originalInterpretation: object|null|undefined, the IntentDecision that was produced for the turn
 *   correctedIntent: string|null|undefined, the intent it should have been, if known
 *   feedbackType?: string, one of FEEDBACK_TYPES; falls back to (legacy) `source`, then 'unknown'
 *   source?: string, legacy field name for feedbackType — still accepted and mirrored back out
 *   semanticUsed?: boolean|null|undefined, whether the semantic tier ran for this turn, when the caller knows
 *   correlationId?: string, ties this feedback back to the original decision's log line
 *   contextId?: string,
 *   note?: string, free-text context a caller wants preserved for later analysis
 * }} feedback
 * @param {(record: object) => void} [sink] injectable for tests; defaults to decisionStore's durable append
 * @returns {object} the record that was (attempted to be) written
 */
function recordOutcome(feedback = {}, sink = defaultAppend) {
  const original = feedback.originalInterpretation || null;
  const rawType = feedback.feedbackType || feedback.source || 'unknown';
  const feedbackType = FEEDBACK_TYPES.includes(rawType) ? rawType : 'unknown';
  const record = {
    kind: 'intentiq.feedback',
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    correlationId: feedback.correlationId || null,
    contextId: feedback.contextId || null,
    originalIntent: original ? original.intent : null,
    originalStatus: original ? original.status : null,
    originalConfidence: original ? original.confidence : null,
    originalInterpretationStatus: original ? original.interpretationStatus || null : null,
    // IntentIQ 2.3 — structured snapshot of what was believed at the time.
    originalInterpretation: original ? snapshotInterpretation(original) : null,
    correctedIntent: feedback.correctedIntent || null,
    feedbackType,
    // Legacy mirror of feedbackType so pre-2.3 consumers keep working.
    source: feedbackType,
    semanticUsed: typeof feedback.semanticUsed === 'boolean' ? feedback.semanticUsed : null,
    note: typeof feedback.note === 'string' ? feedback.note : null,
  };
  sink(record);
  return record;
}

module.exports = { recordOutcome, FEEDBACK_SCHEMA_VERSION, FEEDBACK_TYPES };
