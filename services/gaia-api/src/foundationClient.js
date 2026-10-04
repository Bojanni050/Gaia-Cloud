'use strict';

/**
 * Foundation client — Gaia's two seams to Foundation
 * (github.com/Bojanni050/Foundation: "de stekkerdoos" — raw observations,
 * the ingestion gateway, MCP).
 *
 *   1. submitObservation(entry) — carries Gaia's own completed turn into
 *      Foundation's observation stream (POST /api/ingest/chat, source
 *      'gaia'). Foundation owns the status: everything enters as
 *      `observation`; a client claiming a status is refused (422).
 *   2. searchResults(query) — read-only semantic search over Foundation's
 *      memory (GET /api/memory/search), every result epistemically labelled
 *      so a hypothesis can never masquerade as a settled fact.
 *
 * This client is Foundation-only. It never writes to Hindsight (that is the
 * Logos sync job) and never reasons — it only carries turns out and search
 * results back.
 *
 * Configuration follows the house pattern (unset base URL ⇒ createFromEnv
 * returns undefined and every caller falls through unchanged):
 *   FOUNDATION_URL / FOUNDATION_MEMORY_URL   base URL, e.g. http://100.65.0.15:4577
 *   FOUNDATION_API_TOKEN                     optional bearer (write routes require it)
 *   FOUNDATION_MEMORY_LIMIT                  default search result count (1-10)
 */

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 8000;
const SUBMIT_TIMEOUT_MS = 4000;
// Same compact-passages budget the old retrieval capability used — Foundation
// search is background context, never the reply itself.
const MAX_TEXT_LENGTH = 280;

/**
 * Reads Foundation configuration from environment variables.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, token: string, limit: number }}
 */
function readFoundationConfig(env = process.env) {
  return {
    baseUrl: String(env.FOUNDATION_URL || env.FOUNDATION_MEMORY_URL || '').trim(),
    token: String(env.FOUNDATION_API_TOKEN || '').trim(),
    limit: Number(env.FOUNDATION_MEMORY_LIMIT) || DEFAULT_LIMIT,
  };
}

/** @param {{ baseUrl?: string }} config @returns {boolean} */
function isConfigured(config) {
  return Boolean(config && config.baseUrl);
}

/**
 * The epistemic status label every result carries into Gaia's context.
 * Foundation's contract: `kind: 'fact'` rows ARE confirmed (the fact table
 * exists only after human confirmation); `superseded` marks a fact a later
 * confirmation replaced; `kind: 'hypothesis'` carries its own status. Unknown
 * shapes get an honest generic label, never a confident-sounding guess.
 * @param {{ kind?: string, status?: string, superseded?: boolean }} result
 * @returns {string}
 */
function epistemicLabel(result) {
  if (!result) return '[geheugen]';
  if (result.kind === 'fact') {
    return result.superseded ? '[vervallen feit]' : '[bevestigd feit]';
  }
  if (result.kind === 'hypothesis') {
    if (result.status === 'confirmed') return '[hypothese · bevestigd]';
    if (result.status === 'rejected') return '[hypothese · verworpen]';
    return '[hypothese · open]';
  }
  return '[geheugen]';
}

/**
 * @param {{
 *   baseUrl: string,
 *   token?: string,
 *   limit?: number,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 * }} options
 * @returns {{
 *   searchResults: (query: string, options?: { limit?: number }) => Promise<Array<object>>,
 *   submitObservation: (entry: object) => Promise<boolean>,
 *   limit: number,
 * }}
 */
