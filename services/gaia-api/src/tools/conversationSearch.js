'use strict';

/**
 * conversation_search — a real Gaia capability/tool (v0.1).
 *
 * Searches the FACTUAL conversation history: the current in-flight
 * transcript and/or persisted (saved) conversations. Deliberately distinct
 * from Hindsight — Hindsight holds what Gaia chose to remember
 * (memories/observations/hypotheses/patterns); conversation_search
 * retrieves what was ACTUALLY SAID, including things that were never
 * retained as memory.
 *
 * Boundary (hard):
 *   - retrieval + ranking + compact presentation ONLY;
 *   - never interprets (IntentIQ), reasons (ReasonIQ), consults Hindsight,
 *     calls Hermes/Brave/MCP, decides whether searching is needed (Decision
 *     Engine), renders the client reply (Response Engine), or writes any
 *     memory (Memoryworthiness owns ingestion — search results are NEVER
 *     retained);
 *   - speaks only to the EXISTING conversation persistence boundary
 *     (createConversationStore) plus the in-flight transcript handed to it
 *     by the Orchestrator. No second database, no new index, no vector
 *     store, no LLM call (spec §6 priority level 3: simple full-text).
 *
 * Provenance: every result carries the REAL conversationId plus a stable,
 * derivable messageId ("<conversationId>:<index>"). The existing storage
 * persists messages as bare {role, content} pairs with NO per-message ids
 * or timestamps (see conversationStore.js) — so positional ids are derived,
 * never invented where storage already had them, and the conversation-level
 * timestamp comes straight from the stored meta.
 *
 * Privacy: the store is server-side, single-deployment, behind the same
 * auth middleware as every other route — the capability introduces no new
 * security model and can only ever see the one user's conversations.
 */

const SEARCH_SCOPES = Object.freeze(['current', 'saved', 'all']);
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_TEXT_CHARS = 280;
const MAX_CONTEXT_CHARS = 160;

/** Function words excluded from lexical matching — comparison machinery. */
const QUERY_STOPWORDS = new Set([
  'de', 'het', 'een', 'en', 'van', 'in', 'op', 'voor', 'met', 'dat', 'die',
  'deze', 'dit', 'maar', 'ook', 'als', 'bij', 'uit', 'over', 'tot', 'door',
  'om', 'naar', 'wat', 'wie', 'waar', 'wanneer', 'hoe', 'niet', 'wel',
  'nog', 'er', 'hier', 'daar', 'dan', 'toen', 'dus', 'zo', 'heel', 'meer',
  'graag', 'eigen', 'gewoon', 'alweer', 'even', 'welke', 'zijn', 'was',
  'waren', 'hebben', 'heeft', 'had', 'kan', 'kun', 'zou', 'gaat', 'gaan',
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'when', 'where',
  'who', 'how', 'why', 'you', 'your', 'was', 'were', 'said', 'about',
]);

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function queryTokens(query) {
  return [...new Set(
    normalizeText(query).replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !QUERY_STOPWORDS.has(w))
  )];
}

/**
 * Lexical relevance in [0, 0.99]: share of query tokens present, with a
 * bonus when EVERY token matches one message (a near-phrase hit) and a
 * small recency tilt so later turns outrank earlier duplicates. Deliberately
 * simple — no LLM ranking in 0.1 (spec §10).
 */
function relevanceFor(tokens, text, totalMessages, index) {
  const hay = normalizeText(text);
  let matched = 0;
  for (const t of tokens) if (hay.includes(t)) matched += 1;
  if (matched === 0) return 0;
  let score = matched / tokens.length;
  if (matched === tokens.length) score += 0.15;
  // Recency within the searched conversation: newest message ~ +0.04.
  score += 0.04 * (totalMessages > 1 ? index / (totalMessages - 1) : 0);
  return Math.round(Math.min(0.99, score) * 100) / 100;
}

