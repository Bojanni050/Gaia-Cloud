/**
 * Kairos episode routes. Storage-only, like every other record in this
 * service: `POST /` is written by the Kairos worker in gaia-api (never by a
 * client), `GET /` is the read seam the same worker/client surface uses.
 *
 *   POST /v1/banks/:bankId/episodes            -> create/upsert one episode
 *   GET  /v1/banks/:bankId/episodes            -> { data, pagination } (?page=&limit=&since=)
 *   GET  /v1/banks/:bankId/episodes/:id        -> one episode
 *
 * The worker watermark lives on its own path (the client never touches it):
 *
 *   GET  /v1/banks/:bankId/episodes/state      -> { last_captured_at } | null
 *   PUT  /v1/banks/:bankId/episodes/state      -> { last_captured_at }
 */
const express = require('express');
const kairos = require('../kairosEpisodes');

const router = express.Router({ mergeParams: true });

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// Registered before '/:id' so "state" is never captured as an episode id.
router.get('/state', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const lastCapturedAt = await kairos.getState(bankId);
  res.json({ last_captured_at: lastCapturedAt });
}));

router.put('/state', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const row = await kairos.setState(bankId, req.body.last_captured_at);
  res.json({ last_captured_at: row.last_captured_at });
}));

router.post('/', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const episode = await kairos.create(bankId, {
    id: req.body.id,
    startTime: req.body.start_time,
    endTime: req.body.end_time,
    summary: req.body.summary,
    primaryApp: req.body.primary_app,
    involvedApps: req.body.involved_apps,
    sources: req.body.sources,
  });
  res.status(201).json(episode);
}));

router.get('/', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const result = await kairos.list(bankId, {
    page: req.query.page,
    limit: req.query.limit,
    since: req.query.since,
  });
  res.json(result);
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await kairos.get(bankId, id));
}));

module.exports = router;
