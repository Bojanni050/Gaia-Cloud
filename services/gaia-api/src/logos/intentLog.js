'use strict';

/**
 * Structured, server-side-only logging for IntentIQ decisions.
 *
 * Same discipline as server.js's request log and hermesClient's error
 * logs: this is a development/evaluation observability surface, never
 * something a client sees. Nothing here crosses the Gaia API's response
 * boundary — see turn.js, which never puts an IntentDecision in a client
 * response.
 *
 * Raw input text is truncated before logging (MAX_TEXT_CHARS) — enough to
 * debug a misclassification, not a verbatim conversation archive. This is
 * a deliberately modest privacy stance for a dev-log line, not a
 * replacement for a real logging/retention policy.
 */

const MAX_TEXT_CHARS = 300;

function truncate(text) {
  const str = String(text || '');
  return str.length > MAX_TEXT_CHARS ? `${str.slice(0, MAX_TEXT_CHARS)}…` : str;
}

/**
 * @param {{
 *   decision: import('./intentIQ').IntentDecision,
 *   input: string,
 *   contextId: string|undefined,
 *   correlationId: string,
 *   classifierVersion: string,
 *   semanticCalled?: boolean,
 *   tiers?: { heuristic: object, semantic: object|null },
 *   timestamp?: string,
 * }} entry
 * @param {(line: string) => void} [sink] injectable for tests; defaults to console.log
 */
function logIntentDecision(entry, sink = (line) => console.log(line)) {
  const record = {
    kind: 'intentiq.decision',
    timestamp: entry.timestamp || new Date().toISOString(),
    correlationId: entry.correlationId,
    contextId: entry.contextId || null,
    classifierVersion: entry.classifierVersion,
    input: truncate(entry.input),
    intent: entry.decision.intent,
    status: entry.decision.status,
    confidence: entry.decision.confidence,
    candidates: entry.decision.candidates,
    sourceOfTruth: entry.decision.sourceOfTruth,
    entities: entry.decision.entities,
    needsClarification: entry.decision.needsClarification,
    // IntentIQ 2.0 additions — additive, backward compatible.
    ambiguous: Boolean(entry.decision.ambiguous),
    speechAct: entry.decision.speechAct || null,
    semanticCalled: Boolean(entry.semanticCalled),
    // IntentIQ 2.2 additions — calibration/observability, additive.
    confidenceLevel: entry.decision.confidenceLevel || null,
    interpretationStatus: entry.decision.interpretationStatus || null,
    needsSemanticCheck: Boolean(entry.decision.needsSemanticCheck),
    // IntentIQ 2.3 additions — analysis/observability, additive. `reason`
    // says which cascade branch produced the decision, `matchedSignals`
    // which named heuristics fired, and referents are truncated the same
    // way as `input` (they can quote conversational content) — all so the
    // offline feedback analyzer can do its job from durable records alone.
    reason: (entry.decision.meta && entry.decision.meta.reason) || null,
    matchedSignals: (entry.decision.meta && entry.decision.meta.matchedSignals) || null,
    referents: Array.isArray(entry.decision.referents)
      ? entry.decision.referents.map((r) => ({
        expression: truncate(r && r.expression),
        resolvedTo: r && r.resolvedTo != null ? truncate(r.resolvedTo) : null,
        confidence: typeof (r && r.confidence) === 'number' ? r.confidence : null,
      }))
      : null,
    // Both tiers' own perspective, for calibration analysis — debug-only,
    // never the raw conversational text a second time (see `input` above).
    tiers: entry.tiers || null,
  };
  sink(JSON.stringify(record));
  return record;
}

module.exports = { logIntentDecision, truncate, MAX_TEXT_CHARS };
