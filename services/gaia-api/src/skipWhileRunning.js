'use strict';

/**
 * Wraps an async job so a timer tick that fires while the previous run is
 * still going does nothing, instead of starting a second, overlapping run.
 * The returned function resolves to the job's result, or to `undefined` when
 * the tick was skipped. A rejection is passed on to the caller, and the guard
 * is released either way.
 * @template T
 * @param {() => Promise<T>} job
 * @returns {() => Promise<T|undefined>}
 */
function skipWhileRunning(job) {
  let running = false;
  return async function guarded() {
    if (running) return undefined;
    running = true;
    try {
      return await job();
    } finally {
      running = false;
    }
  };
}

module.exports = { skipWhileRunning };
