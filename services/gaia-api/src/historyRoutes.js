'use strict';

/**
 * Chat history API — list, read, delete, and export saved conversation
 * transcripts (conversationStore.js). Reached by Desktop through the
 * existing generic `server_request` Rust command (plain JSON, unlike the
 * library's file bytes) — no new Rust command needed for this one.
 *
 * Routes (mounted under /conversations, all Bearer-auth required):
 *   GET    /conversations                  -> { conversations: [...meta] }
 *   GET    /conversations/events           -> text/event-stream, pushed on every change
 *   GET    /conversations/:id              -> { meta, messages }
 *   GET    /conversations/:id/export/:format -> file download (json or markdown)
 *   DELETE /conversations/:id              -> 204
 *
 * Writing happens elsewhere (server.js's /conversation/turn handler and
 * turn.js's performStreamingTurn) as a fire-and-forget side effect of a
 * successful turn — this router is read/delete only, on purpose,
 * mirroring libraryRoutes.js's shape but without an upload endpoint,
 * since a transcript is never something a client constructs and sends
 * whole.
 *
 * /conversations/events exists so a client's sidebar list can stay in
 * sync with what another client (desktop vs. web) just saved, without
 * polling. It's deliberately a list-changed ping, not a diff or the list
 * itself embedded in the event — the client re-fetches GET /conversations
 * on each ping, so this can never drift out of sync with what a plain GET
 * would return.
 *
 * /conversations/:id/export/:format provides chat export in two formats:
 *   - json:      Raw JSON with meta and messages (for import/backup)
 *   - markdown:  Human-readable Markdown (for sharing/reading)
 */
const express = require('express');
const { ConversationNotFoundError, InvalidConversationIdError } = require('./conversationStore');

/**
 * @param {{
 *   store: ReturnType<import('./conversationStore').createConversationStore>,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function createHistoryRouter({ store, auth }) {
  const router = express.Router();

  router.get('/', auth, (req, res) => {
    res.json({ conversations: store.listConversations() });
  });

  // Must be registered before '/:id' — otherwise express would match
  // "events" as an id and route here into the wrong handler.
  router.get('/events', auth, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // belt-and-suspenders alongside nginx.conf.template's proxy_buffering off
    });
    res.write(':ok\n\n');

    const onChanged = () => res.write('event: changed\ndata: {}\n\n');
    store.events.on('changed', onChanged);

    // Keeps the connection alive through any idle-timing proxy between
    // here and the client, and lets the client detect a dead connection
    // instead of hanging silently forever.
    const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      store.events.off('changed', onChanged);
    });
  });

  router.get('/:id', auth, (req, res) => {
    try {
      const { meta, messages } = store.getConversation(req.params.id);
      res.json({ meta, messages });
    } catch (err) {
      if (err instanceof ConversationNotFoundError || err instanceof InvalidConversationIdError) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      res.status(500).json({ error: 'could not read conversation' });
    }
  });

  router.get('/:id/export/:format', auth, (req, res) => {
    try {
      const { meta, messages } = store.getConversation(req.params.id);
      const format = req.params.format;

      if (format === 'json') {
        const exportData = {
          exportedAt: new Date().toISOString(),
          conversation: { meta, messages },
        };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="gaia-chat-${meta.id}.json"`);
        return res.json(exportData);
      }

      if (format === 'markdown') {
        const lines = [];
        lines.push(`# ${meta.title || 'Gaia Chat'}`);
        lines.push('');
        lines.push(`*Exported on ${new Date().toLocaleDateString('nl-NL')} at ${new Date().toLocaleTimeString('nl-NL')}*`);
        lines.push('');
        lines.push('---');
        lines.push('');

        for (const msg of messages) {
          const role = msg.role === 'user' ? '**You**' : '**Gaia**';
          lines.push(`${role}:`);
          lines.push('');
          lines.push(msg.content);
          lines.push('');
          lines.push('---');
          lines.push('');
        }

        const markdown = lines.join('\n');
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="gaia-chat-${meta.id}.md"`);
        return res.send(markdown);
      }

      return res.status(400).json({ error: 'format must be "json" or "markdown"' });
    } catch (err) {
      if (err instanceof ConversationNotFoundError || err instanceof InvalidConversationIdError) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      res.status(500).json({ error: 'could not export conversation' });
    }
  });

  router.delete('/:id', auth, (req, res) => {
    try {
      store.deleteConversation(req.params.id);
      res.status(204).end();
    } catch (err) {
      if (err instanceof ConversationNotFoundError || err instanceof InvalidConversationIdError) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      res.status(500).json({ error: 'could not delete conversation' });
    }
  });

  return router;
}

module.exports = { createHistoryRouter };
