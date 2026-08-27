'use strict';

/**
 * Structured, server-side-only logging for ReasonIQ decisions. Same
 * discipline as intentLog.js: a dev/eval observability surface, never
 * returned to a client. Deliberately does not log hidden chain-of-thought
 * (§13) — only the structured result itself, which already carries
 * rationale in `reasoning`/`explanation` fields where relevant.
 */

const MAX_TEXT_CHARS = 300;

function truncate(text) {
  const str = String(text || '');
  return str.length > MAX_TEXT_CHARS ? `${str.slice(0, MAX_TEXT_CHARS)}…` : str;
}

/**
 * @param {{ result: object, input: string, contextId: string|undefined, correlationId: string }} entry
 * @param {(line: string) => void} [sink]
 */
function logReasoningResult(entry, sink = (line) => console.log(line)) {
  const meta = entry.result.meta || {};
  const record = {
    kind: 'reasoniq.result',
    timestamp: new Date().toISOString(),
    correlationId: entry.correlationId,
    contextId: entry.contextId || null,
    input: truncate(entry.input),
    reasoningDepth: entry.result.reasoningDepth,
    hypothesisCount: entry.result.hypotheses.length,
    contradictionCount: entry.result.contradictions.length,
    sufficientForConclusion: entry.result.sufficientForConclusion,
    // ReasonIQ 0.2 — additive evidence observability (brief §18): how much
    // evidence this turn reasoned over and from where. Counts/sources come
    // from the assembled INPUT; no user content is logged here.
    evidenceSufficient: entry.result.evidenceSufficient != null
      ? entry.result.evidenceSufficient
      : entry.result.sufficientForConclusion,
    evidenceCount: typeof meta.evidenceCount === 'number' ? meta.evidenceCount : null,
    evidenceSources: Array.isArray(meta.evidenceSources) ? meta.evidenceSources : [],
    informationGapCount: Array.isArray(entry.result.informationGaps) ? entry.result.informationGaps.length : 0,
    confidence: entry.result.confidence,
    fallbackReason: meta.fallbackReason || null,
    // Conversational opportunity — advisory only, additive
    conversationalOpportunity: entry.result.conversationalOpportunity
      ? {
          present: entry.result.conversationalOpportunity.present,
          strength: entry.result.conversationalOpportunity.strength,
          naturalResponse: entry.result.conversationalOpportunity.naturalResponse,
        }
      : null,
  };
  sink(JSON.stringify(record));
  return record;
}

module.exports = { logReasoningResult, truncate };
