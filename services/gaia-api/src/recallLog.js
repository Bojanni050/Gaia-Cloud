'use strict';

/**
 * Recall meetbasis — one cheap observability record per turn (kind
 * 'recall.measure'), so we can answer "how often does the pre-gate miss?"
 * from `GET /admin/api/logos/decisions` instead of guessing.
 *
 * Counts and gate booleans only — never user text, never memory text, same
 * posture as `reasoniq.gate` and `pattern.awareness`. Never allowed to
 * affect the turn.
 */

/**
 * @param {{
 *   traceId?: string|null,
 *   gated: boolean,
 *   hasHindsight: boolean,
 *   reflectionCount: number,
 *   mentalModelCount: number,
 *   patternCount: number,
 *   knowledgePageCount: number,
 *   queryLength: number,
 *   wantPatterns: boolean,
 * }} entry
 * @param {(line: string) => void} [sink] defaults to console.log
 */
function logRecallMeasure(entry, sink = (line) => console.log(line)) {
  const record = {
    kind: 'recall.measure',
    timestamp: new Date().toISOString(),
    traceId: entry.traceId || null,
    gated: Boolean(entry.gated),
    hasHindsight: Boolean(entry.hasHindsight),
    reflectionCount: Number.isFinite(entry.reflectionCount) ? entry.reflectionCount : 0,
    mentalModelCount: Number.isFinite(entry.mentalModelCount) ? entry.mentalModelCount : 0,
    patternCount: Number.isFinite(entry.patternCount) ? entry.patternCount : 0,
    knowledgePageCount: Number.isFinite(entry.knowledgePageCount) ? entry.knowledgePageCount : 0,
    queryLength: Number.isFinite(entry.queryLength) ? entry.queryLength : 0,
    wantPatterns: Boolean(entry.wantPatterns),
  };
  sink(JSON.stringify(record));
  return record;
}

module.exports = { logRecallMeasure };