function truncate(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * @param {{ historyStore: ReturnType<import('../conversationStore').createConversationStore> }} deps
 */
function createConversationSearch(deps = {}) {
  const historyStore = deps.historyStore;
  if (!historyStore || typeof historyStore.listConversations !== 'function') {
    throw new Error('createConversationSearch requires a historyStore');
  }

  /**
   * Search one flat transcript. Returns ranked raw hits with positional
   * provenance and ±1 neighbor context (trimmed).
   */
  function searchTranscript({ conversationId, source, messages, tokens, meta }) {
    const hits = [];
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i];
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue; // system blocks are not conversation
      const relevance = relevanceFor(tokens, m.content, messages.length, i);
      if (relevance <= 0) continue;
      const before = messages[i - 1] && messages[i - 1].content ? truncate(messages[i - 1].content, MAX_CONTEXT_CHARS) : null;
      const after = messages[i + 1] && messages[i + 1].content ? truncate(messages[i + 1].content, MAX_CONTEXT_CHARS) : null;
      hits.push({
        conversationId,
        messageId: `${conversationId}:${i}`,
        role: m.role,
        text: truncate(m.content, MAX_TEXT_CHARS),
        timestamp: (meta && (meta.updatedAt || meta.createdAt)) || null,
        relevance,
        source,
        contextBefore: before,
        contextAfter: after,
        _index: i,
      });
    }
    return hits;
  }

  /**
   * Uniform search interface (spec §2).
   * @param {{
   *   query: string,
   *   scope?: 'current'|'saved'|'all',
   *   conversationId?: string|null,       // explicit SAVED target (scope 'saved')
   *   limit?: number,
   *   currentMessages?: Array<{role: string, content: string}>,
   *   currentConversationId?: string|null, // identity of the in-flight transcript
   * }} input
   * @returns {{ results: Array<object>, total: number }}
   */
  function search(input = {}) {
    const {
      query,
      scope = 'all',
      conversationId = null,
      limit = DEFAULT_LIMIT,
      currentMessages = [],
      currentConversationId = null,
    } = input;

    if (!SEARCH_SCOPES.includes(scope)) {
      throw new Error(`conversation_search: unknown scope "${scope}" (expected ${SEARCH_SCOPES.join('|')})`);
    }
    const tokens = queryTokens(query);
    if (tokens.length === 0) return { results: [], total: 0 };

    const cappedLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
    let hits = [];

    // CURRENT — the in-flight transcript the caller handed us. Never guess:
    // without an explicit current conversation id there is no honest
    // provenance, so the current portion is skipped entirely ('all' then
    // degrades to saved-only) rather than fabricating an identity.
    if ((scope === 'current' || scope === 'all') && currentConversationId
      && Array.isArray(currentMessages) && currentMessages.length > 0) {
      hits = hits.concat(searchTranscript({
        conversationId: currentConversationId,
        source: 'current',
        messages: currentMessages.filter((m) => m && (m.role === 'user' || m.role === 'assistant')),
        tokens,
      }));
    }

    // SAVED — through the existing store boundary only. An explicit
    // `conversationId` restricts the search to exactly that archived
    // conversation (strict isolation); otherwise the whole archive is in
    // scope.
    if (scope === 'saved' || scope === 'all') {
      let targets;
      if (conversationId && scope === 'saved') {
        targets = [conversationId]; // Gaia's explicit target: strict isolation
      } else {
        try {
          targets = historyStore.listConversations().map((c) => c.id);
        } catch (_) {
          targets = [];
        }
      }
      for (const id of targets) {
        let conv;
        try {
          conv = historyStore.getConversation(id);
        } catch (_) {
          continue; // deleted mid-flight / unreadable: skip, never fail the search
        }
        hits = hits.concat(searchTranscript({
          conversationId: id,
          source: 'saved',
          messages: conv.messages || [],
          tokens,
          meta: conv.meta,
        }));
      }
    }

    // Dedupe near-identical messages (same normalized text may recur across
    // saves of overlapping transcripts, mirrored across roles too): keep the
    // highest-relevance hit per normalized text.
    const byKey = new Map();
    for (const h of hits) {
      const key = normalizeText(h.text).replace(/[^a-z0-9\s]/g, '').slice(0, 120);
      const prev = byKey.get(key);
      if (!prev || h.relevance > prev.relevance) byKey.set(key, h);
    }

    const results = [...byKey.values()]
      .sort((x, y) => (y.relevance - x.relevance) || (y._index - x._index))
      .slice(0, cappedLimit)
      .map(({ _index, ...clean }) => clean); // strip internal sort key

    return { results, total: results.length };
  }

  return { search, SEARCH_SCOPES };
}

/**
 * The capability/tool adapter the Orchestrator invokes — same `{ invoke }`
 * shape as every other capability. Terminal single-step like web: it
 * formats the retrieved passages into a compact, provenance-carrying
 * context presentation the Response Engine can deliver. This is retrieval
 * PRESENTATION (quotes + provenance labels), not answer generation.
 *
 * Two DISTINCT conversation identities reach this adapter, never conflated:
 *   - `options.conversationId` (forwarded by the Orchestrator from the turn
 *     context) identifies the CURRENT conversation for current/all scopes;
 *   - `options.input.conversationId` is Gaia's explicit SAVED-TARGET choice
 *     ("search exactly this archived conversation"). A current-conversation
 *     id must never silently restrict a saved search.
 * `options.input` also carries the Decision-chosen { query, scope, limit }.
 */
function createConversationSearchTool({ historyStore } = {}) {
  const engine = createConversationSearch({ historyStore });
  return {
    invoke: async (messages, options = {}) => {
      const input = options.input || {};
      const currentMessages = (Array.isArray(messages) ? messages : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .map(({ role, content }) => ({ role, content }));
      const outcome = engine.search({
        query: input.query,
        scope: input.scope || 'all',
        conversationId: input.conversationId || null, // explicit saved target (Gaia's choice)
        limit: input.limit,
        currentMessages,
        currentConversationId: options.conversationId || null,
      });
      return formatOutcome(outcome);
    },
  };
}

/** Compact, provenance-carrying presentation of the result set. */
function formatOutcome(outcome) {
  if (!outcome || !Array.isArray(outcome.results) || outcome.results.length === 0) {
    return 'Geen relevante passages gevonden in de conversatiegeschiedenis.';
  }
  const lines = [`Gevonden passages (${outcome.total}):`, ''];
  for (const r of outcome.results) {
    const where = r.source === 'current' ? 'dit gesprek' : `opgeslagen gesprek ${r.conversationId}`;
    lines.push(`[${where} · ${r.messageId} · ${r.role}${r.timestamp ? ` · ${r.timestamp}` : ''}]`);
    lines.push(`"${r.text}"`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

module.exports = {
  createConversationSearch,
  createConversationSearchTool,
  formatOutcome,
  SEARCH_SCOPES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_TEXT_CHARS,
};
