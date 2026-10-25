const express = require('express');
const observations = require('../observations');

const router = express.Router({ mergeParams: true });

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// The deferred phase of a turn leaves what it saw here, with the evidence it
// stood on. No lifecycle and no status: an observation is a record of a moment,
// and only a later pass decides whether several moments make a statement.
router.post('/', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const record = await observations.create(bankId, {
    statement: req.body.statement,
    evidenceItems: req.body.evidence_items,
    conversationId: req.body.conversation_id,
    observedAt: req.body.observed_at,
  });
  res.status(201).json(record);
}));

// What the formation pass reads: open observations by default, newest first.
router.get('/', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const list = await observations.list(bankId, {
    consumed: req.query.consumed === 'true',
    limit: req.query.limit,
  });
  res.json({ observations: list });
}));

// Recall-derived ground for an observation: the Hindsight memory-unit ids a
// recall of the statement returned. The formation pass writes this so two
// observations that never shared a sourceRef can still be recognized as the
// same ground. Idempotent and additive — a retried pass adds nothing new.
router.patch('/:id/ground', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  const outcome = await observations.mergeRecallGround(bankId, id, req.body.recall_ground);
  res.json(outcome);
}));

// Which statement an observation fed. Idempotent, so a retried pass cannot take
// an observation away from the belief that already rests on it.
router.post('/consumed', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const outcome = await observations.markConsumed(bankId, req.body.ids, req.body.hypothesis_id);
  res.json(outcome);
}));

module.exports = router;
