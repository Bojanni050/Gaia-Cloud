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
 *   GET    /conversations/search?q=&limit= -> { results: [...] } literal-text search over saved transcripts
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
 * The date and time a turn was said, for the human-readable export, or ''
 * when the stored message predates per-turn timestamps. Local formatting is
 * deliberate — the markdown is read, not parsed — and matches the header's
 * own nl-NL date/time style.
 */
function formatTurnTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * @param {{
 *   store: ReturnType<import('./conversationStore').createConversationStore>,
 *   auth: import('express').RequestHandler,
 *   search?: { search: (query: string, options?: object) => Array<object> } | null,
 * }} deps
 */
function createHistoryRouter({ store, auth, search } = {}) {
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

    // A write to a client that has just gone must not throw out of a store
    // event or a timer: the close handler below does the cleaning up.
    const write = (chunk) => {
      try {
        if (!res.writableEnded) res.write(chunk);
      } catch (_) { /* client vanished */ }
    };

    const onChanged = () => write('event: changed\ndata: {}\n\n');
    store.events.on('changed', onChanged);

    // Keeps the connection alive through any idle-timing proxy between
    // here and the client, and lets the client detect a dead connection
    // instead of hanging silently forever.
    const heartbeat = setInterval(() => write(':heartbeat\n\n'), 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      store.events.off('changed', onChanged);
    });
  });

  // Literal-text search over the saved transcripts (conversationSearch.js) —
  // "what did we actually say about X". Must be registered before '/:id', so
  // "search" is not read as an id. Absent wiring answers 503 rather than
  // pretending there are no matches.
  router.get('/search', auth, (req, res) => {
    if (!search || typeof search.search !== 'function') {
      return res.status(503).json({ error: 'conversation search is not available' });
    }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      return res.status(400).json({ error: 'q is required' });
    }
    const limit = Number(req.query.limit);
    try {
      res.json({ results: search.search(query, { limit: Number.isFinite(limit) ? limit : undefined }) });
    } catch (_) {
      res.status(503).json({ error: 'conversation search is not available' });
    }
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
          const when = formatTurnTime(msg.createdAt);
          lines.push(when ? `${role} · ${when}` : role);
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
