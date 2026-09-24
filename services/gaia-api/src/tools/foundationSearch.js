'use strict';

/**
 * foundation — a READ-ONLY retrieval capability over Foundation, Bo's
 * epistemische geheugen (github.com/Bojanni050/Foundation: observaties,
 * hypothesen, mens-bevestigde feiten — "dit is geregistreerd").
 *
 * Lets a PLAN use Foundation as an explicit step:
 *
 *   { id:'s1', type:'retrieval', capability:'foundation',
 *     input:{ query:'...' }, sources:[] }
 *
 * Seams exactly like hindsightRetrieval.js: `{ invoke }` returning
 * `{ results: [{ text, relevance }], total }` for the Orchestrator's plan
 * rendering, query-driven, never writes, never decides whether it should
 * run (the Decision Engine does that — via the `recordedKnowledge` signal,
 * the archive counterpart of `rememberedKnowledge`'s Hindsight signal).
 *
 * Epistemic transparency (Manifest §5 — the same reason Foundation's own
 * API owns status server-side): every result is LABELLED with its epistemic
 * status (`[bevestigd feit]`, `[hypothese · open]`, `[vervallen feit]`, …)
 * before it reaches Gaia's context, so a hypothesis can never silently
 * masquerade as a settled fact in a generated answer.
 *
 * Client: GET {baseUrl}/api/memory/search?q=…&limit=… — semantic search
 * over hypotheses + facts, scored on Foundation's own four axes. The read
 * routes are unauthenticated (server/auth.js applies requireAuth only to
 * ingest/write routes); Foundation also guards on the Origin header, which
 * node-fetch never sends, so a plain server-to-server GET passes. An
 * optional FOUNDATION_API_TOKEN rides along as a Bearer header only when
 * set — forward-compatible with Foundation ever gating reads.
 *
 * Configuration follows the house pattern (braveSearch.js): unset env =
 * `createFromEnv` returns `undefined` and the Decision Engine simply never
 * sees a `foundation` capability — no error, no phantom routing.
 *
 * It has no dependency on Hermes, the native generator, IntentIQ/ReasonIQ,
 * the Decision Engine, the Orchestrator, or the Response Engine — a boundary
 * asserted directly in test/foundationSearch.test.js, not just described.
 */

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 8000;
// Same compact-passages budget hindsightRetrieval.js and the Orchestrator's
// plan renderer use — a retrieval step is background, never the reply itself.
const MAX_TEXT_LENGTH = 280;

/**
 * Reads Foundation-search configuration from environment variables.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, token: string, limit: number }}
 */
function readFoundationConfig(env = process.env) {
  return {
    baseUrl: String(env.FOUNDATION_MEMORY_URL || '').trim(),
    token: String(env.FOUNDATION_API_TOKEN || '').trim(),
    limit: Number(env.FOUNDATION_MEMORY_LIMIT) || DEFAULT_LIMIT,
  };
}

/**
 * @param {{ baseUrl: string }} config
 * @returns {boolean}
 */
function isConfigured(config) {
  return Boolean(config.baseUrl);
}

/**
 * The epistemic status label every result carries into Gaia's context.
 * Foundation's contract: `kind: 'fact'` rows ARE confirmed (the fact table
 * is append-only and exists only after human confirmation); `superseded`
 * marks a fact a later confirmation replaced; `kind: 'hypothesis'` carries
 * its own status. Unknown shapes get an honest generic label, never a
 * confident-sounding guess.
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
 * Creates the Foundation client — one method: semantic search. Read-only by
 * design (Boundary: geen dode API surface — recall/export/episodes alleen
 * toevoegen als er een consumer is).
 *
 * @param {{
 *   baseUrl: string,
 *   token?: string,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 * }} options
 * @returns {{ searchResults: (query: string, options?: { limit?: number }) => Promise<Array<object>> }}
 */
