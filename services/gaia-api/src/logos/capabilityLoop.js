'use strict';

/**
 * Logos capability execution loop (P0 — Gaia-roadmap).
 *
 * Owns the retry/evaluation loop for ONE capability request: invoke the
 * capability through its adapter, evaluate the generic result against
 * `expected_outcome` (capabilityContract.js), and route control back to
 * Logos on `retry`/`alternative` — reformulating the instruction while the
 * original objective and `expected_outcome` stay untouched.
 *
 * The loop counts attempts across the WHOLE execution (every adapter
 * invocation, whatever the verdict path) and stops honestly at
 * `max_attempts`: no further attempt, no success status, explicit `failure`
 * with a truthful report. An unbounded loop is structurally impossible —
 * max_attempts is clamped to [1, HARD_MAX_ATTEMPTS] before the first attempt.
 *
 * Boundary: depends only on the generic contract + the generic adapter
 * interface `{ id?, invokeCapability(request) }`. Never imports or names a
 * concrete capability. No I/O of its own, no model calls.
 */

const {
  OUTCOME_VERDICTS,
  DEFAULT_MAX_ATTEMPTS,
  validateCapabilityRequest,
  evaluateOutcome,
  clampMaxAttempts,
} = require('./capabilityContract');

/**
 * Default alternative formulation: keeps the original objective and
 * `expected_outcome` byte-for-byte, adjusts only the instruction with what
 * the previous attempt taught us. Callers may inject their own
 * `formulateAlternative(request, lastResult, evaluation, attempt)` as long
 * as it preserves objective + expected_outcome (enforced below).
 */
function defaultFormulateAlternative(request, lastResult, evaluation, attempt) {
  void lastResult;
  return {
    ...request,
    instruction: `${request.instruction}\n\n[Attempt ${attempt + 1}: the previous approach did not reach the expected outcome — ${evaluation.reason}. Try a different approach. The objective and expected outcome are unchanged.]`,
  };
}

function preservesGoal(original, reformulated) {
  return reformulated
    && reformulated.objective === original.objective
    && JSON.stringify(reformulated.expected_outcome) === JSON.stringify(original.expected_outcome);
}

/**
 * @param {{
 *   request: object,                       // CapabilityRequest (validated)
 *   adapter: { id?: string, invokeCapability: Function }, // generic adapter
 *   evaluate?: Function,                   // (request, result, attempt) => OutcomeEvaluation
 *   formulateAlternative?: Function,       // (request, lastResult, evaluation, attempt) => request
 *   max_attempts?: number,                 // configurable hard limit (default 3, clamped to 1..10)
 *   adapterOptions?: object,               // opaque passthrough forwarded to every invokeCapability call (e.g. onDelta)
 *   onAttempt?: Function,                  // observability hook ({ attempt, verdict, reason }) — never affects control flow
 * }} options
 * @returns {Promise<{
 *   verdict: 'success'|'ask_user'|'failure',
 *   attempts: number,
 *   maxAttempts: number,
 *   lastResult: object|null,
 *   lastEvaluation: object|null,
 *   history: Array<{ attempt: number, approach: 'initial'|'retry'|'alternative', verdict: string, reason: string }>,
 * }>}
 */
