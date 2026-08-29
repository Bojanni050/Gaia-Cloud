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
   * Memoryworthiness 0.1: an optional `metadata` record rides along on the
   * retained item (string→string, same as every Hindsight metadata field)
   * alongside the existing source_message_id provenance.
   * @param {{ summary: string, domain?: string, context?: string, provenance?: object,
   *           metadata?: Record<string,string> }} reflection
   */
  async function reflect({ summary, domain, context, provenance = {}, metadata }) {
    const mergedMetadata = {
      ...(provenance.source_message_id ? { source_message_id: provenance.source_message_id } : {}),
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
    };
    const item = {
      content: summary,
      context: context || domain || null,
      timestamp: provenance.observed_at || null,
      document_id: provenance.conversation_id || undefined,
      metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
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

  /**
   * Knowledge Pages — Hindsight's native, client-managed knowledge-base
   * layer (folders + pages) sitting on top of the same bank's raw
   * memories. A page is a mental model wearing a tree-node identity: its
   * content is synthesized (and kept current) by Hindsight itself, from
   * this bank's memories, via `source_query`. This is an ADDITIONAL layer
   * over recall/reflect above — it never replaces or modifies the raw
   * memory store; it reads from and rebuilds against it.
   */
  const knowledgeBaseUrl = (path = '') => bankUrl(`/knowledge-base${path}`);

  /**
   * POST /knowledge-base/folders — a pure grouping node, no content of its
   * own.
   * @param {{ name: string, parentId?: string|null }} folder
   * @returns {Promise<{ id: string, kind: string, name: string, parentId: string|null }>}
   */
  async function createKnowledgeFolder({ name, parentId } = {}) {
    let response;
    try {
      response = await fetchImpl(knowledgeBaseUrl('/folders'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, parent_id: parentId ?? null }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`hindsight knowledge folder create unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight knowledge folder create responded ${response.status}`);
    }
    const data = await response.json();
    return { id: data.id, kind: data.kind, name: data.name, parentId: data.parent_id ?? null };
  }

  /**
   * POST /knowledge-base/pages — creates a page (a mental model + tree
   * node) that synthesizes and periodically re-synthesizes its content
   * from `sourceQuery` against this bank's memories. Async: the initial
   * content generation runs after this call returns (see `operationId`);
   * read it back with getKnowledgePage once ready.
   * @param {{ name: string, sourceQuery: string, parentId?: string|null,
   *           tags?: string[], maxTokens?: number,
   *           refreshAfterConsolidation?: boolean }} page
   * @returns {Promise<{ pageId: string, mentalModelId: string, operationId: string|null }>}
   */
  async function createKnowledgePage({ name, sourceQuery, parentId, tags, maxTokens, refreshAfterConsolidation } = {}) {
    const body = {
      name,
      source_query: sourceQuery,
      parent_id: parentId ?? null,
    };
    if (Array.isArray(tags)) body.tags = tags;
    if (typeof maxTokens === 'number') body.max_tokens = maxTokens;
    if (typeof refreshAfterConsolidation === 'boolean') {
      body.trigger = { refresh_after_consolidation: refreshAfterConsolidation };
    }
    let response;
    try {
      response = await fetchImpl(knowledgeBaseUrl('/pages'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`hindsight knowledge page create unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight knowledge page create responded ${response.status}`);
    }
    const data = await response.json();
    return { pageId: data.page_id, mentalModelId: data.mental_model_id, operationId: data.operation_id ?? null };
  }

  /**
   * GET /knowledge-base/pages/{id} — reads one page as its full synthesized
   * markdown document. Null on any failure (unreachable, 404, not yet
   * generated) — same "not available yet" posture as getMentalModel,
   * including the same "Generating content..." placeholder a freshly
   * created (or currently refreshing) page reports before synthesis
   * finishes.
   * @param {string} pageId
   * @returns {Promise<{ id: string, name: string, type: string, description: string|null,
   *   tags: string[], timestamp: string|null, body: string|null, markdown: string }|null>}
   */
  async function getKnowledgePage(pageId) {
    let response;
    try {
      response = await fetchImpl(knowledgeBaseUrl(`/pages/${encodeURIComponent(pageId)}`), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (_) {
      return null;
    }
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data) return null;
    if (!data.body || data.body === 'Generating content...') return null;
    return {
      id: data.id,
      name: data.name,
      type: data.type,
      description: data.description ?? null,
      tags: data.tags || [],
      timestamp: data.timestamp ?? null,
      body: data.body ?? null,
      markdown: data.markdown,
    };
  }

  /**
   * GET /knowledge-base/search — hybrid (BM25 + vector, RRF-fused) search
   * over the curated knowledge base ONLY, never raw memories (that stays
   * recall()'s job). Throws on failure, same contract as recall() — the
   * caller (knowledgePages.js) is the policy-gated, never-throws seam.
   * @param {string} query
   * @param {{ limit?: number }} [options]
   * @returns {Promise<Array<{ id: string, name: string, mentalModelId: string|null,
   *   snippet: string, score: number, updatedAt: string|null }>>}
   */
  async function searchKnowledgeBase(query, { limit } = {}) {
    const params = new URLSearchParams({ q: query });
    if (limit) params.set('limit', String(limit));
    let response;
    try {
      response = await fetchImpl(knowledgeBaseUrl(`/search?${params.toString()}`), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`hindsight knowledge search unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight knowledge search responded ${response.status}`);
    }
    const data = await response.json();
    return (data.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      mentalModelId: r.mental_model_id ?? null,
      snippet: r.snippet,
      score: r.score,
      updatedAt: r.updated_at ?? null,
    }));
  }

  /**
   * GET /knowledge-base/tree — the whole knowledge base as a nested
   * folder/page tree. Used for idempotent provisioning (find-by-name-and-
   * parent before creating) and for browsing. Throws on failure — callers
   * that must not break a turn should wrap this themselves.
   * @returns {Promise<Array<object>>} roots, each `{ id, kind, name, parentId,
   *   mentalModelId, managed, description, tags, timestamp, isStale, children }`
   */
  async function getKnowledgeTree() {
    let response;
    try {
      response = await fetchImpl(knowledgeBaseUrl('/tree'), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`hindsight knowledge tree unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight knowledge tree responded ${response.status}`);
    }
    const data = await response.json();
    const mapNode = (n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      parentId: n.parent_id ?? null,
      mentalModelId: n.mental_model_id ?? null,
      managed: Boolean(n.managed),
      description: n.description ?? null,
      tags: n.tags || [],
      timestamp: n.timestamp ?? null,
      isStale: n.is_stale ?? null,
      children: (n.children || []).map(mapNode),
    });
    return (data.roots || []).map(mapNode);
  }

  /**
   * PATCH /knowledge-base/nodes/{id} — rename/move a folder or page, and/or
   * update a page's own options. Only fields explicitly present in the
   * options object are sent, matching the API's "only what you pass
   * changes" contract.
   * @param {string} nodeId
   * @param {{ name?: string, parentId?: string, sourceQuery?: string,
   *           tags?: string[], maxTokens?: number }} options
   */
  async function updateKnowledgeNode(nodeId, options = {}) {
    const body = {};
    if (typeof options.name === 'string') body.name = options.name;
    if (typeof options.parentId === 'string') body.parent_id = options.parentId;
    if (typeof options.sourceQuery === 'string') body.source_query = options.sourceQuery;
    if (Array.isArray(options.tags)) body.tags = options.tags;
    if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens;
    let response;
    try {
      response = await fetchImpl(knowledgeBaseUrl(`/nodes/${encodeURIComponent(nodeId)}`), {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`hindsight knowledge node update unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight knowledge node update responded ${response.status}`);
    }
    return true;
  }

  /**
   * DELETE /knowledge-base/nodes/{id} — deletes a folder (and its whole
   * subtree) or a page (and its backing mental model). Irreversible;
   * never called automatically by anything in this codebase.
   * @param {string} nodeId
   */
  async function deleteKnowledgeNode(nodeId) {
    let response;
    try {
      response = await fetchImpl(knowledgeBaseUrl(`/nodes/${encodeURIComponent(nodeId)}`), {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`hindsight knowledge node delete unreachable: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight knowledge node delete responded ${response.status}`);
    }
    return true;
  }

  return {
    recall,
    reflect,
    getMentalModel,
    retainSync,
    listMemories,
    getMemory,
    patchMemoryState,
    createKnowledgeFolder,
    createKnowledgePage,
    getKnowledgePage,
    searchKnowledgeBase,
    getKnowledgeTree,
    updateKnowledgeNode,
    deleteKnowledgeNode,
  };
}

module.exports = { createHindsightClient };
