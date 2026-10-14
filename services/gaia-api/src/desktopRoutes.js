'use strict';

/**
 * The client's side of the desktop confirmation flow (see src/desktopBroker.js
 * and docs/desktop-capability.md). The server announces an action as a
 * `desktop` SSE frame on the open turn; the client answers here.
 *
 * Routes (mounted under /desktop, Bearer-auth required):
 *   POST /desktop/actions/:id/decision  { approved: boolean }        -> 204
 *        The person's answer to an `awaiting_confirmation` action.
 *   POST /desktop/actions/:id/result    { ok: boolean, output: string } -> 204
 *        What running an approved action produced (or why it failed).
 *
 * 404 unknown or long-gone action · 409 wrong state (already answered,
 * expired, or a result for an action that was never approved) · 400 bad body.
 */

const express = require('express');

const STATUS_FOR = { unknown: 404, not_approved: 409, wrong_state: 409 };

/** @param {{ broker: ReturnType<import('./desktopBroker').createDesktopBroker>, auth: import('express').RequestHandler }} deps */
function createDesktopRouter({ broker, auth }) {
  const router = express.Router();

  function reply(res, outcome) {
    if (outcome.ok) return res.status(204).end();
    return res.status(STATUS_FOR[outcome.code] || 409).json({ error: outcome.code });
  }

  router.post('/actions/:id/decision', auth, (req, res) => {
    const approved = req.body && req.body.approved;
    if (typeof approved !== 'boolean') return res.status(400).json({ error: 'approved must be a boolean' });
    return reply(res, broker.decide(req.params.id, approved));
  });

  router.post('/actions/:id/result', auth, (req, res) => {
    const body = req.body || {};
    if (typeof body.ok !== 'boolean') return res.status(400).json({ error: 'ok must be a boolean' });
    if (body.output != null && typeof body.output !== 'string') return res.status(400).json({ error: 'output must be a string' });
    return reply(res, broker.complete(req.params.id, { ok: body.ok, output: body.output }));
  });

  return router;
}

module.exports = { createDesktopRouter };
