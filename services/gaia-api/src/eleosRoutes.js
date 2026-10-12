'use strict';

/**
 * The poll endpoint for Eleos check-ins — how a client learns that Gaia has
 * started a conversation the person did not ask for.
 *
 * Same posture as researchRoutes.js: deliberately a plain poll, not a
 * streaming channel, because the whole point is that it survives a closed
 * window, a backgrounded app, or a reconnect — the check-in is written into a
 * NEW conversation (src/eleosRuntime.js), so the message itself lives there
 * and this route only carries metadata.
 *
 * Routes (mounted under /eleos, Bearer-auth required):
 *   GET  /eleos/checkins          -> { pending: [...], delivered: [...] }
 *        `pending`   : a moment Gaia is still going to come back to.
 *        `delivered` : a check-in already written into a new conversation that
 *                      this client has not acknowledged yet — the client opens
 *                      `deliveredConversationId` and then acks it, one result
 *                      seen once.
 *   POST /eleos/checkins/:id/ack  -> mark a delivered check-in as seen (204)
 *
 * The check-in text is never returned here — it is an ordinary assistant
 * message in the conversation, so a client renders it with the rest of the
 * transcript instead of inventing a second place for it.
 */

const express = require('express');

/**
 * The client-facing view of one loop — metadata only.
 * @param {object} loop
 * @returns {object}
 */
function checkinView(loop) {
  return {
    id: loop.id,
    conversationId: loop.conversationId,
    deliveredConversationId: loop.deliveredConversationId || null,
    kind: loop.kind,
    summary: loop.summary,
    status: loop.status,
    createdAt: loop.createdAt,
    dueAt: loop.dueAt,
    deliveredAt: loop.deliveredAt || null,
  };
}

/**
 * @param {{ store: object, auth: import('express').RequestHandler }} deps
 */
function createEleosRouter({ store, auth }) {
  const router = express.Router();

  router.get('/checkins', auth, (req, res) => {
    try {
      res.json({
        pending: store.listPending().map(checkinView),
        delivered: store.listUndelivered().map(checkinView),
      });
    } catch (_) {
      // A poll must never look like a crash with no explanation.
      res.status(503).json({ error: 'check-ins unavailable' });
    }
  });

  router.post('/checkins/:id/ack', auth, (req, res) => {
    try {
      const loop = store.get(req.params.id);
      if (!loop) return res.status(404).json({ error: 'unknown check-in' });
      store.markAcknowledged(req.params.id);
      return res.status(204).end();
    } catch (_) {
      return res.status(503).json({ error: 'check-ins unavailable' });
    }
  });

  return router;
}

module.exports = { createEleosRouter, checkinView };