function createFoundationClient({
  baseUrl, token = '', limit = DEFAULT_LIMIT, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!root) throw new Error('FOUNDATION_URL is required');

  function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Semantic search over Foundation's memory.
   * @param {string} query
   * @param {{ limit?: number }} [options]
   * @returns {Promise<Array<object>>} empty list when nothing relevant — an
   *   honest "no results" is not a failure.
   */
  async function searchResults(query, { limit: requested } = {}) {
    const bounded = Math.max(1, Math.min(MAX_LIMIT, Number(requested) || Number(limit) || DEFAULT_LIMIT));
    const url = new URL(`${root}/api/memory/search`);
    url.searchParams.set('q', String(query));
    url.searchParams.set('limit', String(bounded));

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: authHeaders({ Accept: 'application/json' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Details go to the server log, never into the thrown message — no
      // host/token leakage upstream (same posture as the old capability).
      console.error(`[gaia:foundation] unreachable at ${root}: ${error.message}`);
      throw new Error('foundation search unreachable');
    }

    if (!response.ok) {
      console.error(`[gaia:foundation] responded ${response.status} at ${root}`);
      throw new Error('foundation search responded with an error');
    }

    let data;
    try {
      data = await response.json();
    } catch (_) {
      console.error(`[gaia:foundation] unreadable response at ${root}`);
      throw new Error('foundation search returned an unreadable response');
    }

    return (data && Array.isArray(data.results)) ? data.results : [];
  }

  /**
   * Carries one completed turn into Foundation's observation stream. Never
   * throws — this is the fire-and-forget shipper of Gaia's own turns, so a
   * dead Foundation can never affect a delivered reply. Foundation refuses
   * unknown fields and any client-claimed `status`; we send only the `chat`
   * entry-point's allowed fields.
   * @param {{ content?: string, source?: string, title?: string, tags?: string[],
   *           turns?: Array<{ role?: string, text: string }>, occurredAt?: string }} entry
   * @returns {Promise<boolean>} true when Foundation accepted it
   */
  async function submitObservation(entry = {}) {
    const content = String(entry.content || '').trim();
    if (!content) return false;

    const body = { content, source: entry.source || 'gaia' };
    if (entry.title) body.title = entry.title;
    if (Array.isArray(entry.tags) && entry.tags.length > 0) body.tags = entry.tags;
    if (Array.isArray(entry.turns) && entry.turns.length > 0) {
      body.turns = entry.turns
        .filter((t) => t && typeof t.text === 'string')
        .map((t) => (t.role ? { role: t.role, text: t.text } : { text: t.text }));
    }
    if (entry.occurredAt) body.occurredAt = entry.occurredAt;

    try {
      const response = await fetchImpl(`${root}/api/ingest/chat`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      });
      return Boolean(response && response.ok);
    } catch (_) {
      return false;
    }
  }

  return { searchResults, submitObservation, limit: Number(limit) || DEFAULT_LIMIT };
}

/**
 * Renders the Foundation search results as a system-prompt block. Status
 * first, then content — the label is the whole point, so it must survive
 * truncation. Returns null when there is nothing to say.
 * @param {Array<object>} results
 * @returns {string|null}
 */
function renderFoundationContext(results) {
  const usable = (Array.isArray(results) ? results : [])
    .filter((r) => r && r.text && String(r.text).trim());
  if (usable.length === 0) return null;

  const lines = usable.map((r) => {
    const labelled = `${epistemicLabel(r)} ${String(r.text).replace(/\s+/g, ' ').trim()}`;
    return `- ${labelled.slice(0, MAX_TEXT_LENGTH)}`;
  });
  return [
    'Wat er in Foundation geregistreerd staat over deze vraag (met epistemische status — een open hypothese is geen bevestigd feit):',
    ...lines,
  ].join('\n');
}

/**
 * The one call server.js needs. `undefined` when no base URL is set, so the
 * caller treats "no Foundation" as a uniform, silent absence.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ReturnType<typeof createFoundationClient>|undefined}
 */
function createFromEnv(env = process.env) {
  const config = readFoundationConfig(env);
  if (!isConfigured(config)) return undefined;
  return createFoundationClient(config);
}

module.exports = {
  readFoundationConfig,
  isConfigured,
  epistemicLabel,
  createFoundationClient,
  renderFoundationContext,
  createFromEnv,
};
