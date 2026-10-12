'use strict';

/**
 * Durable store for Eleos's open loops — the moments Gaia intends to come back
 * to.
 *
 * Why durable: the whole point is that the check-in happens LATER (around a
 * day), independent of the turn that noticed the moment. A loop that vanished
 * on a restart would lose exactly what Eleos exists for, so the loops live on
 * disk next to the other stores.
 *
 * Layout: one JSON file (`<intentsDir>/eleos-intents.json`) holding a bounded
 * array, newest last. Rewritten atomically-ish on every change (write to
 * `.tmp`, then rename) — a single small file, not a log, because a loop's
 * status transitions matter and JSONL would need replay logic for the same
 * answer. Same shape as researchJobStore.js.
 *
 * A loop is:
 *   { id, conversationId, kind, summary, groundingQuote,
 *     createdAt, dueAt, status, deliveredAt, deliveredConversationId,
 *     acknowledgedAt }
 * status: 'pending' → 'delivered' | 'cancelled'
 *   - pending     : understood, waiting for its moment to come back to it
 *   - delivered   : Gaia wrote the opening into a NEW conversation; a client
 *                   has not necessarily seen it yet (acknowledgedAt)
 *   - cancelled   : dropped before delivery (the moment resolved, or Eleos
 *                   decided against it after all)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LOOPS = 200;

function resolveIntentsDir(env = process.env) {
  if (env.GAIA_ELEOS_INTENTS_PATH) return env.GAIA_ELEOS_INTENTS_PATH;
  const devPath = path.resolve(__dirname, '../data/eleos-intents');
  const containerPath = '/app/data/eleos-intents';
  return fs.existsSync('/app') ? containerPath : devPath;
}

/**
 * @param {{ intentsDir?: string, now?: () => Date }} [options]
 */
function createEleosIntentStore(options = {}) {
  const intentsDir = options.intentsDir || resolveIntentsDir();
  const now = options.now || (() => new Date());
  const filePath = path.join(intentsDir, 'eleos-intents.json');

  function readAll() {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      // Missing or unreadable store: no loops, never a thrown error — a store
      // must not be able to break a turn or a poll.
      return [];
    }
  }

  function writeAll(loops) {
    const trimmed = loops.slice(-MAX_LOOPS);
    fs.mkdirSync(intentsDir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
    return trimmed;
  }

  /**
   * @param {{ conversationId: string, kind?: string, summary: string, groundingQuote?: string, dueAt: string }} input
   * @returns {object} the created loop
   */
  function create({ conversationId, kind = 'other', summary, groundingQuote = '', dueAt }) {
    const timestamp = now().toISOString();
    const loop = {
      id: `el_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      conversationId: conversationId || null,
      kind,
      summary: String(summary || ''),
      groundingQuote: String(groundingQuote || ''),
      createdAt: timestamp,
      dueAt: dueAt || timestamp,
      status: 'pending',
      deliveredAt: null,
      deliveredConversationId: null,
      acknowledgedAt: null,
    };
    writeAll([...readAll(), loop]);
    return loop;
  }

  /** @returns {object|null} */
  function get(id) {
    return readAll().find((loop) => loop.id === id) || null;
  }

  /** @returns {Array<object>} newest last */
  function list() {
    return readAll();
  }

  /** @returns {Array<object>} loops not yet delivered or cancelled */
  function listPending() {
    return readAll().filter((loop) => loop.status === 'pending');
  }

  /** @returns {object|null} the pending loop for a conversation, if any */
  function pendingForConversation(conversationId) {
    return readAll().find((loop) => loop.status === 'pending' && loop.conversationId === conversationId) || null;
  }

  /** @returns {Array<object>} pending loops whose moment has arrived */
  function listDue(at = now()) {
    const t = at instanceof Date ? at : new Date(at);
    return readAll().filter((loop) => loop.status === 'pending' && new Date(loop.dueAt).getTime() <= t.getTime());
  }

  /** @returns {Array<object>} delivered loops a client has not acknowledged */
  function listUndelivered() {
    return readAll().filter((loop) => loop.status === 'delivered' && !loop.acknowledgedAt);
  }

  /** Count of loops DELIVERED at or after `since` (for the per-day cap). */
  function countDeliveredSince(since) {
    const t = since instanceof Date ? since : new Date(since);
    return readAll().filter(
      (loop) => loop.status === 'delivered' && loop.deliveredAt && new Date(loop.deliveredAt).getTime() >= t.getTime()
    ).length;
  }

  /** @returns {object|null} the updated loop */
  function update(id, patch) {
    const loops = readAll();
    const index = loops.findIndex((loop) => loop.id === id);
    if (index === -1) return null;
    const updated = { ...loops[index], ...patch };
    loops[index] = updated;
    writeAll(loops);
    return updated;
  }

  /** Mark a loop as written into a conversation. @returns {object|null} */
  function markDelivered(id, { deliveredConversationId = null, at } = {}) {
    return update(id, {
      status: 'delivered',
      deliveredAt: (at instanceof Date ? at : now()).toISOString(),
      deliveredConversationId,
    });
  }

  /** Drop a pending loop before delivery. @returns {object|null} */
  function cancel(id) {
    const loop = get(id);
    if (!loop || loop.status !== 'pending') return loop;
    return update(id, { status: 'cancelled' });
  }

  /** The client has seen a delivered loop. @returns {object|null} */
  function markAcknowledged(id) {
    const loop = get(id);
    if (!loop) return null;
    return update(id, { acknowledgedAt: now().toISOString() });
  }

  return {
    create, get, list, listPending, pendingForConversation, listDue,
    listUndelivered, countDeliveredSince, update, markDelivered, cancel,
    markAcknowledged, intentsDir,
  };
}

module.exports = { createEleosIntentStore, resolveIntentsDir, MAX_LOOPS };
