'use strict';

/**
 * Hindsight client — recall and reflection, server-side.
 *
 * Simpler than gaia-web's HindsightProvider (frontend/src/gaia/integration/
 * memory/HindsightProvider.js): that one has to reach Hindsight through a
 * same-origin nginx proxy because a browser can't call it directly (no
 * CORS support on Hindsight's side). gaia-api is already Tailscale-bound,
 * so it calls Hindsight directly — no proxy trick needed. Hindsight
 * currently has no auth of its own (Tailscale membership is the only
 * access control, same posture as services/cognition).
 */
function createHindsightClient({ baseUrl, bankId, budget = 'mid', fetchImpl = fetch, timeoutMs = 4000 }) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!root) {
    throw new Error('HINDSIGHT_URL is required');
  }
  if (!bankId) {
    throw new Error('HINDSIGHT_BANK_ID is required');
  }

  const headers = { 'Content-Type': 'application/json' };
  const bankUrl = (path = '') => `${root}/v1/default/banks/${bankId}${path}`;

  /**
   * `budget` defaults to Hindsight's own default (`'mid'`, 300 candidates)
   * rather than an artificially narrowed one — it scales every retrieval
   * strategy Hindsight runs (semantic over-fetch, BM25 limit, graph-
   * traversal depth, reranking pool), so a caller that always asked for
   * `'low'` was quietly capping recall quality on every turn. Overridable
   * per call for anything that genuinely only needs a fast/shallow lookup.
   *
   * The full per-result shape is passed through rather than flattened to
   * just text+confidence — `type`, `entities`, `tags`, and the occurred_*
   * window are exactly what distinguishes a graph- or temporal-matched
   * result from a plain semantic one; flattening them here would throw
   * that signal away before any caller got a chance to use it.
   *
   * Hypothesis Persistence 0.1 additions (all optional, additive): `types`,
   * `tags`/`tagsMatch` narrow retrieval natively (`types=["world"]` +
   * `tags=["gaia:hypothesis"]` + `tags_match="all_strict"` is the hypothesis
   * recall), and every result now carries its retained `metadata` — the
   * gaia_hypothesis_* state lives there, never in the relevance scores.
   *
   * @param {string} query
   * @param {{
   *   budget?: 'low'|'mid'|'high',
   *   types?: string[],
   *   tags?: string[],
   *   tagsMatch?: 'any'|'all'|'any_strict'|'all_strict'|'exact',
   * }} [options]
   * @returns {Promise<Array<{
   *   id: string, text: string, type: string|null, context: string|null,
   *   metadata: Record<string,string>|null,
   *   entities: string[]|null, tags: string[], occurredStart: string|null,
   *   occurredEnd: string|null,
   *   scores: { final: number|null, reranker: number|null, semantic: number|null, keyword: number|null },
   * }>>}
   */
  async function recall(query, options = {}) {
    const body = { query, budget: options.budget || budget };
    if (Array.isArray(options.types)) body.types = options.types;
    if (Array.isArray(options.tags)) body.tags = options.tags;
    if (options.tagsMatch) body.tags_match = options.tagsMatch;
    let response;
    try {
      response = await fetchImpl(bankUrl('/memories/recall'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`hindsight recall unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight recall responded ${response.status}`);
    }
    const data = await response.json();
    return (data.results || []).map((r) => ({
      id: r.id,
      text: r.text,
      type: r.type || null,
      context: r.context || null,
      metadata: r.metadata || null,
      entities: r.entities || null,
      tags: r.tags || [],
      occurredStart: r.occurred_start || null,
      occurredEnd: r.occurred_end || null,
      scores: {
        final: typeof r.scores?.final === 'number' ? r.scores.final : null,
        reranker: typeof r.scores?.reranker === 'number' ? r.scores.reranker : null,
        semantic: typeof r.scores?.semantic === 'number' ? r.scores.semantic : null,
        keyword: typeof r.scores?.keyword === 'number' ? r.scores.keyword : null,
      },
    }));
  }

  /**
   * Async by design — retain runs LLM-based fact extraction server-side on
   * Hindsight's own end and can take 10-20s+; the caller must never block
   * a turn on it (matches gaia-web's HindsightProvider.storeReflection).
   * @param {{ summary: string, domain?: string, provenance?: object }} reflection
   */
  async function reflect({ summary, domain, provenance = {} }) {
    const item = {
      content: summary,
      context: domain || null,
      timestamp: provenance.observed_at || null,
      document_id: provenance.conversation_id || undefined,
      metadata: provenance.source_message_id
        ? { source_message_id: provenance.source_message_id }
        : undefined,
      tags: domain ? [domain] : undefined,
    };

    let response;
    try {
      response = await fetchImpl(bankUrl('/memories'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ async: true, items: [item] }),
      });
    } catch (error) {
      throw new Error(`hindsight retain unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight retain responded ${response.status}`);
    }
  }

  /**
   * Fetches one mental model's current content — a standing, periodically
   * refreshed synthesis (Hindsight refreshes it on its own cron/consolidation
   * trigger; this call is a plain read, never an LLM call itself). Returns
   * null rather than throwing on any failure (unreachable, 404, empty
   * content) so a caller can treat "not available yet" and "call failed"
   * the same way.
   * @param {string} mentalModelId
   * @returns {Promise<{ id: string, name: string, content: string, isStale: boolean, lastRefreshedAt: string|null }|null>}
   */
  async function getMentalModel(mentalModelId) {
    let response;
    try {
      response = await fetchImpl(bankUrl(`/mental-models/${mentalModelId}`), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (_) {
      return null;
    }
    if (!response.ok) return null;
    const data = await response.json();
    // A freshly created (or currently refreshing) mental model reports this
    // exact placeholder string as its content before the async generation
    // finishes — treat it the same as "no content yet", not a real summary.
    if (!data.content || data.content === 'Generating content...') return null;
    return {
      id: data.id,
      name: data.name,
      content: data.content,
      isStale: Boolean(data.is_stale),
      lastRefreshedAt: data.last_refreshed_at || null,
    };
  }

  /**
   * Synchronous retain — waits for Hindsight's server-side fact extraction
   * and returns when the memories are queryable. Used by the hypothesis
   * adapter, which must adopt the native fact IDs right after writing (via
   * listMemories by document_id). The existing `reflect` stays async: a
   * conversational turn never blocks on extraction, persistence setup does.
   * @param {{ content: string, context?: string|null, metadata?: Record<string,string>, tags?: string[], documentId?: string }} item
   */
  async function retainSync(item) {
    let response;
    try {
      response = await fetchImpl(bankUrl('/memories'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          async: false,
          items: [{
            content: item.content,
            context: item.context || null,
            timestamp: 'unset',
            document_id: item.documentId || undefined,
            metadata: item.metadata || undefined,
            tags: item.tags || undefined,
          }],
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new Error(`hindsight retain unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight retain responded ${response.status}`);
    }
    return response.json().catch(() => ({}));
  }

  /**
   * Lists raw memory units with Hindsight's native curation fields.
   * GET /v1/default/banks/{bank}/memories/list — filters are the API's own
   * query parameters (type/q/document_id/state); there is deliberately no
   * tag filter on this endpoint (an actual API constraint — tag-scoped
   * retrieval goes through recall()).
   * @returns {Promise<Array<{ id:string, text:string, type:string|null, state:string|null,
   *   context:string|null, metadata:Record<string,string>|null, tags:string[],
   *   documentId:string|null }>>}
   */
  async function listMemories({ type, q, documentId, state, limit = 100 } = {}) {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (q) params.set('q', q);
    if (documentId) params.set('document_id', documentId);
    if (state) params.set('state', state);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    let response;
    try {
      response = await fetchImpl(bankUrl(`/memories/list${qs ? `?${qs}` : ''}`), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`hindsight memories/list unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight memories/list responded ${response.status}`);
    }
    const data = await response.json();
    return (data.items || []).map((u) => ({
      id: u.id,
      text: u.text ?? u.content ?? null,
      type: u.type || u.fact_type || null,
      state: u.state || null,
      context: u.context || null,
      metadata: u.metadata || null,
      tags: u.tags || [],
      documentId: u.document_id || null,
    }));
  }

  /** GET /memories/{id} — one unit incl. metadata/tags/curation state; null on any failure. */
  async function getMemory(id) {
    let response;
    try {
      response = await fetchImpl(bankUrl(`/memories/${encodeURIComponent(id)}`), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (_) {
      return null;
    }
    if (!response.ok) return null;
    const u = await response.json().catch(() => null);
    if (!u) return null;
    return {
      id: u.id,
      text: u.text ?? u.content ?? null,
      type: u.type || u.fact_type || null,
      state: u.state || null,
      context: u.context || null,
      metadata: u.metadata || null,
      tags: u.tags || [],
      documentId: u.document_id || null,
    };
  }

  /**
   * PATCH /memories/{id} — Hindsight's reversible curation state.
   * state='invalidated' removes the unit from recall/consolidation/graph
   * while keeping it auditable; state='valid' restores it. This is the
   * native carrier for Gaia's rejected↔testing re-open semantics.
   * @param {string} id
   * @param {'valid'|'invalidated'} state
   * @param {string} [reason]
   */
  async function patchMemoryState(id, state, reason) {
    const body = { state };
    if (reason) body.reason = reason;
    let response;
    try {
      response = await fetchImpl(bankUrl(`/memories/${encodeURIComponent(id)}`), {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`hindsight memory patch unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight memory patch responded ${response.status}`);
    }
    return true;
  }

  return { recall, reflect, getMentalModel, retainSync, listMemories, getMemory, patchMemoryState };
}

module.exports = { createHindsightClient };
