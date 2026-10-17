'use strict';

const express = require('express');
const { recognizeQuestionShape } = require('./logos/questionShape');
const { createReviewRound } = require('./reviewRound');

/**
 * GaiaChat review surface — the human-in-the-loop Absolute Override.
 *
 * Operator-agnostic and part of the client contract (Bearer auth, never
 * /admin): the GaiaChat client lists the derived statements Logos is still
 * weighing and the human moves one forward or lets it go.
 *
 *   GET  /cognition/hypotheses                 pending/testing statements, each under
 *                                              review marked `review_eligible` / `in_round`
 *                                              (reviewRound.js — the criterion and the batch)
 *   POST /cognition/hypotheses/:id/test        open active testing
 *   POST /cognition/hypotheses/:id/reject      { reason }  (verwerp_bron "mens")
 *   POST /cognition/hypotheses/:id/reopen      { reason }  — the human lift of a rejection
 *   POST /cognition/hypotheses/:id/correct     { statement, reason, supersedes?: [ids] }
 *                                              — the person's own wording for a settled statement
 *   POST /cognition/hypotheses/:id/confirm     { supersedes?: [ids], rationale?, statement? }
 *   POST /cognition/hypotheses/:id/answer      { answer }  — the human's answer to an open question
 *
 * `confirm` is the ONLY path to `confirmed` (Absolute Override). It updates
 * Cognition, mirrors the record to Hindsight (cognitionSync emits
 * gaia:confirmed_fact), and performs active supersession: every id the caller
 * names in `supersedes` is marked rejected with verwerp_bron 'consolidatie' and
 * a pointer to the confirmed statement.
 *
 * `correct` is the human's own wording where a statement is already settled —
 * the route that closes the gap update() and confirm() leave open (a confirmed
 * statement cannot be edited, and a hand correction in Hindsight gets
 * re-mirrored over). The record keeps its id and its settled state, and the
 * mirror retires the text it replaces, so the correction is durable.
 *
 * An open question is not confirmed but ANSWERED: the human supplies the fact
 * the question was missing, and the question drops off the list. Its
 * `question_shape` tells the client which control to offer — the Ja/Nee pair,
 * free text, or one button per option — so an "openen/inhouden" question is
 * never answered with a yes/no that means nothing.
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

/**
 * The review list: what still waits on the human. Two adjustments here.
 *
 * An answered open question has been dealt with, so it leaves the list. The
 * record keeps its answer and stays in Cognition; only the review surface stops
 * showing it. (Confirmed and rejected statements stay: the card renders the
 * rejected state, and the drawer is where the person sees their own history.)
 *
 * An open question written before the shape existed (v1.2) has none, so the
 * shape is read off the statement — the same recognizer the validator uses —
 * and sent along. A shape the model supplied itself is never overwritten.
 */
function reviewableQuestions(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => !(record && record.kind === 'open_question' && record.answered_at))
    .map((record) => {
      if (!record || record.kind !== 'open_question' || record.question_shape) return record;
      const { shape, options } = recognizeQuestionShape(record.statement);
      return { ...record, question_shape: shape, question_options: options };
    });
}

