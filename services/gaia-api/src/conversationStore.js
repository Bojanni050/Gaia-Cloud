'use strict';

/**
 * Chat history — the full transcript of each conversation, persisted
 * server-side in Gaia Cloud (architecture.md: no client holds canonical
 * state; roadmap.md V1 "Must Have": "reopening Gaia feels like resuming,
 * not restarting" — a promise Milestone 2 explicitly deferred when
 * conversations went in-memory-only on Desktop).
 *
 * This is deliberately NOT Hindsight. Architecture.md is explicit:
 * "Reflection, not logging. Hindsight does not store the raw transcript
 * as memory." This store is the raw transcript, on purpose — it's the
 * literal chat log a person re-opens to keep reading, not a reflective
 * memory Logos reasons over. Two different jobs, two different stores.
 *
 * Same layout discipline as library.js: one directory per conversation
 * (`<historyDir>/<id>/meta.json` + `.../messages.json`), no shared index
 * to corrupt under concurrent writes. `id` is chosen by the client (the
 * conversation's own local thread id) and used directly as a directory
 * name, so it's validated here — never trust a path component from a
 * request body.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function resolveHistoryDir(env = process.env) {
  if (env.HISTORY_PATH) return env.HISTORY_PATH;
  const devPath = path.resolve(__dirname, '../data/history');
  const containerPath = '/app/data/history';
  return fs.existsSync('/app') ? containerPath : devPath;
}

// Directory names only — no path separators, no traversal, nothing that
// isn't a plain identifier. A client-supplied conversationId that fails
// this is rejected rather than silently sanitized.
const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isValidId(id) {
  return typeof id === 'string' && VALID_ID.test(id);
}

class InvalidConversationIdError extends Error {
  constructor(id) {
    super(`invalid conversation id: ${JSON.stringify(id)}`);
    this.name = 'InvalidConversationIdError';
  }
}

class ConversationNotFoundError extends Error {
  constructor(id) {
    super(`conversation not found: ${id}`);
    this.name = 'ConversationNotFoundError';
  }
}

const MAX_TITLE_CHARS = 60;

/**
 * Whitespace collapsed to single spaces, trimmed, and capped — the shape of
 * every title this store writes, whether it was derived, chosen by the
 * server (Eleos) or written by Gaia's own model (conversationTitle.js).
 */
