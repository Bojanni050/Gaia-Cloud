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
  };
  sink(JSON.stringify(record));
  return record;
}

module.exports = { logIntentDecision, truncate, MAX_TEXT_CHARS };
