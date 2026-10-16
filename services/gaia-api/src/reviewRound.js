'use strict';

/**
 * The review round — what the person is asked to look at, and when.
 *
 * Two decisions live here, both server-side so every client (web and desktop)
 * gets the same answer:
 *
 *  1. ELIGIBILITY. A derived statement reaches the human only when it carries
 *     weight: it is macro (the safe default — content, people, career, project
 *     choices) OR it carries an active counter-hypothesis (cognitive friction in
 *     the source data), AND the evidence has built up to the threshold
 *     (confidence >= 0.75). A micro statement without a counter-hypothesis —
 *     a soft preference, a formatting habit — never reaches the person: it
 *     soft-promotes on its own (`corroborated`, C >= 0.80) and a later
 *     correction by the person is what moves it. An open question is a request
 *     for the person's own answer, so it is always eligible; it has no
 *     confidence to wait for.
 *
 *  2. THE ROUND. The eligible statements are not a stream. They are served as a
 *     round of at most `size` (default 5) so the load stays bounded. A round is
 *     fixed: it only gives way to the next one once every statement in it has
 *     been dealt with. Nothing is ever pushed into a live conversation — the
 *     round simply waits until the person opens the review surface.
 *
 *       dealt with = the statement left the review statuses (confirmed or
 *       rejected), or it was touched (e.g. "Test") since the round was made.
 *       A touched statement that is still under review is DEFERRED: it does not
 *       come back until its record changes again (new evidence), so "Test" does
 *       not make the same card reappear in the very next round.
 *
 * State is in memory (one gaia-api process): after a restart the round is
 * rebuilt from the same eligibility rules, which is harmless.
 */

const REVIEW_STATUSES = Object.freeze(['proposed', 'testing', 'corroborated']);
const DEFAULT_SIZE = 5;
const DEFAULT_THRESHOLD = 0.75;

const inReview = (record) => Boolean(record) && REVIEW_STATUSES.includes(record.status);

function hasCounterHypothesis(record) {
  return typeof record.counter_hypothesis === 'string' && record.counter_hypothesis.trim().length > 0;
}

function confidenceOf(record) {
  const n = Number(record.confidence);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether a statement that is under review may be put in front of the person.
 * Pure; the one place the criterion lives.
 */
function isReviewEligible(record, { threshold = DEFAULT_THRESHOLD } = {}) {
  if (!inReview(record)) return false;
  if (record.kind === 'open_question') return true;
  const weighty = record.scope !== 'micro' || hasCounterHypothesis(record);
  return weighty && confidenceOf(record) >= threshold;
}

function createReviewRound({ size = DEFAULT_SIZE, threshold = DEFAULT_THRESHOLD } = {}) {
  // id -> the updated_at the record had when the round was made. A record whose
  // updated_at differs has been touched since.
  let round = new Map();
  // id -> updated_at of a statement that was touched but is still under review.
  const deferred = new Map();

  /**
   * Annotates every statement under review with `review_eligible` and
   * `in_round`; settled statements pass through untouched. Must be given the
   * COMPLETE list — a partial list would read as "the others are gone".
   */
  function apply(records) {
    const list = Array.isArray(records) ? records : [];
    const byId = new Map(list.filter(inReview).map((r) => [r.id, r]));

    // Drop what has been dealt with; a touched one that is still under review
    // is deferred until it changes again.
    const pending = new Map();
    for (const [id, snapshot] of round) {
      const current = byId.get(id);
      if (!current) continue;
      if (current.updated_at === snapshot) pending.set(id, snapshot);
      else deferred.set(id, current.updated_at);
    }
    // A deferred statement that changed again is a candidate once more.
    for (const [id, snapshot] of [...deferred]) {
      const current = byId.get(id);
      if (!current || current.updated_at !== snapshot) deferred.delete(id);
    }

    if (pending.size > 0) {
      round = pending;
    } else {
      const next = [...byId.values()]
        .filter((r) => isReviewEligible(r, { threshold }) && !deferred.has(r.id))
        .sort((a, b) => confidenceOf(b) - confidenceOf(a))
        .slice(0, size);
      round = new Map(next.map((r) => [r.id, r.updated_at]));
    }

    return list.map((record) => {
      if (!inReview(record)) return record;
      return {
        ...record,
        review_eligible: isReviewEligible(record, { threshold }),
        in_round: round.has(record.id),
      };
    });
  }

  return { apply, size, threshold };
}

module.exports = { createReviewRound, isReviewEligible, REVIEW_STATUSES, DEFAULT_SIZE, DEFAULT_THRESHOLD };