function normalizeTitle(text, max = MAX_TITLE_CHARS) {
  const collapsed = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function deriveTitle(messages) {
  const firstUser = (messages || []).find((m) => m && m.role === 'user' && m.content);
  if (!firstUser) return 'Untitled';
  return normalizeTitle(firstUser.content) || 'Untitled';
}

/**
 * A client-supplied turn time, normalized to a valid ISO-8601 string, or
 * null when absent/unparseable. Arbitrary client text is rejected here so a
 * `createdAt` is either a real time or not written at all.
 */
function normalizeCreatedAt(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

/**
 * @param {{ historyDir?: string }} [options]
 */
function createConversationStore(options = {}) {
  const historyDir = options.historyDir || resolveHistoryDir();
  // Lets historyRoutes.js's SSE endpoint push a fresh list to connected
  // clients whenever a save/delete changes it, instead of them polling.
  // No payload on the event — listeners just re-read via listConversations()
  // — so this stays correct even if two writes race.
  const events = new EventEmitter();

  function convDir(id) {
    return path.join(historyDir, id);
  }
  function metaPath(id) {
    return path.join(convDir(id), 'meta.json');
  }
  function messagesPath(id) {
    return path.join(convDir(id), 'messages.json');
  }

  /** The previously stored transcript, or [] when there isn't a readable one. */
  function readStoredMessages(id) {
    try {
      const messages = JSON.parse(fs.readFileSync(messagesPath(id), 'utf-8'));
      return Array.isArray(messages) ? messages : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Persists the full transcript so far for `id` — overwrites, doesn't
   * append, since the caller (turn.js/server.js) already has the
   * complete history in memory each turn. Title is derived once, from
   * the first save, and kept stable across later turns.
   *
   * Each message carries its own `createdAt` (ISO-8601). A client that
   * knows when a turn was said (Desktop stamps one per message) has that
   * time preserved. When a message arrives without one — an older client,
   * or the assistant reply the server appends itself — the stored time
   * from the previous save is reused if the message is unchanged at the
   * same position (same role+content), so re-sending the whole history
   * each turn never re-stamps earlier turns; a genuinely new message is
   * stamped now. Only role/content/createdAt are ever written — any other
   * client field is still stripped — plus one server-set flag: `interrupted:
   * true` on an assistant reply the user cut off mid-stream (turn.js saves
   * the partial text it had streamed). It is written only when it is exactly
   * `true`, so a client cannot invent other markers.
   * @param {string} id
   * @param {Array<{role: string, content: string, createdAt?: string}>} messages
   * @param {{ title?: string }} [options] an explicit, chosen title for a NEWLY
   *   created conversation. Used by Gaia-initiated threads (Eleos check-ins)
   *   that have no user message to derive a title from, and by the first turn's
   *   AI-written name (conversationTitle.js, through turn.js); ignored once the
   *   conversation exists, and ignored when blank.
   * @throws {InvalidConversationIdError}
   */
  function saveConversation(id, messages, options = {}) {
    if (!isValidId(id)) throw new InvalidConversationIdError(id);
    if (!Array.isArray(messages) || messages.length === 0) return;

    fs.mkdirSync(convDir(id), { recursive: true });

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf-8'));
    } catch (_) {
      // `titleSource` records whether the name was chosen (an explicit title,
      // or an AI name written in afterwards — see setTitle) or derived from
      // the opening sentence. Only a derived name may later be replaced.
      const explicitTitle = typeof options.title === 'string' ? normalizeTitle(options.title) : '';
      meta = explicitTitle
        ? { id, title: explicitTitle, titleSource: 'chosen', createdAt: new Date().toISOString() }
        : { id, title: deriveTitle(messages), titleSource: 'derived', createdAt: new Date().toISOString() };
    }
    meta.updatedAt = new Date().toISOString();
    meta.messageCount = messages.length;

    const previous = readStoredMessages(id);
    const plain = messages.map((message, index) => {
      const before = previous[index];
      const unchanged =
        before && before.role === message.role && before.content === message.content ? before : null;
      const createdAt =
        normalizeCreatedAt(message.createdAt) ||
        normalizeCreatedAt(unchanged && unchanged.createdAt) ||
        new Date().toISOString();
      const stored = { role: message.role, content: message.content, createdAt };
      if (message.interrupted === true) stored.interrupted = true;
      return stored;
    });
    fs.writeFileSync(messagesPath(id), JSON.stringify(plain, null, 2), 'utf-8');
    fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), 'utf-8');
    events.emit('changed');
  }

  /** @returns {Array<{id, title, titleSource, createdAt, updatedAt, messageCount}>} newest first */
  function listConversations() {
    if (!fs.existsSync(historyDir)) return [];
    const entries = fs.readdirSync(historyDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const conversations = [];
    for (const entry of entries) {
      try {
        conversations.push(JSON.parse(fs.readFileSync(metaPath(entry.name), 'utf-8')));
      } catch (_) {
        // A directory without a readable meta.json isn't a valid entry
        // (e.g. an interrupted write) — skip it, don't fail the listing.
      }
    }
    conversations.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return conversations;
  }

  /**
   * @param {string} id
   * @returns {{ meta: object, messages: Array<{role: string, content: string, createdAt: string}> }}
   * @throws {InvalidConversationIdError | ConversationNotFoundError}
   */
  function getConversation(id) {
    if (!isValidId(id)) throw new InvalidConversationIdError(id);
    if (!fs.existsSync(metaPath(id))) throw new ConversationNotFoundError(id);
    const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf-8'));
    const messages = JSON.parse(fs.readFileSync(messagesPath(id), 'utf-8'));
    return { meta, messages };
  }

  /**
   * The stored name of `id`, or null when it has none yet (or its meta cannot
   * be read). A caller asking "does this conversation already have a name?"
   * wants this, not getConversation: a conversation without a title is the
   * normal state on its first turn, and that is exactly when a name may be
   * written.
   * @param {string} id
   * @returns {string|null}
   */
  function getTitle(id) {
    if (!isValidId(id)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf-8'));
      return typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Writes `title` as the conversation's name, for a name that arrives AFTER
   * the transcript was already saved — the AI-written title that came back too
   * late for the reply (conversationTitle.js, through turn.js). A name that was
   * already CHOSEN is never overwritten (an explicit title, or an earlier
   * setTitle), so this is safe to call twice and can never rename a
   * conversation behind the person's back. Returns the stored title, or null
   * when there is nothing to write: an invalid id, a blank title, or no
   * transcript yet to name.
   * @param {string} id
   * @param {string} title
   * @returns {string|null}
   */
  function setTitle(id, title) {
    if (!isValidId(id)) return null;
    const clean = normalizeTitle(title);
    if (!clean) return null;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf-8'));
    } catch (_) {
      return null;
    }
    if (meta.titleSource === 'chosen') {
      return typeof meta.title === 'string' && meta.title !== '' ? meta.title : null;
    }
    meta.title = clean;
    meta.titleSource = 'chosen';
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), 'utf-8');
    events.emit('changed');
    return clean;
  }

  /** @throws {InvalidConversationIdError | ConversationNotFoundError} */
  function deleteConversation(id) {
    if (!isValidId(id)) throw new InvalidConversationIdError(id);
    if (!fs.existsSync(convDir(id))) throw new ConversationNotFoundError(id);
    fs.rmSync(convDir(id), { recursive: true, force: true });
    events.emit('changed');
  }

  return { saveConversation, listConversations, getConversation, getTitle, setTitle, deleteConversation, historyDir, events };
}

module.exports = {
  createConversationStore,
  resolveHistoryDir,
  isValidId,
  deriveTitle,
  normalizeTitle,
  InvalidConversationIdError,
  ConversationNotFoundError,
};
