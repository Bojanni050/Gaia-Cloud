'use strict';

/**
 * Self-memory scheduler — decides WHEN Gaia's own-memory pass runs.
 *
 * Running it every turn is both expensive and noisy, so it runs once every
 * `everyTurns` turns, and once when a session ends. gaia-api has no explicit
 * end-of-session signal, so a session end is detected two ways:
 *   - a turn arrives for a DIFFERENT conversationId — the previous session is
 *     over, so it is flushed;
 *   - a conversation goes idle for `idleMs` — it is flushed.
 *
 * A flush hands the recent conversation window to the writer (resolved lazily
 * through `getWriter`, because the model can change at any time via admin)
 * and forgets the conversation. Best-effort throughout: it never throws.
 */

const WINDOW_MESSAGES = 12;

/**
 * @param {{
 *   getWriter?: () => ({ write: Function }|null|undefined),
 *   everyTurns?: number,
 *   idleMs?: number,
 *   setTimer?: Function,
 *   clearTimer?: Function,
 * }} [options]
 */
function createSelfMemoryScheduler({
  getWriter,
  everyTurns = 5,
  idleMs = 5 * 60 * 1000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const every = Number(everyTurns) > 0 ? Number(everyTurns) : 5;
  const conversations = new Map(); // id -> { count, window, logger, timer }

  function clearEntryTimer(entry) {
    if (entry && entry.timer) {
      try { clearTimer(entry.timer); } catch (_) { /* already gone */ }
      entry.timer = null;
    }
  }

  /** Resolve the writer lazily — the provider role can change via admin. */
  function resolveWriter() {
    try {
      const writer = getWriter && getWriter();
      return writer && typeof writer.write === 'function' ? writer : null;
    } catch (_) {
      return null;
    }
  }

  async function flush(id) {
    const entry = conversations.get(id);
    if (!entry) return { written: 0, skipped: 'no-session' };
    clearEntryTimer(entry);
    conversations.delete(id);
    if (!Array.isArray(entry.window) || entry.window.length === 0) return { written: 0, skipped: 'empty' };
    const writer = resolveWriter();
    if (!writer) return { written: 0, skipped: 'no-writer' };
    try {
      return await writer.write({ messages: entry.window, logger: entry.logger });
    } catch (_) {
      return { written: 0, skipped: 'failed' };
    }
  }

  function armIdle(id, entry) {
    clearEntryTimer(entry);
    if (!(idleMs > 0)) return;
    entry.timer = setTimer(() => { void flush(id); }, idleMs);
    // Never keep the process alive just for an idle flush.
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  /**
   * Record one turn. Flushes a previous conversation when the active one
   * changes, arms the idle timer, and runs the pass every `everyTurns` turns.
   * @param {{ conversationId?: string, messages?: Array, logger?: Function }} [turn]
   * @returns {Promise<object>} the flush outcome when it ran, else a calm no-op
   */
  async function noteTurn({ conversationId, messages, logger } = {}) {
    const id = conversationId || '__default__';
    // A different conversation is now active → the previous session ended.
    for (const other of [...conversations.keys()]) {
      if (other !== id) await flush(other);
    }
    const entry = conversations.get(id) || { count: 0, window: [], logger: null, timer: null };
    entry.count += 1;
    entry.logger = logger || entry.logger;
    entry.window = (Array.isArray(messages) ? messages : []).slice(-WINDOW_MESSAGES);
    conversations.set(id, entry);
    armIdle(id, entry);
    if (entry.count % every === 0) return flush(id);
    return { written: 0, skipped: 'not-yet' };
  }

  async function flushAll() {
    for (const id of [...conversations.keys()]) await flush(id);
  }

  return { noteTurn, flush, flushAll, size: () => conversations.size, everyTurns: every, idleMs };
}

module.exports = { createSelfMemoryScheduler, WINDOW_MESSAGES };
