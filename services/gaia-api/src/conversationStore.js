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

function deriveTitle(messages) {
  const firstUser = (messages || []).find((m) => m && m.role === 'user' && m.content);
  if (!firstUser) return 'Untitled';
  const text = firstUser.content.trim().replace(/\s+/g, ' ');
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS)}…` : text || 'Untitled';
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
   * client field is still stripped.
   * @param {string} id
   * @param {Array<{role: string, content: string, createdAt?: string}>} messages
   * @throws {InvalidConversationIdError}
   */
  function saveConversation(id, messages) {
    if (!isValidId(id)) throw new InvalidConversationIdError(id);
    if (!Array.isArray(messages) || messages.length === 0) return;

    fs.mkdirSync(convDir(id), { recursive: true });

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf-8'));
    } catch (_) {
      meta = { id, title: deriveTitle(messages), createdAt: new Date().toISOString() };
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
      return { role: message.role, content: message.content, createdAt };
    });
    fs.writeFileSync(messagesPath(id), JSON.stringify(plain, null, 2), 'utf-8');
    fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), 'utf-8');
    events.emit('changed');
  }

  /** @returns {Array<{id, title, createdAt, updatedAt, messageCount}>} newest first */
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

  /** @throws {InvalidConversationIdError | ConversationNotFoundError} */
  function deleteConversation(id) {
    if (!isValidId(id)) throw new InvalidConversationIdError(id);
    if (!fs.existsSync(convDir(id))) throw new ConversationNotFoundError(id);
    fs.rmSync(convDir(id), { recursive: true, force: true });
    events.emit('changed');
  }

  return { saveConversation, listConversations, getConversation, deleteConversation, historyDir, events };
}

module.exports = {
  createConversationStore,
  resolveHistoryDir,
  isValidId,
  deriveTitle,
  InvalidConversationIdError,
  ConversationNotFoundError,
};
