'use strict';

/**
 * Pipeline latency tracing — lightweight instrumentation for runTurnCore.
 *
 * Logs timing events for every pipeline stage using high-resolution
 * timestamps. One traceId per turn, shared across all events.
 *
 * Design constraints:
 *   - Zero overhead when tracing is disabled (debug flag)
 *   - Never throws — observability must never affect a turn
 *   - Never logs secrets, prompts, or response content
 *   - Uses process.hrtime.bigint() for monotonic duration measurement
 */

/**
 * Create a timing context for one turn.
 * @param {string} traceId
 * @param {{ log?: Function }} [options]
 * @returns {object} timing context
 */
function createTurnTiming(traceId, options = {}) {
  const log = options.log || console.log;
  const turnStart = process.hrtime.bigint();
  const turnStartedAt = new Date().toISOString();

  /** @type {Array<object>} collected timing events */
  const events = [];

  /** @type {Record<string, { started: bigint, startedAt: string }>} active stages */
  const active = {};

  /**
   * Start a timing stage.
   * @param {string} stage
   */
  function start(stage) {
    active[stage] = { started: process.hrtime.bigint(), startedAt: new Date().toISOString() };
  }

  /**
   * End a timing stage and log it.
   * @param {string} stage
   * @param {object} [extra] additional fields to include
   */
  function end(stage, extra = {}) {
    const a = active[stage];
    if (!a) return;
    const ended = process.hrtime.bigint();
    const durationMs = Number(ended - a.started) / 1e6;
    const event = {
      kind: 'gaia.timing',
      traceId,
      stage,
      startedAt: a.startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Math.round(durationMs * 100) / 100,
      ...extra,
    };
    events.push(event);
    try {
      log(JSON.stringify(event));
    } catch (_) { /* never break a turn */ }
    delete active[stage];
    return event;
  }

  /**
   * Get duration of a completed stage in ms.
   * @param {string} stage
   * @returns {number|null}
   */
  function getDuration(stage) {
    const e = events.find((ev) => ev.stage === stage);
    return e ? e.durationMs : null;
  }

  /**
   * Log a failed stage.
   * @param {string} stage
   * @param {string} errorType
   * @param {object} [extra]
   */
  function fail(stage, errorType, extra = {}) {
    const a = active[stage];
    const ended = process.hrtime.bigint();
    const durationMs = a ? Number(ended - a.started) / 1e6 : 0;
    const event = {
      kind: 'gaia.timing',
      traceId,
      stage: stage + '.failed',
      durationMs: Math.round(durationMs * 100) / 100,
      errorType,
      ...extra,
    };
    events.push(event);
    try {
      log(JSON.stringify(event));
    } catch (_) { /* never break a turn */ }
    if (a) delete active[stage];
    return event;
  }

  /**
   * Log turn.done with total duration and breakdown.
   * @param {object} [breakdown] stage durations in ms
   */
  function done(breakdown = {}) {
    const totalMs = Number(process.hrtime.bigint() - turnStart) / 1e6;
    const event = {
      kind: 'gaia.timing',
      traceId,
      stage: 'turn.done',
      startedAt: turnStartedAt,
      endedAt: new Date().toISOString(),
      totalDurationMs: Math.round(totalMs * 100) / 100,
      ...breakdown,
    };
    events.push(event);
    try {
      log(JSON.stringify(event));
    } catch (_) { /* never break a turn */ }
    return event;
  }

  /**
   * Get all collected events.
   * @returns {Array<object>}
   */
  function getEvents() {
    return [...events];
  }

  return { start, end, fail, done, getDuration, getEvents };
}

/**
 * Create a first-token tracker for streaming.
 * Wraps an onDelta callback to capture the timestamp of the first token.
 * @param {Function} [originalOnDelta]
 * @param {{ onFirstToken?: Function }} options
 * @returns {Function} wrapped onDelta
 */
function trackFirstToken(originalOnDelta, options = {}) {
  let firstTokenCaptured = false;
  const firstTokenTime = process.hrtime.bigint();

  return function wrappedOnDelta(chunk, isReasoning) {
    if (!firstTokenCaptured && chunk && chunk.length > 0 && !isReasoning) {
      firstTokenCaptured = true;
      const timeToFirstTokenMs = Number(process.hrtime.bigint() - firstTokenTime) / 1e6;
      if (typeof options.onFirstToken === 'function') {
        options.onFirstToken(Math.round(timeToFirstTokenMs * 100) / 100);
      }
    }
    if (typeof originalOnDelta === 'function') {
      originalOnDelta(chunk, isReasoning);
    }
  };
}

module.exports = { createTurnTiming, trackFirstToken };
