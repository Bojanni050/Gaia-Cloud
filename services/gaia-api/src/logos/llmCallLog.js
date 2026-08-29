'use strict';

/**
 * Structured, server-side-only logging for every actual LLM HTTP call Gaia
 * makes — IntentIQ's semantic classifier, ReasonIQ's reasoning model, and
 * Gaia's own native generator. Distinct from intentLog.js/reasonLog.js,
 * which log the *outcome* of a decision (a classification, a reasoning
 * result) — a decision can be reached without ever calling a model
 * (heuristic-only, shallow reasoning), so "a decision was logged" doesn't
 * tell you "a model was actually called". This does.
 *
 * Same discipline as intentLog.js: never crosses the API's response
 * boundary, sink is injectable (defaults to console.log) so callers can
 * also persist to decisionStore.js under kind 'llm.call' — that's what
 * makes it show up in /admin's decision log alongside IntentIQ/ReasonIQ.
 */

/**
 * @param {{
 *   system: 'intentiq'|'reasoniq'|'native',
 *   provider?: string|null,
 *   baseUrl?: string|null,
 *   model?: string|null,
 *   purpose?: string|null,
 *   latencyMs?: number|null,
 *   ok: boolean,
 *   errorMessage?: string|null,
 *   contextId?: string|null,
 *   correlationId?: string|null,
 *   timestamp?: string,
 * }} entry
 * @param {(line: string) => void} [sink] injectable for tests; defaults to console.log
 */
function logLlmCall(entry, sink = (line) => console.log(line)) {
  const record = {
    kind: 'llm.call',
    timestamp: entry.timestamp || new Date().toISOString(),
    system: entry.system,
    provider: entry.provider || null,
    baseUrl: entry.baseUrl || null,
    model: entry.model || null,
    purpose: entry.purpose || null,
    latencyMs: typeof entry.latencyMs === 'number' ? entry.latencyMs : null,
    ok: Boolean(entry.ok),
    errorMessage: entry.errorMessage || null,
    contextId: entry.contextId || null,
    correlationId: entry.correlationId || null,
  };
  sink(JSON.stringify(record));
  return record;
}

module.exports = { logLlmCall };
