'use strict';

/**
 * Hypothesis expiry pass — the periodic decision that a statement has lapsed.
 *
 * A hypothesis is often formed before there is any proof: it is a possible
 * explanation, and the ordinary cycle is that evidence arrives and moves it
 * from `proposed` to `testing`. But when nothing ever arrives and nothing
 * touches it again, it is not knowledge and it is not a judgement either — it
 * is residue. Left alone it piles up: the review round only surfaces a handful
 * that carry weight, so an evidence-less statement sits in `proposed` forever,
 * neither judged nor let go, only counted in the sidebar's "waiting" figure.
 *
 * So it lapses. This pass is the decision half (Logos's side); Cognition only
 * persists the step it is given — the same split as the soft-promotion pass
 * next door, and it reuses that module's row mapper because both read the same
 * store shape.
 *
 * Deliberately NOT a rejection: `rejected` means there was a substantive
 * reason to dismiss a statement, `expired` means nothing happened at all. It
 * is therefore not a quarantine — evidence that arrives later revives it (see
 * the first-evidence step in hypothesisManager), because a lapsed hypothesis is
 * not a false one. Nothing is deleted: the record keeps its `expired_at` so
 * the lapse stays checkable.
 *
 * The gate itself lives in ONE place, `isExpirable()` in hypothesisManager —
 * this pass only asks it. It runs every GAIA_HYPOTHESIS_EXPIRY_INTERVAL_MS
 * (default 15 minutes) over hypotheses sitting in `proposed`, lapses the ones
 * older than GAIA_HYPOTHESIS_EXPIRY_DAYS (default 14) without supporting
 * evidence, logs one line per pass, and never throws. Off with
 * GAIA_HYPOTHESIS_EXPIRY=false.
 */

const { isExpirable, DEFAULT_EXPIRY_DAYS } = require('./hypothesisManager');
const { fromStoreRecord } = require('./softPromotionScan');

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * @param {{
 *   cognition?: object,
 *   sink?: object,
 *   env?: NodeJS.ProcessEnv,
 *   intervalMs?: number,
 *   days?: number,
 *   now?: () => number,
 *   logger?: object,
 * }} deps
 * @returns {{ start: () => void, stop: () => void, runOnce: () => Promise<object>, enabled: boolean }|null}
 */
function createExpiryScan({
  cognition,
  sink,
  env = process.env,
  intervalMs = Number(env.GAIA_HYPOTHESIS_EXPIRY_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  days = Number(env.GAIA_HYPOTHESIS_EXPIRY_DAYS) || DEFAULT_EXPIRY_DAYS,
  now = Date.now,
  logger = console,
} = {}) {
  if ((env.GAIA_HYPOTHESIS_EXPIRY || 'true') !== 'true') return null;
  if (!cognition || typeof cognition.listHypotheses !== 'function') {
    logger.warn?.('[hypotheses] expiry pass not started: Cognition client unavailable');
    return null;
  }
  if (!sink || typeof sink.update !== 'function') {
    logger.warn?.('[hypotheses] expiry pass not started: hypothesis sink unavailable');
    return null;
  }

  let running = false;
  let timer = null;

  /** One pass. Never throws; the caller logs an `{ error }` result like the other workers. */
  async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    try {
      const rows = await cognition.listHypotheses({ status: 'proposed', kind: 'hypothesis' });
      const result = { examined: 0, expired: 0, skipped: 0, failed: 0, ids: [] };
      const at = now();
      for (const row of Array.isArray(rows) ? rows : []) {
        const h = fromStoreRecord(row);
        result.examined += 1;
        if (!isExpirable(h, { days, now: at })) {
          result.skipped += 1;
          continue;
        }
        try {
          // Both sides are identical apart from the status, so the sink sends
          // only the lifecycle verb (`POST /hypotheses/:id/expire`) and mirrors
          // the record — no patch, no evidence calls.
          await sink.update(h.id, { ...h, status: 'expired' }, h);
          result.expired += 1;
          result.ids.push(h.id);
        } catch (error) {
          result.failed += 1;
          logger.warn?.(`[hypotheses] expiry failed for ${h.id}: ${error.message}`);
        }
      }
      if (result.expired > 0) {
        logger.info?.(`[hypotheses] lapsed ${result.expired} statement(s) that never gained evidence`);
      }
      return result;
    } catch (error) {
      logger.error?.(`[hypotheses] expiry pass failed: ${error.message}`);
      return { error: error.message };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void runOnce(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    void runOnce();
    logger.info?.(`[hypotheses] expiry pass started (every ${intervalMs}ms, term ${days} days)`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce, enabled: true };
}

module.exports = { createExpiryScan, DEFAULT_INTERVAL_MS };
