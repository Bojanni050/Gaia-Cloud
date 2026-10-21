const express = require('express');
const hypotheses = require('../hypotheses');

const router = express.Router({ mergeParams: true });

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

router.post('/', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const h = await hypotheses.propose(bankId, {
    statement: req.body.statement,
    confidence: req.body.confidence,
    verificationPlan: req.body.verification_plan,
    evidenceMemoryIds: req.body.evidence_memory_ids,
    evidenceFor: req.body.evidence_for,
    evidenceAgainst: req.body.evidence_against,
    evidenceItems: req.body.evidence_items,
    persistence: req.body.persistence,
    method: req.body.method,
    sources: req.body.sources,
    kind: req.body.kind,
    supersedesId: req.body.supersedes_id,
    counterHypothesis: req.body.counter_hypothesis,
    scope: req.body.scope,
    questionShape: req.body.question_shape,
    questionOptions: req.body.question_options,
  });
  res.status(201).json(h);
}));

router.get('/', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const list = await hypotheses.list(bankId, { status: req.query.status, kind: req.query.kind });
  res.json({ hypotheses: list });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.get(bankId, id));
}));

router.patch('/:id', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  const h = await hypotheses.update(bankId, id, {
    statement: req.body.statement,
    confidence: req.body.confidence,
    verificationPlan: req.body.verification_plan,
    evidenceMemoryIds: req.body.evidence_memory_ids,
    evidenceFor: req.body.evidence_for,
    evidenceAgainst: req.body.evidence_against,
    evidenceItems: req.body.evidence_items,
    persistence: req.body.persistence,
    method: req.body.method,
    sources: req.body.sources,
    counterHypothesis: req.body.counter_hypothesis,
    scope: req.body.scope,
  });
  res.json(h);
}));

router.post('/:id/test', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.markTesting(bankId, id));
}));

// Lifecycle owner: Logos supplies one evidence verdict; Cognition applies it
// and books the transition (proposed -> testing, confirmed -> testing).
router.post('/:id/evidence', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  const h = await hypotheses.applyEvidence(bankId, id, {
    relation: req.body.relation,
    evidenceId: req.body.evidence_id,
    evidenceItem: req.body.evidence_item,
    confidenceDelta: req.body.confidence_delta,
    rationale: req.body.rationale,
  });
  res.json(h);
}));

// Machine soft-promotion (C >= 0.80) — never Confirmed.
router.post('/:id/corroborate', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.markCorroborated(bankId, id));
}));

// Gaia raised this open question herself — a stamp (count + moment), never a
// status change: the person still answers it, or it simply keeps waiting.
router.post('/:id/raise', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.raise(bankId, id));
}));

// Machine expiry (v1.3) — a statement that never gathered evidence and was
// never touched again lapses with reason `verlopen`. Not a rejection, and not
// terminal: evidence that arrives later revives it through /revive.
router.post('/:id/expire', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.expire(bankId, id));
}));

// The way back from a lapse — `expired` → `testing`.
router.post('/:id/revive', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.revive(bankId, id));
}));

// Human Absolute Override — the only path to Confirmed.
router.post('/:id/confirm', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.confirm(bankId, id, { statement: req.body.statement }));
}));

router.post('/:id/reject', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.reject(bankId, id, req.body.reason, req.body.verwerp_bron));
}));

// Human reopen — the only way out of the rejected quarantine; reason required.
router.post('/:id/reopen', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.reopen(bankId, id, { reason: req.body.reason }));
}));

// A human correction — the person says what is true instead. Not a lifecycle
// move (see hypotheses.js's correct()): the record keeps (or takes) confirmed,
// and the mirror retires the wording this replaces. Reason required.
router.post('/:id/correct', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  const h = await hypotheses.correct(bankId, id, {
    statement: req.body.statement,
    reason: req.body.reason,
  });
  res.json(h);
}));

// The human's answer to an open question (v1.2) — stored, not a transition.
router.post('/:id/answer', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.answer(bankId, id, { answer: req.body.answer }));
}));

// Consolidation — a newer statement supersedes this one.
router.post('/:id/supersede', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.supersede(bankId, id, {
    supersededById: req.body.superseded_by_id,
    reason: req.body.reason,
  }));
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  await hypotheses.softDelete(bankId, id);
  res.status(204).end();
}));

module.exports = router;
