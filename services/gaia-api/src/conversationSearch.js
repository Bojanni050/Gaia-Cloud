'use strict';

/**
 * Conversation search — reading and searching the literal text of SAVED past
 * conversations (conversationStore.js).
 *
 * Why this exists: the transcript is deliberately NOT Hindsight (see
 * conversationStore.js's header — reflection, not logging). Hindsight receives
 * only what Memoryworthiness judged worth remembering, so when someone asks
 * "what did I actually say about X", the honest source is the raw transcript,
 * which may hold a moment that was never deemed memoryworthy. This is the
 * `conversation_search` capability the registry already declares
 * (capabilityRegistry.js): "searching the literal text of current and past
 * conversations — what was actually said, by either of you".
 *
 * Scope: SAVED conversations only. The current, in-flight conversation is
 * already in the prompt verbatim every turn, so searching it would only
 * duplicate what the model can already see.
 *
 * Deterministic and cheap: no LLM, no index, a bounded scan over the stored
 * transcripts with a token-coverage score. Personal scale (dozens to hundreds
 * of conversations); if that ever grows, an index can be added behind this
 * same seam without changing callers.
 *
 * Never throws: an unreadable conversation is skipped, an empty query is an
 * honest "nothing to search".
 */

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_CONVERSATIONS = 500;
const SNIPPET_CHARS = 240;
const MIN_TOKEN_LENGTH = 3;
const MAX_BLOCK_CHARS = 300;

// Small NL/EN stopword set: function words that carry no search signal, so a
// question like "wat zei ik over de VPS" searches for "vps", not "wat".
const STOPWORDS = new Set([
  'wat', 'wie', 'waar', 'wanneer', 'welke', 'waarom', 'hoe', 'heb', 'hebt', 'had', 'hadden',
  'ben', 'bent', 'was', 'waren', 'wordt', 'worden', 'zal', 'zou', 'kan', 'kun', 'kon',
  'zeg', 'zei', 'zegt', 'gezegd', 'vertel', 'vertelde', 'noem', 'noemde', 'bedoel', 'bedoelde',
  'over', 'van', 'voor', 'met', 'aan', 'bij', 'uit', 'naar', 'tot', 'als', 'dan', 'toen',
  'het', 'een', 'de', 'die', 'dat', 'dit', 'deze', 'er', 'eens', 'even', 'ook', 'nog',
  'niet', 'maar', 'wel', 'al', 'om', 'te', 'je', 'jij', 'ik', 'we', 'wij', 'ze', 'zij', 'hij',
  'mijn', 'jouw', 'zijn', 'haar', 'ons', 'onze', 'hun',
  'the', 'and', 'for', 'with', 'you', 'your', 'yours', 'that', 'this', 'these', 'those',
  'what', 'who', 'where', 'when', 'which', 'why', 'how', 'did', 'does', 'say', 'said',
  'about', 'have', 'has', 'had', 'was', 'were', 'are', 'from', 'into', 'them', 'they',
  'can', 'could', 'would', 'should', 'tell', 'told', 'mean', 'meant', 'mention', 'mentioned',
]);

/**
 * Normalizes text into unique, lowercase, meaningful search tokens.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const raw = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t));
  return [...new Set(raw)];
}

/**
 * Scores one message against the query tokens by coverage (how many distinct
 * query tokens the message contains).
 * @param {string} content
 * @param {string[]} tokens
 * @returns {{ score: number, matched: string[] }}
 */
function scoreMessage(content, tokens) {
  const hay = String(content || '').toLowerCase();
  if (!hay || tokens.length === 0) return { score: 0, matched: [] };
  const matched = tokens.filter((t) => hay.includes(t));
  if (matched.length === 0) return { score: 0, matched: [] };
  return { score: matched.length / tokens.length, matched };
}

/**
 * A short excerpt around the first matched term, with ellipses when trimmed.
 * @param {string} content
 * @param {string[]} matched
 * @param {number} [max]
 * @returns {string}
 */
