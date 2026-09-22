'use strict';

/**
 * Structured, server-side-only logging for ReasonIQ decisions. Same
 * discipline as intentLog.js: a dev/eval observability surface, never
 * returned to a client. Deliberately does not log hidden chain-of-thought
 * (§13) — only the structured result itself, which already carries
 * rationale in `reasoning`/`explanation` fields where relevant.
 */

const MAX_TEXT_CHARS = 300;

const MAX_ANALYSIS_ITEMS = 20;

/**
 * v1.0 analysis fields for the decision log: the FULL analysis products
 * (observations, open questions, reflection), so the admin decision log can
 * show what ReasonIQ actually derived — counts alone (the pre-v1.1 shape)
 * made the admin's ReasonIQ filter a dead end for anyone trying to read
 * the analysis. Bounded like every other field here: at most
 * MAX_ANALYSIS_ITEMS entries, each statement truncated to
 * MAX_TEXT_CHARS, never chain-of-thought (§13) — only the structured
 * result itself.
 */
function analysisFields(result) {
  const observations = (Array.isArray(result.observations) ? result.observations : [])
    .filter((o) => o && o.statement)
    .slice(0, MAX_ANALYSIS_ITEMS)
    .map((o) => truncate(o.statement));
  const openQuestions = (Array.isArray(result.openQuestions) ? result.openQuestions : [])
    .filter((q) => typeof q === 'string' && q)
    .slice(0, MAX_ANALYSIS_ITEMS)
    .map((q) => truncate(q));
  const reflection = result.reflection && typeof result.reflection === 'object'
    ? {
        goalAchieved: typeof result.reflection.goalAchieved === 'boolean' ? result.reflection.goalAchieved : null,
        learned: result.reflection.learned ? truncate(result.reflection.learned) : null,
        unresolved: result.reflection.unresolved ? truncate(result.reflection.unresolved) : null,
        hypothesisImpact: result.reflection.hypothesisImpact ? truncate(result.reflection.hypothesisImpact) : null,
      }
    : null;
  return { observations, openQuestions, reflection };
}

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
    hypothesisUpdateCount: Array.isArray(entry.result.hypothesisUpdates) ? entry.result.hypothesisUpdates.length : 0,
    sufficientForConclusion: entry.result.sufficientForConclusion,
    // Cognitive Analysis Model v1.0 — additive background-cognition
    // observability: what the analysis derived, and its self-assessment.
    // Counts only, never content — same posture as the fields above.
    observationCount: Array.isArray(entry.result.observations) ? entry.result.observations.length : 0,
    openQuestionCount: Array.isArray(entry.result.openQuestions) ? entry.result.openQuestions.length : 0,
    reflectionPresent: Boolean(entry.result.reflection),
    // v1.1: the analysis products themselves — counts stayed for the
    // summary line; content lets the admin decision log actually SHOW
    // what ReasonIQ concluded, instead of "3 observations" with no way to
    // read any of them.
    ...analysisFields(entry.result),
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
  };
  sink(JSON.stringify(record));
  return record;
}

/**
 * One cheap, local gate record per turn (kind 'reasoniq.gate') — written
 * BEFORE the depth decision is acted on, so every turn leaves a trace of
 * whether ReasonIQ engaged and why not. Without it, shallow turns (the
 * majority) are invisible in the decision log and "ReasonIQ never does
 * anything" is indistinguishable from "the gate is too strict". Never
 * includes user text — intent and counts only, same observability posture
 * as the result record.
 *
 * @param {{ depth: 'shallow'|'deep', reason: 'no_evidence'|'context_only_intent'|'ambiguous_intent'|'unknown_intent'|'deep', intent: string|null, evidenceCount: number, existingHypothesisCount: number, contextId: string|undefined, correlationId: string }} entry
 * @param {(line: string) => void} [sink]
 */
function logReasoningGate(entry, sink = (line) => console.log(line)) {
  const record = {
    kind: 'reasoniq.gate',
    timestamp: new Date().toISOString(),
    correlationId: entry.correlationId,
    contextId: entry.contextId || null,
    depth: entry.depth,
    reason: entry.reason,
    intent: entry.intent || null,
    evidenceCount: typeof entry.evidenceCount === 'number' ? entry.evidenceCount : 0,
    existingHypothesisCount: typeof entry.existingHypothesisCount === 'number' ? entry.existingHypothesisCount : 0,
  };
  sink(JSON.stringify(record));
  return record;
}

module.exports = { logReasoningResult, logReasoningGate, truncate };
