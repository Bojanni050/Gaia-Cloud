'use strict';

/**
 * Eleos — the facade the turn path and the server see.
 *
 * Two halves under one name:
 *   - the PASS (reasoning/eleos.js): after a turn, notice a moment worth
 *     coming back to and record it as an open loop, and
 *   - the RUNTIME (eleosRuntime.js): later, come back to it by starting a new
 *     conversation.
 *
 * `noteTurn` is what turn.js's deferred phase calls; it records the person's
 * activity (for the "do not interrupt" policy) and then runs the pass. Because
 * the pass's gate is free and only opens on a real signal, there is no separate
 * cadence for it — unlike Aion, whose model call is unconditional.
 */

/**
 * @param {{ pass?: { noteTurn: Function }|null, runtime?: object|null }} parts
 */
function createEleos({ pass, runtime } = {}) {
  async function noteTurn({ conversationId, messages, logger } = {}) {
    if (runtime && typeof runtime.recordActivity === 'function') runtime.recordActivity();
    if (!pass || typeof pass.noteTurn !== 'function') return { skipped: 'no-pass' };
    return pass.noteTurn({ conversationId, messages, logger });
  }

  function start() {
    return runtime && typeof runtime.start === 'function' ? runtime.start() : () => {};
  }

  function stop() {
    if (runtime && typeof runtime.stop === 'function') runtime.stop();
  }

  return { noteTurn, start, stop, pass: pass || null, runtime: runtime || null };
}

module.exports = { createEleos };
