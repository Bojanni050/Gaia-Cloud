'use strict';

const express = require('express');

/**
 * GaiaChat review surface — the human-in-the-loop Absolute Override.
 *
 * Operator-agnostic and part of the client contract (Bearer auth, never
 * /admin): the GaiaChat client lists the derived statements Logos is still
 * weighing and the human moves one forward or lets it go.
 *
 *   GET  /cognition/hypotheses                 pending/testing statements
 *   POST /cognition/hypotheses/:id/test        open active testing
 *   POST /cognition/hypotheses/:id/reject      { reason }  (verwerp_bron "mens")
 *   POST /cognition/hypotheses/:id/reopen      { reason }  — the human lift of a rejection
 *   POST /cognition/hypotheses/:id/confirm     { supersedes?: [ids], rationale?, statement? }
 *
 * `confirm` is the ONLY path to `confirmed` (Absolute Override). It updates
 * Cognition, mirrors the record to Hindsight (cognitionSync emits
 * gaia:confirmed_fact), and performs active supersession: every id the caller
 * names in `supersedes` is marked rejected with verwerp_bron 'consolidatie' and
 * a pointer to the confirmed statement.
 *
 * Cognition owns the lifecycle; this router only carries the human's verdict.
 */

const REVIEW_STATUSES = Object.freeze(['proposed', 'testing', 'corroborated']);

// A relationship is persisted (cognitionKnowledgeAdapter.renderRelationship) as
// `kind:ref type kind:ref`, where a ref is an id when the endpoint had one and
// its own text otherwise. An id ("hypothesis:hyp-1") tells the human nothing, so
// when listing we swap a `hypothesis:<id>` endpoint for that hypothesis's
// statement — the readable thing the human is actually being asked to judge.
// Unresolved references stay as the bare id rather than a broken half.
const RELATIONSHIP_KINDS = 'evidence|observation|hypothesis|pattern';
const RELATIONSHIP_TYPES = 'supports|weakens|contradicts|irrelevant|relates_to';
const RELATIONSHIP_RE = new RegExp(
  `^(${RELATIONSHIP_KINDS}):([\\s\\S]+?) (${RELATIONSHIP_TYPES}) (${RELATIONSHIP_KINDS}):([\\s\\S]+)$`
);

/** A bare token (no whitespace) reads as an id; anything else is already text. */
function looksLikeId(ref) {
  return typeof ref === 'string' && ref.length > 0 && !/\s/.test(ref);
}

async function resolveRelationshipStatement(statement, getHypothesis, cache) {
  const match = RELATIONSHIP_RE.exec(String(statement || ''));
  if (!match) return statement;
  const [, fromKind, fromRef, type, toKind, toRef] = match;
  const resolve = async (kind, ref) => {
    if (kind !== 'hypothesis' || !looksLikeId(ref) || typeof getHypothesis !== 'function') return ref;
    if (cache.has(ref)) return cache.get(ref);
    let text = ref;
    try {
      const found = await getHypothesis(ref);
      if (found && typeof found.statement === 'string' && found.statement.trim()) {
        text = found.statement.trim();
      }
    } catch (_) { /* an unresolved reference keeps its bare id */ }
    cache.set(ref, text);
    return text;
  };
  const [from, to] = await Promise.all([resolve(fromKind, fromRef), resolve(toKind, toRef)]);
  return `${fromKind}:${from} ${type} ${toKind}:${to}`;
}

/** Expands every relationship record's id endpoints into their statements. */
async function expandRelationships(records, cognition) {
  if (!Array.isArray(records) || records.length === 0) return records;
  const cache = new Map();
  const getHypothesis = cognition && typeof cognition.getHypothesis === 'function'
    ? cognition.getHypothesis.bind(cognition)
    : null;
  return Promise.all(records.map(async (record) => {
    if (!record || record.kind !== 'relationship' || typeof record.statement !== 'string') return record;
    const statement = await resolveRelationshipStatement(record.statement, getHypothesis, cache);
    return statement === record.statement ? record : { ...record, statement };
  }));
}

function createCognitionRouter({ cognition, sync, auth } = {}) {
  if (!cognition) throw new Error('cognitionRoutes requires a cognition client');
  const router = express.Router();
  if (auth) router.use(auth);

  const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  async function mirror(record) {
    if (!sync || !record) return;
    try { await sync.syncHypothesis(record); } catch (_) { /* mirroring never fails a request */ }
  }

  router.get('/hypotheses', asyncRoute(async (req, res) => {
    const { status } = req.query;
    const list = await cognition.listHypotheses(status ? { status } : {});
    const expanded = await expandRelationships(Array.isArray(list) ? list : [], cognition);
    res.json({ hypotheses: expanded });
  }));

  router.post('/hypotheses/:id/test', asyncRoute(async (req, res) => {
    const record = await cognition.markTesting(req.params.id);
    await mirror(record);
    res.json(record);
  }));

  router.post('/hypotheses/:id/reject', asyncRoute(async (req, res) => {
    const record = await cognition.rejectHypothesis(req.params.id, {
      reason: req.body && req.body.reason,
      verwerpBron: 'mens',
    });
    await mirror(record);
    res.json(record);
  }));

  // The human reopen — the ONLY way out of the rejected quarantine. `rejected`
  // is terminal for every automatic path (manager and store); this is the one
  // explicit, human-initiated exception, and it must state why.
  router.post('/hypotheses/:id/reopen', asyncRoute(async (req, res) => {
    const reason = (req.body && req.body.reason) || '';
    if (!String(reason).trim()) {
      return res.status(400).json({ error: 'a reason is required to reopen a rejected statement' });
    }
    const record = await cognition.reopenHypothesis(req.params.id, { reason });
    await mirror(record);
    res.json(record);
  }));

  router.post('/hypotheses/:id/confirm', asyncRoute(async (req, res) => {
    const id = req.params.id;
    const rationale = (req.body && req.body.rationale) || '';
    const statement = req.body && req.body.statement;

    // V3 structural friction, server-side: a macro statement (the safe
    // default) may only be confirmed with a stated rationale — the API
    // refuses a bare click even if a client forgot the UI step. A micro
    // statement may be confirmed without one.
    const existing = typeof cognition.getHypothesis === 'function'
      ? await cognition.getHypothesis(id).catch(() => null)
      : null;
    const isMacro = !existing || existing.scope !== 'micro';
    if (isMacro && !String(rationale).trim()) {
      return res.status(400).json({ error: 'a rationale is required to confirm a macro statement' });
    }

    const confirmed = await cognition.confirmHypothesis(id, { statement });
    await mirror(confirmed);

    const toSupersede = Array.isArray(req.body && req.body.supersedes) ? req.body.supersedes : [];
    const superseded = [];
    for (const oldId of toSupersede) {
      if (!oldId || String(oldId) === String(id)) continue;
      try {
        const record = await cognition.supersedeHypothesis(oldId, {
          supersededById: id,
          reason: (req.body && req.body.rationale) || 'superseded by a newer confirmed statement',
        });
        await mirror(record);
        superseded.push(oldId);
      } catch (_) {
        // Failing to supersede one old statement never blocks the confirm.
      }
    }
    res.json({ hypothesis: confirmed, superseded });
  }));

  return router;
}

module.exports = { createCognitionRouter, REVIEW_STATUSES };
