'use strict';

/**
 * Kairos client surface (mounted under /kairos, Bearer-auth required) — the
 * ONLY way a client reaches episodes and day digests. Clients never talk to
 * Cognition or Foundation directly; this proxies the read and relays the live
 * stream.
 *
 *   GET  /kairos/episodes                 -> paged derived episodes (from Cognition)
 *   GET  /kairos/episodes/stream          -> text/event-stream (episode + digest events)
 *   GET  /kairos/episodes/:id/evidence    -> the raw observations behind one episode
 *   GET  /kairos/digests                  -> paged day overviews, newest first
 *   GET  /kairos/digest?date=YYYY-MM-DD   -> one overview (default: the latest)
 *   POST /kairos/digest                   -> write one now ({ date, force })
 *
 * The evidence route walks `sources` back to Foundation and returns the raw
 * records (plus any episodes Foundation froze from the same ingest), so the
 * UI can drill from an interpretation to the exact observations it was
 * synthesized from — the auditability guarantee.
 */
const express = require('express');
const { onEpisode, onDigest } = require('./kairos/emitter');
const { ingestObjectId } = require('./foundationRef');
const { isDateString } = require('./kairos/digest');

const HEARTBEAT_MS = 15000;

/**
 * @param {{
 *   cognition: object,
 *   foundation?: object,
 *   auth: import('express').RequestHandler,
 *   digestWriter?: { generate: (opts: { date: string, force?: boolean }) => Promise<object> },
 * }} deps
 */
function createKairosRouter({ cognition, foundation, auth, digestWriter } = {}) {
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

    const unsubscribeEpisode = onEpisode((episode) => {
      try {
        res.write(`event: episode\ndata: ${JSON.stringify(episode)}\n\n`);
      } catch (_) { /* client vanished; the close handler cleans up */ }
    });
    const unsubscribeDigest = onDigest((digest) => {
      try {
        res.write(`event: digest\ndata: ${JSON.stringify(digest)}\n\n`);
      } catch (_) { /* client vanished; the close handler cleans up */ }
    });

    const heartbeat = setInterval(() => {
      try {
        if (!res.writableEnded) res.write(':heartbeat\n\n');
      } catch (_) { /* client vanished; the close handler cleans up */ }
    }, HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeEpisode();
      unsubscribeDigest();
      res.end();
    });
  });

  router.get('/episodes', auth, async (req, res) => {
    try {
      const result = await cognition.listKairosEpisodes({
        page: req.query.page,
        limit: req.query.limit,
        since: req.query.since,
        until: req.query.until,
      });
      res.json(result);
    } catch (err) {
      if (err && err.status === 404) return res.status(404).json({ error: 'bank not found' });
      if (err && err.status === 422) return res.status(400).json({ error: 'invalid query' });
      res.status(500).json({ error: 'could not read episodes' });
    }
  });

  router.get('/digests', auth, async (req, res) => {
    if (typeof cognition.listKairosDigests !== 'function') {
      return res.status(503).json({ error: 'digests unavailable' });
    }
    try {
      const data = await cognition.listKairosDigests({ limit: req.query.limit });
      res.json({ data });
    } catch (err) {
      if (err && err.status === 404) return res.status(404).json({ error: 'bank not found' });
      res.status(500).json({ error: 'could not read digests' });
    }
  });

  router.get('/digest', auth, async (req, res) => {
    if (typeof cognition.listKairosDigests !== 'function') {
      return res.status(503).json({ error: 'digests unavailable' });
    }
    const date = req.query.date;
    if (date !== undefined && !isDateString(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    try {
      if (date !== undefined) {
        const digest = await cognition.getKairosDigest(date);
        return res.json(digest);
      }
      const latest = await cognition.listKairosDigests({ limit: 1 });
      if (!latest || latest.length === 0) return res.status(404).json({ error: 'no digest yet' });
      return res.json(latest[0]);
    } catch (err) {
      if (err && err.status === 404) return res.status(404).json({ error: 'no digest for that day' });
      res.status(500).json({ error: 'could not read digest' });
    }
  });

  // Manual generation: the Command Center's "maak dit overzicht" button, and
  // the way a day is backfilled without waiting for the scheduler.
  router.post('/digest', auth, async (req, res) => {
    if (!digestWriter) return res.status(503).json({ error: 'digest writer unavailable' });
    const date = req.body && req.body.date;
    if (!isDateString(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    try {
      const result = await digestWriter.generate({ date, force: Boolean(req.body && req.body.force) });
      if (result.skipped === 'no-episodes') {
        return res.status(404).json({ error: 'no episodes on that day', date });
      }
      if (result.skipped === 'day-not-closed') {
        return res.status(409).json({ error: 'that day has not closed yet', date });
      }
      return res.json(result.digest);
    } catch (err) {
      if (err && err.message && err.message.startsWith('kairos digest:')) {
        return res.status(502).json({ error: 'could not write the digest' });
      }
      res.status(500).json({ error: 'could not write the digest' });
    }
  });

  router.get('/episodes/:id/evidence', auth, async (req, res) => {
    if (!foundation) return res.status(503).json({ error: 'evidence source unavailable' });
    try {
      const episode = await cognition.getKairosEpisode(req.params.id);
      const sources = Array.isArray(episode.sources) ? episode.sources : [];
      // sources are 'foundation:<uuid>' (Foundation ingest_object ids) — resolve
      // them through the shared seam and fetch each raw ingest object.
      const ids = sources
        .map((s) => ingestObjectId(s))
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