async function runCapabilityLoop({
  request,
  adapter,
  evaluate = evaluateOutcome,
  formulateAlternative = defaultFormulateAlternative,
  max_attempts = DEFAULT_MAX_ATTEMPTS,
  adapterOptions = {},
  onAttempt,
} = {}) {
  if (!adapter || typeof adapter.invokeCapability !== 'function') {
    throw new TypeError('runCapabilityLoop requires an adapter with invokeCapability(request)');
  }
  const maxAttempts = clampMaxAttempts(max_attempts);
  const history = [];

  const requestProblem = validateCapabilityRequest(request);
  if (requestProblem) {
    return {
      verdict: 'failure',
      attempts: 0,
      maxAttempts,
      lastResult: null,
      lastEvaluation: { verdict: 'failure', reason: `invalid capability request: ${requestProblem}`, missingInfo: null },
      history,
    };
  }

  let current = request;
  let approach = 'initial';
  let lastResult = null;
  let lastEvaluation = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw;
    try {
      raw = await adapter.invokeCapability(current, adapterOptions);
    } catch (err) {
      raw = { ok: false, technicalSuccess: false, output: null, error: String((err && err.message) || err) };
    }

    let evaluation;
    try {
      evaluation = await evaluate(current, raw, attempt);
    } catch (err) {
      evaluation = { verdict: 'failure', reason: `outcome evaluation failed: ${String((err && err.message) || err)}`, missingInfo: null };
    }
    if (!evaluation || !OUTCOME_VERDICTS.includes(evaluation.verdict)) {
      evaluation = { verdict: 'failure', reason: 'outcome evaluation returned an invalid verdict', missingInfo: null };
    }

    lastResult = raw;
    lastEvaluation = evaluation;
    history.push({
      attempt,
      approach,
      verdict: evaluation.verdict,
      reason: evaluation.reason || '',
    });
    if (typeof onAttempt === 'function') {
      try {
        onAttempt({ attempt, approach, verdict: evaluation.verdict, reason: evaluation.reason || '' });
      } catch (_) { /* observability never affects control flow */ }
    }

    if (evaluation.verdict === 'success') {
      return { verdict: 'success', attempts: attempt, maxAttempts, lastResult, lastEvaluation, history };
    }
    if (evaluation.verdict === 'ask_user') {
      return { verdict: 'ask_user', attempts: attempt, maxAttempts, lastResult, lastEvaluation, history };
    }
    if (evaluation.verdict === 'failure') {
      return { verdict: 'failure', attempts: attempt, maxAttempts, lastResult, lastEvaluation, history };
    }

    // retry → same instruction again; alternative → reformulated instruction,
    // same objective + expected_outcome. Either way the NEXT iteration counts
    // as the next attempt; when attempts run out the loop below reports
    // failure honestly instead of trying again.
    if (attempt >= maxAttempts) {
      const exhausted = {
        verdict: 'failure',
        reason: `goal not reached after ${attempt} attempt(s) (max_attempts=${maxAttempts}) — last: ${evaluation.reason || evaluation.verdict}`,
        missingInfo: null,
      };
      return { verdict: 'failure', attempts: attempt, maxAttempts, lastResult, lastEvaluation: exhausted, history };
    }

    if (evaluation.verdict === 'alternative') {
      let next;
      try {
        next = await formulateAlternative(current, raw, evaluation, attempt);
      } catch (err) {
        return {
          verdict: 'failure',
          attempts: attempt,
          maxAttempts,
          lastResult,
          lastEvaluation: { verdict: 'failure', reason: `alternative formulation failed: ${String((err && err.message) || err)}`, missingInfo: null },
          history,
        };
      }
      const nextProblem = validateCapabilityRequest(next);
      if (nextProblem || !preservesGoal(request, next)) {
        return {
          verdict: 'failure',
          attempts: attempt,
          maxAttempts,
          lastResult,
          lastEvaluation: {
            verdict: 'failure',
            reason: nextProblem
              ? `alternative formulation invalid: ${nextProblem}`
              : 'alternative formulation must preserve the original objective and expected_outcome',
            missingInfo: null,
          },
          history,
        };
      }
      current = next;
      approach = 'alternative';
    } else {
      // retry — identical request, next attempt.
      approach = 'retry';
    }
  }

  // Unreachable: the in-loop exhaustion branch above always returns. Kept as
  // a structural backstop so no future edit can fall through to an implicit
  // retry.
  /* istanbul ignore next */
  return {
    verdict: 'failure',
    attempts: maxAttempts,
    maxAttempts,
    lastResult,
    lastEvaluation: { verdict: 'failure', reason: `goal not reached (max_attempts=${maxAttempts})`, missingInfo: null },
    history,
  };
}

module.exports = { runCapabilityLoop, defaultFormulateAlternative };