function createCognitionRouter({ cognition, sync, auth, reviewRound = createReviewRound() } = {}) {
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
    const expanded = await expandRelationships(reviewableQuestions(list), cognition);
    // The round only makes sense over the COMPLETE list; a status-filtered view
    // is served as it is.
    res.json({ hypotheses: status ? expanded : reviewRound.apply(expanded) });
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

  // The human's own wording for a statement that is already settled — the
  // person says what is true instead of what was recorded.
  //
  // This is the answer to a gap the other two human routes cannot close:
  // Cognition's update() refuses a confirmed statement (its transition table
  // has no way out of `confirmed`) and confirm() can only be entered from a
  // state that may move to `confirmed`, so a settled statement could not be
  // corrected at all — and a hand correction in Hindsight alone is fragile,
  // because reasoning/hindsightHypothesisAdapter.js re-mirrors the stored
  // statement as a fresh version on any status, confidence, statement or
  // evidence change, taking the old wording straight back into recall.
  //
  // Correcting the record itself is what makes the fix durable: the same id
  // keeps one identity in the derived store (gaia-hyp-<id>-v<n>), the new
  // wording is retained as the next version — confirmed, so it carries
  // gaia:confirmed_fact — and the text it replaces is invalidated. A reason is
  // required, the same posture as reopen: the person is overriding something
  // that was recorded as settled, and the why must be kept.
  //
  // A rejected statement is out of reach in Cognition (reopen() is the
  // documented way out, and it states why), so a correction of one is carried
  // as the two deliberate acts the person asked for: reopen, then correct.
  router.post('/hypotheses/:id/correct', asyncRoute(async (req, res) => {
    const id = req.params.id;
    const statement = req.body && req.body.statement;
    const reason = (req.body && req.body.reason) || '';
    if (!String(statement || '').trim()) {
      return res.status(400).json({ error: 'a statement is required to correct' });
    }
    if (!String(reason).trim()) {
      return res.status(400).json({ error: 'a reason is required to correct a statement' });
    }

    const canRead = typeof cognition.getHypothesis === 'function';
    const existing = canRead ? await cognition.getHypothesis(id).catch(() => null) : null;
    // A rejected record has to come back into the lifecycle first, and the
    // reason the person gave is exactly the reason reopen() insists on.
    if (existing && existing.status === 'rejected') {
      await cognition.reopenHypothesis(id, { reason });
    }

    const corrected = await cognition.correctHypothesis(id, { statement, reason });
    await mirror(corrected);

    const superseded = [];
    const toSupersede = Array.isArray(req.body && req.body.supersedes) ? req.body.supersedes : [];
    for (const oldId of toSupersede) {
      if (!oldId || oldId === id) continue;
      try {
        const old = await cognition.supersedeHypothesis(oldId, {
          supersededById: id,
          reason: reason || 'superseded by a corrected statement',
        });
        await mirror(old);
        superseded.push(oldId);
      } catch (_) {
        // Failing to supersede one old statement never blocks the correction.
      }
    }

    res.json({ hypothesis: corrected, superseded });
  }));

  // The human's answer to an open question. Recorded on the record, with the
  // moment it was given; the question then leaves the review list. Answering is
  // NOT a confirmation — the statement keeps its status and nothing is mirrored,
  // because the answer is the person's own, and Gaia does not quietly turn it
  // into a fact.
  router.post('/hypotheses/:id/answer', asyncRoute(async (req, res) => {
    const answer = (req.body && req.body.answer) || '';
    if (!String(answer).trim()) {
      return res.status(400).json({ error: 'an answer is required' });
    }
    res.json(await cognition.answerHypothesis(req.params.id, { answer }));
  }));

  router.post('/hypotheses/:id/confirm', asyncRoute(async (req, res) => {
    const id = req.params.id;
    const rationale = (req.body && req.body.rationale) || '';
    const statement = req.body && req.body.statement;

    // V3 structural friction, server-side: a macro statement (the safe
    // default), or one carrying a counter-hypothesis, may only be confirmed
    // with a stated rationale — the API
    // refuses a bare click even if a client forgot the UI step. A micro
    // statement may be confirmed without one.
    //
    // The friction applies only to a scope that was actually read. A failed
    // lookup used to land in the same bucket as "macro", which blamed the
    // client for a request it made correctly: a bare click on a micro
    // statement came back as the rationale error. It is retried once, and if
    // the record still cannot be read the route says so rather than guessing.
    // A client that cannot look a statement up at all keeps the strict default.
    const canRead = typeof cognition.getHypothesis === 'function';
    let existing = canRead ? await cognition.getHypothesis(id).catch(() => null) : null;
    if (canRead && !existing) existing = await cognition.getHypothesis(id).catch(() => null);

    // A statement the person has already settled: this click says yes again.
    // Answer with the record instead of letting the store refuse the repeat
    // transition — `confirmed -> confirmed` is a 409, which the person reads as
    // "it failed", while in truth their judgement is already in place. Nothing
    // is written and nothing is mirrored twice.
    if (existing && String(existing.status) === 'confirmed') {
      return res.json({ hypothesis: existing, superseded: [] });
    }

    if (canRead && !existing) {
      return res.status(503).json({ error: 'the statement could not be read' });
    }

    // A statement that reached the person through weight — macro, or micro with
    // an active counter-hypothesis — never settles on a bare click.
    const hasCounter = Boolean(existing && typeof existing.counter_hypothesis === 'string'
      && existing.counter_hypothesis.trim());
    const isMacro = !existing || existing.scope !== 'micro' || hasCounter;
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

module.exports = { createCognitionRouter, reviewableQuestions, REVIEW_STATUSES };
