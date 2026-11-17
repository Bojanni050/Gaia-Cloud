'use strict';

/**
 * The background passes, in one place.
 *
 * Eight loops run behind a turn: the three hypothesis scans (soft promotion,
 * expiry, belief formation), Aion's flush, the Kairos worker, the Kairos day
 * digest, the Eleos tick and the research poll. Every one of them logs a line
 * when it does something and then throws its counts away, so "is the expiry
 * pass off, or did nothing expire?" could only be answered from the container's
 * environment (docs/advice.md C7). This registry is where a pass reports what
 * it did; `GET /admin/api/scans` is how you read it.
 *
 * Two mechanisms that look like passes are deliberately NOT here: the
 * background Logos reflection runs inside the deferred chain of a turn, and the
 * Cognition→Hindsight mirror runs on a write. Neither has an interval to be
 * late on, so a `lastRunAt` for them would be a number that means nothing.
 *
 * A pass declares itself BEFORE it starts — including when it never starts:
 * `enabled: false` plus the reason (which flag, or which seam is missing). That
 * distinction is the whole point, because a pass that is off and a pass that
 * found nothing to do look identical in a log.
 *
 * Nothing here is ever thrown away: `lastError` stays until a later failure
 * replaces it, so a pass that fails once an hour and succeeds in between is
 * still visible as such (`runs`, `failures`, `lastErrorAt`).
 */

const PASS_FIELDS = {
  name: null,
  enabled: false,
  reason: null,
  note: null,
  intervalMs: null,
  runs: 0,
  failures: 0,
  lastRunAt: null,
  lastRunMs: null,
  lastCounts: null,
  lastError: null,
  lastErrorAt: null,
};

/**
 * @param {{ now?: () => number }} [deps]
 * @returns {{
 *   declare: (name: string, options?: object) => string,
 *   record: (name: string, outcome?: object) => object,
 *   snapshot: () => object[],
 *   size: () => number,
 * }}
 */
function createPassRegistry({ now = Date.now } = {}) {
  const passes = new Map();

  function entry(name) {
    if (!passes.has(name)) passes.set(name, { ...PASS_FIELDS, name });
    return passes.get(name);
  }

  /**
   * Say that a pass exists, and whether it is running. Called on the way in, so
   * a pass that is switched off still shows up — with its reason.
   *
   * `note` is for the passes whose rhythm is not an interval (Aion flushes on
   * turns, on idle and on a session change), so the row explains itself without
   * a `lastRunAt` that could not be predicted from anything.
   */
  function declare(name, { enabled = true, reason = null, intervalMs = null, note = null } = {}) {
    const pass = entry(name);
    pass.enabled = Boolean(enabled);
    pass.reason = enabled ? null : (reason || 'off');
    if (intervalMs !== null && intervalMs !== undefined) pass.intervalMs = intervalMs;
    if (note) pass.note = note;
    return pass.name;
  }

  /**
   * One run — timer-driven or asked for by hand. A result that carries an
   * `error` string counts as a failure, which is how the passes report a failed
   * pass without throwing (`{ error: '...' }`).
   *
   * @param {string} name
   * @param {{ at?: number, durationMs?: number|null, result?: object|null, error?: Error|null }} [outcome]
   */
  function record(name, { at = now(), durationMs = null, result = null, error = null } = {}) {
    const pass = entry(name);
    const message = error && error.message ? error.message : (result && typeof result.error === 'string' ? result.error : null);
    pass.runs += 1;
    pass.lastRunAt = new Date(at).toISOString();
    pass.lastRunMs = durationMs;
    if (message) {
      pass.failures += 1;
      pass.lastError = message;
      pass.lastErrorAt = new Date(at).toISOString();
    } else {
      pass.lastCounts = result;
    }
    return pass;
  }

  /** What `GET /admin/api/scans` returns, sorted so the order is stable. */
  function snapshot() {
    return [...passes.values()]
      .map((pass) => ({ ...pass }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return { declare, record, snapshot, size: () => passes.size };
}

module.exports = { createPassRegistry, PASS_FIELDS };
