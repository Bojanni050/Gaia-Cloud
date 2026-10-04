const express = require('express');
const patterns = require('../patterns');

const router = express.Router({ mergeParams: true });

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

router.post('/', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  const p = await patterns.create(bankId, {
    content: req.body.content,
    confidence: req.body.confidence,
    coherenceScore: req.body.coherence_score,
    sourceMemoryIds: req.body.source_memory_ids,
    status: req.body.status,
    hypothesisIds: req.body.hypothesis_ids,
    sources: req.body.sources,
  });
  res.status(201).json(p);
}));

router.get('/', asyncRoute(async (req, res) => {
  const { bankId } = req.params;
  res.json({ patterns: await patterns.list(bankId) });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  res.json(await patterns.get(bankId, id));
}));

router.patch('/:id', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  const p = await patterns.update(bankId, id, {
    content: req.body.content,
    confidence: req.body.confidence,
    coherenceScore: req.body.coherence_score,
    sourceMemoryIds: req.body.source_memory_ids,
    status: req.body.status,
    hypothesisIds: req.body.hypothesis_ids,
    sources: req.body.sources,
  });
  res.json(p);
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const { bankId, id } = req.params;
  await patterns.softDelete(bankId, id);
  res.status(204).end();
}));

module.exports = router;
