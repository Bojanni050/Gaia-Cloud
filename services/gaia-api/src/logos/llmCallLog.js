'use strict';

/**
 * Structured, server-side-only logging for every actual LLM HTTP call Gaia
 * makes — Logos's background reflection model and Gaia's own native
 * generator. Distinct from logosLog.js, which logs the *outcome* of a decision (a classification, a
 * reasoning result) — a decision can be reached without ever calling a
 * model (heuristic-only, shallow reflection), so "a decision was logged"
 * doesn't tell you "a model was actually called". This does.
 *
 * Same discipline as logosLog.js: never crosses the API's response
 * boundary, sink is injectable (defaults to console.log) so callers can
 * also persist to decisionStore.js under kind 'llm.call' — that's what
 * makes it show up in /admin's decision log alongside Logos records.
 * (`system: 'reasoniq'` is the retired V2 label, still accepted when
 * reading old log files.)
 */

/**
 * @param {{
 *   system: 'intentiq'|'logos'|'aion'|'native'|'reasoniq',
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
 * @param {(line: string) => void} [sink] injectable for tests; defaults to console.log. A non-function (e.g. a console-like object passed through a loose `logger`) is ignored and falls back to console.log, so a logging call can never crash its caller.
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
  const write = typeof sink === 'function' ? sink : (line) => console.log(line);
  write(JSON.stringify(record));
  return record;
}

module.exports = { logLlmCall };
