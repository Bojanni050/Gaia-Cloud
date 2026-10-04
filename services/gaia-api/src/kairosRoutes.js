'use strict';

/**
 * Kairos client surface (mounted under /kairos, Bearer-auth required) — the
 * ONLY way a client reaches episodes. Clients never talk to Cognition or
 * Foundation directly; this proxies the read and relays the live stream.
 *
 *   GET /kairos/episodes                 -> paged derived episodes (from Cognition)
 *   GET /kairos/episodes/stream          -> text/event-stream, pushed on synthesis
 *   GET /kairos/episodes/:id/evidence    -> the raw observations behind one episode
 *
 * The evidence route walks `sources` back to Foundation and returns the raw
 * records (plus any episodes Foundation froze from the same ingest), so the
 * UI can drill from an interpretation to the exact observations it was
 * synthesized from — the auditability guarantee.
 */
const express = require('express');
const { onEpisode } = require('./kairos/emitter');

const HEARTBEAT_MS = 15000;

/**
 * @param {{
 *   cognition: object,
 *   foundation?: object,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function createKairosRouter({ cognition, foundation, auth }) {
  if (!cognition) throw new Error('kairosRoutes requires a cognition client');
  const router = express.Router();

  // Must precede '/:id' so "episodes/stream" is not read as an id.
  router.get('/episodes/stream', auth, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');

    const unsubscribe = onEpisode((episode) => {
      try {
        res.write(`event: episode\ndata: ${JSON.stringify(episode)}\n\n`);
      } catch (_) { /* client vanished; the close handler cleans up */ }
    });

    const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  router.get('/episodes', auth, async (req, res) => {
    try {
      const result = await cognition.listKairosEpisodes({
        page: req.query.page,
        limit: req.query.limit,
        since: req.query.since,
      });
      res.json(result);
    } catch (err) {
      if (err && err.status === 404) return res.status(404).json({ error: 'bank not found' });
      if (err && err.status === 422) return res.status(400).json({ error: 'invalid query' });
      res.status(500).json({ error: 'could not read episodes' });
    }
  });

  router.get('/episodes/:id/evidence', auth, async (req, res) => {
    if (!foundation) return res.status(503).json({ error: 'evidence source unavailable' });
    try {
      const episode = await cognition.getKairosEpisode(req.params.id);
      const sources = Array.isArray(episode.sources) ? episode.sources : [];
      // sources are 'chronicle:<ingest_object-id>' — strip the namespace and
      // fetch each raw ingest object (Foundation owns the raws).
      const ids = sources
        .map((s) => String(s).replace(/^chronicle:/, ''))
        .filter(Boolean);
      const observations = foundation.fetchIngestObjects
        ? await foundation.fetchIngestObjects(ids)
        : [];
      res.json({ episode, observations });
    } catch (err) {
      if (err && err.status === 404) return res.status(404).json({ error: 'episode not found' });
      res.status(500).json({ error: 'could not read evidence' });
    }
  });

  return router;
}

module.exports = { createKairosRouter };