function makeSnippet(content, matched, max = SNIPPET_CHARS) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of matched) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (at === -1 || idx < at)) at = idx;
  }
  if (at === -1) return `${text.slice(0, max)}…`;
  const start = Math.max(0, at - Math.floor(max / 3));
  const end = Math.min(text.length, start + max);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * @param {{ store: object, maxResults?: number, maxConversations?: number, snippetChars?: number }} options
 */
function createConversationSearch({ store, maxResults = DEFAULT_LIMIT, maxConversations = MAX_CONVERSATIONS, snippetChars = SNIPPET_CHARS } = {}) {
  /**
   * Searches the saved conversations for the query.
   * @param {string} query
   * @param {{ excludeConversationId?: string|null, limit?: number }} [options]
   * @returns {Array<{ conversationId: string, title: string, updatedAt: string|null,
   *   role: string, snippet: string, score: number, matchedTerms: string[] }>}
   */
  function search(query, { excludeConversationId = null, limit } = {}) {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    if (!store || typeof store.listConversations !== 'function') return [];

    const bounded = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || maxResults));
    let metas;
    try {
      metas = store.listConversations();
    } catch (_) {
      return [];
    }
    if (!Array.isArray(metas)) return [];

    const hits = [];
    for (const meta of metas.slice(0, maxConversations)) {
      if (!meta || !meta.id) continue;
      if (excludeConversationId && meta.id === excludeConversationId) continue;

      let messages;
      try {
        const conversation = store.getConversation(meta.id);
        messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      } catch (_) {
        continue; // unreadable conversation: skip, never fail the search
      }

      let best = null;
      for (const message of messages) {
        if (!message || typeof message.content !== 'string') continue;
        const { score, matched } = scoreMessage(message.content, tokens);
        if (score <= 0) continue;
        if (!best || score > best.score) {
          best = { score, matched, role: message.role || 'user', content: message.content };
        }
      }
      if (!best) continue;

      hits.push({
        conversationId: meta.id,
        title: meta.title || 'Untitled',
        updatedAt: meta.updatedAt || meta.createdAt || null,
        role: best.role,
        snippet: makeSnippet(best.content, best.matched, snippetChars),
        score: Number(best.score.toFixed(4)),
        matchedTerms: best.matched,
      });
    }

    hits.sort((a, b) => (b.score - a.score) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return hits.slice(0, bounded);
  }

  return { search };
}

const { relativeAge } = require('./nowContext');

/**
 * `updatedAt` as Gaia should see it: the calendar date plus its real age.
 * "" when there is no usable timestamp, so the caller's line is unchanged.
 */
function formatHitWhen(updatedAt, now) {
  const date = updatedAt ? new Date(updatedAt) : null;
  const absolute = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('nl-NL') : '';
  const age = relativeAge(updatedAt, now);
  return [absolute, age].filter(Boolean).join(' · ');
}

/**
 * Renders the search hits as a system-prompt block. Returns null when there is
 * nothing to say. Literal excerpts, clearly framed as such — never dressed up
 * as memory, and a partial fragment is stated to be partial.
 * @param {Array<object>} hits
 * @param {number|Date} [now] the turn's single clock, for each hit's age
 * @returns {string|null}
 */
function renderConversationHistoryContext(hits, now = Date.now()) {
  const usable = (Array.isArray(hits) ? hits : []).filter((h) => h && h.snippet && String(h.snippet).trim());
  if (usable.length === 0) return null;

  const lines = usable.map((h) => {
    const when = formatHitWhen(h.updatedAt, now);
    const who = h.role === 'assistant' ? 'Gaia' : 'de persoon';
    const head = `[${h.title}${when ? ` · ${when}` : ''}] ${who}`;
    return `- ${head}: "${String(h.snippet).replace(/\s+/g, ' ').trim().slice(0, MAX_BLOCK_CHARS)}"`;
  });

  return [
    'Letterlijke fragmenten uit eerdere gesprekken met deze persoon (wat er echt gezegd is — een fragment kan onvolledig zijn; gebruik het alleen waar het echt relevant is, en verzin niets bij):',
    ...lines,
  ].join('\n');
}

module.exports = {
  createConversationSearch,
  renderConversationHistoryContext,
  tokenize,
  scoreMessage,
  makeSnippet,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SNIPPET_CHARS,
  STOPWORDS,
};
