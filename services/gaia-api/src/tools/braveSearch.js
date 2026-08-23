'use strict';

/**
 * Gaia's web tool — current external information, via the Brave Search
 * API (https://api.search.brave.com/res/v1/web/search).
 *
 * This is a specialist capability, the same category Hermes and the
 * native generator are — it never decides *whether* Gaia needs current
 * external information (that is the Decision Engine's call, decision/
 * decisionEngine.js's "external_knowledge" branch), it only performs the
 * search once asked. It has no dependency on Hermes, the native
 * generator, IntentIQ/ReasonIQ, the Decision Engine, the Orchestrator, or
 * the Response Engine — a boundary asserted directly in
 * test/braveSearch.test.js, not just described here.
 *
 * Unlike Hermes/the native generator, this is a terminal, single-step
 * capability: it performs the search and returns Gaia's answer text
 * directly (a calm, formatted summary of the top results), because
 * chaining "search, then hand results to Hermes/native to synthesize"
 * would be a two-step plan — decisionSchema.js's documented `sequence`
 * extension point, deliberately not built yet (see that file's own note).
 * A "no results" search is not a failure; it is an honest answer
 * ("nothing relevant found"), same posture as ReasonIQ's own honest
 * uncertainty reporting.
 *
 * Request contract (Brave Search API, confirmed 2026-08):
 *   GET {baseUrl}?q={query}&count={resultCount}
 *   Header: X-Subscription-Token: {apiKey}
 *   -> { web: { results: [{ title, url, description }, ...] } }
 */

const DEFAULT_BASE_URL = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_RESULT_COUNT = 5;
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Reads web-search configuration from environment variables.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, apiKey: string, resultCount: number }}
 */
function readWebSearchConfig(env = process.env) {
  return {
    baseUrl: env.GAIA_WEB_SEARCH_BASE_URL || DEFAULT_BASE_URL,
    apiKey: env.GAIA_WEB_SEARCH_API_KEY || '',
    resultCount: Number(env.GAIA_WEB_SEARCH_RESULT_COUNT) || DEFAULT_RESULT_COUNT,
  };
}

/**
 * @param {{ apiKey: string }} config
 * @returns {boolean}
 */
function isConfigured(config) {
  return Boolean(config.apiKey);
}

/** Strips Brave's own highlight markup (e.g. `<strong>`) from a snippet. */
function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, '');
}

/**
 * Formats search results into Gaia's own calm, source-attributed answer
 * text — this module's one piece of "response generation", scoped to
 * exactly what it found, never anything else.
 * @param {Array<{ title: string, url: string, description: string }>} results
 * @returns {string}
 */
function formatResults(results) {
  if (!results || results.length === 0) {
    return "I looked, but couldn't find anything relevant.";
  }
  const lines = results.map(
    (r) => `- **${stripHtml(r.title)}** — ${stripHtml(r.description)} (${r.url})`
  );
  return ['Here is what I found:', '', ...lines].join('\n');
}

/**
 * Creates Gaia's web-search client.
 *
 * @param {{
 *   baseUrl?: string,
 *   apiKey: string,
 *   resultCount?: number,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 * }} options
 * @returns {{ search: (query: string) => Promise<string> }}
 */
function createBraveSearch(options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const apiKey = options.apiKey || '';
  const resultCount = options.resultCount || DEFAULT_RESULT_COUNT;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!apiKey) {
    throw new Error('GAIA_WEB_SEARCH_API_KEY is required for the web tool');
  }

  /**
   * Searches the web for `query` and returns Gaia's already-formatted
   * answer text — the final reply, not an intermediate result (see this
   * module's own header on why the web tool is a terminal, single-step
   * capability).
   * @param {string} query
   * @returns {Promise<string>}
   */
  async function search(query) {
    const url = new URL(baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(resultCount));

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`[gaia:web] unreachable at ${baseUrl}: ${error.message}`);
      throw new Error('web search unreachable');
    }

    if (!response.ok) {
      console.error(`[gaia:web] responded ${response.status} at ${baseUrl}`);
      throw new Error('web search responded with an error');
    }

    let data;
    try {
      data = await response.json();
    } catch (_) {
      console.error(`[gaia:web] unreadable response at ${baseUrl}`);
      throw new Error('web search returned an unreadable response');
    }

    const results = (data && data.web && Array.isArray(data.web.results)) ? data.web.results : [];
    return formatResults(results);
  }

  return { search };
}

/**
 * Composes readWebSearchConfig + isConfigured + createBraveSearch,
 * mirroring gaiaGenerator.js's/mimoTts.js's own createFromEnv — the one
 * call server.js needs. Returns `undefined` when GAIA_WEB_SEARCH_API_KEY
 * is unset, so callers can treat "no web tool available" the same
 * uniform way as an omitted `nativeGenerator`/`tts`/`tools` entry
 * elsewhere in this codebase (the Decision Engine simply never sees a
 * "web" capability and falls through to Hermes).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ search: Function }|undefined}
 */
function createFromEnv(env = process.env) {
  const config = readWebSearchConfig(env);
  return isConfigured(config) ? createBraveSearch(config) : undefined;
}

module.exports = { createBraveSearch, readWebSearchConfig, isConfigured, createFromEnv, formatResults };
