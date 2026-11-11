/**
 * Kairos day-digest routes. Storage-only, like routes/episodes.js: `POST /` is
 * written by the digest writer in gaia-api (never by a client), `GET /` is the
 * read seam the client surface and the Command Center use.
 *
 *   POST /v1/banks/:bankId/digests           -> create/upsert one day overview
 *   GET  /v1/banks/:bankId/digests           -> { data } (?limit=)
 *   GET  /v1/banks/:bankId/digests/:date     -> one overview (YYYY-MM-DD)
 */
const express = require('express');
const digests = require('../kairosDigests');

const router = express.Router({ mergeParams: true });

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

router.post('/', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const record = await digests.upsert(bankId, {
    date: req.body.digest_date,
    timezone: req.body.timezone,
    title: req.body.title,
    summary: req.body.summary,
    episodeIds: req.body.episode_ids,
    apps: req.body.apps,
    model: req.body.model,
  });
  res.status(201).json(record);
}));

router.get('/', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  res.json(await digests.list(bankId, { limit: req.query.limit }));
}));

router.get('/:date', asyncRoute(async (req, res) => {
  const { bankId, date } = req.params;
  res.json(await digests.get(bankId, date));
}));

module.exports = router;
