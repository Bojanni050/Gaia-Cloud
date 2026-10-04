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
    persistence: req.body.persistence,
    method: req.body.method,
    sources: req.body.sources,
    kind: req.body.kind,
    supersedesId: req.body.supersedes_id,
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
    persistence: req.body.persistence,
    method: req.body.method,
    sources: req.body.sources,
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

// Human Absolute Override — the only path to Confirmed.
router.post('/:id/confirm', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.confirm(bankId, id));
}));

router.post('/:id/reject', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await hypotheses.reject(bankId, id, req.body.reason, req.body.verwerp_bron));
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
