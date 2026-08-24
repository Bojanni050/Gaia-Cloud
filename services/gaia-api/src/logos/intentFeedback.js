'use strict';

/**
 * IntentIQ 2.2 — the runtime feedback seam.
 *
 * When Gaia later learns that an earlier IntentDecision was wrong (most
 * often a user correction — "no, I meant advice, not an explanation"), this
 * is where that gets written down: a durable, structured, append-only
 * record, never a mutation of the original IntentDecision (which already
 * happened and cannot be un-decided) and never an update to some in-memory
 * classifier state.
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

let defaultStore;
function defaultAppend(record) {
  if (!defaultStore) defaultStore = createDecisionStore();
  return defaultStore.append(record);
}

/**
 * @param {{
 *   originalInterpretation: object|null|undefined, the IntentDecision that was produced for the turn
 *   correctedIntent: string|null|undefined, the intent it should have been, if known
 *   source: string, e.g. 'user_correction'
 *   correlationId?: string, ties this feedback back to the original decision's log line
 *   contextId?: string,
 *   note?: string, free-text context a caller wants preserved for later analysis
 * }} feedback
 * @param {(record: object) => void} [sink] injectable for tests; defaults to decisionStore's durable append
 * @returns {object} the record that was (attempted to be) written
 */
function recordOutcome(feedback = {}, sink = defaultAppend) {
  const original = feedback.originalInterpretation || null;
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
    correctedIntent: feedback.correctedIntent || null,
    source: feedback.source || 'unknown',
    note: typeof feedback.note === 'string' ? feedback.note : null,
  };
  sink(record);
  return record;
}

module.exports = { recordOutcome, FEEDBACK_SCHEMA_VERSION };