function createFoundationClient({ baseUrl, token = '', fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!root) {
    throw new Error('FOUNDATION_MEMORY_URL is required');
  }

  /**
   * Semantic search over Foundation's memory.
   * @param {string} query
   * @param {{ limit?: number }} [options]
   * @returns {Promise<Array<{ kind: string, id: string, text: string,
   *   status?: string, superseded?: boolean, axes?: object, score?: number }>>}
   *   Empty list when there is nothing relevant — a "no results" answer is
   *   honest, not a failure.
   */
  async function searchResults(query, { limit } = {}) {
    const bounded = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
    const url = new URL(`${root}/api/memory/search`);
    url.searchParams.set('q', String(query));
    url.searchParams.set('limit', String(bounded));

    let response;
    try {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Details go to the server log, never into the thrown message —
      // same posture as braveSearch.js (no host/token leakage upstream).
      console.error(`[gaia:foundation] unreachable at ${root}: ${error.message}`);
      throw new Error('foundation search unreachable');
    }

    if (!response.ok) {
      // 503 is Foundation's own "local embedding unavailable" answer —
      // surfaced to the Decision Engine as a calm, generic capability failure.
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

  return { searchResults };
}

/**
 * The capability adapter: `{ invoke }` in the hindsightRetrieval.js shape,
 * so the legacy bridge, the plan renderer and the timing wrapper in turn.js
 * treat it like any other retrieval step.
 *
 * @param {{ client: { searchResults: Function } }} options
 * @returns {{ invoke: (messages: Array, options?: object) => Promise<{ results: Array<{ text: string, relevance: number|null }>, total: number }> }}
 */
function createFoundationRetrievalCapability({ client } = {}) {
  if (!client || typeof client.searchResults !== 'function') {
    throw new Error('createFoundationRetrievalCapability requires a foundation client');
  }

  /**
   * @param {Array} _messages unused — retrieval is query-driven
   * @param {{ input?: { query?: string, limit?: number } }} [options]
   * @returns {Promise<{ results: Array<{ text: string, relevance: number|null }>, total: number }>}
   */
  async function invoke(_messages, options = {}) {
    const input = options.input || {};
    const query = String(input.query || '').trim();
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number(input.limit) || DEFAULT_LIMIT));
    if (!query) return { results: [], total: 0 };

    const found = await client.searchResults(query, { limit });
    const results = (found || [])
      .slice(0, limit)
      .filter((r) => r && r.text && String(r.text).trim())
      .map((r) => ({
        // Label first, then content, then one flat pass — the status must
        // survive truncation, it is the whole point of the label.
        text: `${epistemicLabel(r)} ${String(r.text).replace(/\s+/g, ' ').trim()}`
          .slice(0, MAX_TEXT_LENGTH),
        relevance: typeof r.score === 'number' ? r.score : null,
      }));
    return { results, total: results.length };
  }

  return { invoke };
}

/**
 * Compact presentation for a terminal (non-plan) use of this capability —
 * same posture as hindsightRetrieval.js's formatHindsightOutcome.
 * @param {{ results?: Array<{ text: string, relevance?: number|null }> }} outcome
 * @returns {string}
 */
function formatFoundationOutcome(outcome) {
  if (!outcome || !Array.isArray(outcome.results) || outcome.results.length === 0) {
    return 'Niets in Foundation gevonden.';
  }
  const lines = ['Gevonden in Foundation:', ''];
  for (const r of outcome.results) {
    lines.push(`- ${r.text}${typeof r.relevance === 'number' ? ` (relevantie: ${r.relevance})` : ''}`);
  }
  return lines.join('\n');
}

/**
 * The one call server.js needs, mirroring braveSearch.js's createFromEnv:
 * `undefined` when FOUNDATION_MEMORY_URL is unset, so callers can treat
 * "no foundation capability" the same uniform way as an omitted
 * `web`/`tools` entry — the Decision Engine never sees a `foundation`
 * capability and recorded-knowledge turns fall through to the existing
 * cascade unchanged.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ invoke: Function }|undefined}
 */
function createFromEnv(env = process.env) {
  const config = readFoundationConfig(env);
  if (!isConfigured(config)) return undefined;
  const client = createFoundationClient(config);
  return createFoundationRetrievalCapability({ client });
}

module.exports = {
  readFoundationConfig,
  isConfigured,
  epistemicLabel,
  createFoundationClient,
  createFoundationRetrievalCapability,
  formatFoundationOutcome,
  createFromEnv,
};
