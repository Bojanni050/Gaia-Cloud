'use strict';

/**
 * The conversation she is in, read back on demand.
 *
 * Why this exists (18-10-2026): Bo asked "Kun je terugkijken in dit gesprek?"
 * and she tried a tool that does not exist — the call reached the dispatcher
 * as `conversation_search`, came back as 'Unknown action.' and she fell back to
 * `search_memory`, which is memory and not the conversation. Earlier that same
 * morning she answered a provenance question ("Waar komt dit vandaan?") with
 * "Dat heb je zelf gezegd, vorige week in een gesprek" while nothing in the
 * transcript supported it. A thread is already in her prompt, but in a long one
 * an earlier exchange blurs, and a question about what was said deserves the
 * actual line rather than a guess.
 *
 * Scope, deliberately: the turns of THIS request only. A client that trims its
 * history also trims what this tool can see, because the stored transcript is
 * overwritten each turn with exactly what the client sent
 * (conversationStore.saveConversation). It is a way to find something, not a
 * way to reach something that never arrived.
 *
 * Shape: same contract as the memory and web tools — a `TOOLS` array and an
 * `onToolCall(name, args)` that answers 'Unknown action.' for anything it does
 * not own, so the turn can dispatch over several tools in order.
 */

const MAX_HITS = 6;
const SNIPPET_CHARS = 240;
const MIN_TERM_LENGTH = 3;

const LOOK_BACK_TOOL = {
  type: 'function',
  function: {
    name: 'read_back',
    description:
      'Look back in the conversation you are having right now and quote what was actually said earlier in it. '
      + 'Use this instead of guessing or saying you cannot check. It searches only this conversation — not your '
      + 'memory, not other conversations and not the person\'s computer.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A few words to look for, as they were said (a name, a topic, a phrase).',
        },
      },
      required: ['query'],
    },
  },
};

function speakerNames(overrides = {}) {
  let user = 'Bojan';
  let assistant = 'Gaia';
  try {
    // Same single source as the memory summary, so both sides of the
    // conversation are named the way the rest of the system names them.
    const identity = require('../identity');
    if (identity && typeof identity.getUserIdentity === 'function') {
      const resolved = identity.getUserIdentity({});
      if (resolved && resolved.displayName) user = resolved.displayName;
    }
    if (identity && typeof identity.getAssistantIdentity === 'function') {
      const resolved = identity.getAssistantIdentity();
      if (resolved && resolved.displayName) assistant = resolved.displayName;
    }
  } catch (_) {
    // Identity is never worth failing a turn over.
  }
  return {
    user: overrides.user || user,
    assistant: overrides.assistant || assistant,
  };
}

function words(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= MIN_TERM_LENGTH);
}

/** Fraction of the query's words that appear in the line — boring on purpose. */
function matchScore(terms, text) {
  if (terms.length === 0) return 0;
  const present = new Set(words(text));
  const found = terms.filter((term) => present.has(term)).length;
  return found / terms.length;
}

function snippet(text) {
  const oneLine = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= SNIPPET_CHARS) return oneLine;
  return `${oneLine.slice(0, SNIPPET_CHARS - 1).trimEnd()}…`;
}

/**
 * @param {{ messages?: Array, maxHits?: number, names?: {user?: string, assistant?: string} }} [options]
 *   `messages` is the turn's own history, exactly as the client sent it.
 */
function createConversationTool({ messages = [], maxHits = MAX_HITS, names = {} } = {}) {
  const label = speakerNames(names);
  const turns = [];
  (Array.isArray(messages) ? messages : []).forEach((message, index) => {
    if (!message || typeof message.content !== 'string' || message.content.trim() === '') return;
    if (message.role !== 'user' && message.role !== 'assistant') return;
    turns.push({ position: index + 1, role: message.role, content: message.content });
  });
  // The last thing on the wire is the question being asked now, and "earlier"
  // never means that.
  if (turns.length > 0 && turns[turns.length - 1].role === 'user') turns.pop();

  function onToolCall(name, args = {}) {
    if (name !== LOOK_BACK_TOOL.function.name) return 'Unknown action.';
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return 'Nothing to look for.';
    const terms = words(query);
    if (terms.length === 0) return 'The search phrase had no words in it, so nothing was looked up.';
    if (turns.length === 0) return 'There is nothing earlier in this conversation.';

    const hits = turns
      .map((turn) => ({ ...turn, score: matchScore(terms, turn.content) }))
      .filter((turn) => turn.score > 0)
      .sort((a, b) => b.score - a.score || b.position - a.position)
      .slice(0, Math.max(1, maxHits));

    if (hits.length === 0) return 'Nothing in this conversation matches that.';

    const lines = hits
      .map((hit) => `- [${hit.position}] ${hit.role === 'assistant' ? label.assistant : label.user}: "${snippet(hit.content)}"`)
      .join('\n');
    return `Earlier in this conversation:\n${lines}`;
  }

  return { TOOLS: [LOOK_BACK_TOOL], onToolCall, turns };
}

module.exports = { createConversationTool, LOOK_BACK_TOOL, matchScore, snippet };
