'use strict';

/**
 * Hypothesis soft-promotion scan — the periodic catch-up for the machine tier.
 *
 * The per-turn path (HypothesisManager.softPromote) only ever sees the
 * hypotheses a turn actually touches. A micro statement that builds up its
 * confidence and is then never mentioned again would sit in `testing` forever:
 * the review surface does not show it (a micro claim without a
 * counter-hypothesis is deliberately not review-eligible) and nothing else
 * promotes it. This worker is the other half of that pair — it reads the
 * records the store holds, applies the SAME gate (isSoftPromotable: one
 * implementation, two callers) and promotes the ones that qualify.
 *
 * It reads from Cognition, never from the manager's in-memory state: a
 * stranded record is by definition one the manager does not hold. Promotion
 * goes through the ordinary sink, so the Hindsight mirror follows exactly as
 * it does for a turn.
 *
 * Entirely best-effort, like the Kairos worker: no Cognition client simply
 * means it does not start, one failing record is logged and skipped, and
 * nothing here ever blocks a turn. Cranks every
 * GAIA_HYPOTHESIS_SCAN_INTERVAL_MS (default 15 minutes); off with
 * GAIA_HYPOTHESIS_SCAN=false.
 */

const { isSoftPromotable } = require('./hypothesisManager');

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Cognition row (snake_case; a Postgres `numeric` confidence arrives as a
 * string) → the shape isSoftPromotable and the sink both understand.
 * @param {object} row
 */
function fromStoreRecord(row) {
  return {
    id: String(row.id),
    statement: row.statement,
    status: row.status,
    confidence: row.confidence != null ? Number(row.confidence) : null,
    scope: row.scope,
    evidenceFor: Array.isArray(row.evidence_for) ? row.evidence_for : [],
    evidenceAgainst: Array.isArray(row.evidence_against) ? row.evidence_against : [],
  };
}

/**
 * @param {{
 *   cognition?: object,
 *   sink?: object,
 *   env?: NodeJS.ProcessEnv,
 *   intervalMs?: number,
 *   policy?: object,
 *   logger?: object,
 * }} deps
 * @returns {{ start: () => void, stop: () => void, runOnce: () => Promise<object>, enabled: boolean }|null}
 */
function createSoftPromotionScan({
  cognition,
  sink,
  env = process.env,
  intervalMs = Number(env.GAIA_HYPOTHESIS_SCAN_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  policy,
  logger = console,
} = {}) {
  if ((env.GAIA_HYPOTHESIS_SCAN || 'true') !== 'true') return null;
  if (!cognition || typeof cognition.listHypotheses !== 'function') {
    logger.warn?.('[hypotheses] soft-promotion scan not started: Cognition client unavailable');
    return null;
  }
  if (!sink || typeof sink.update !== 'function') {
    logger.warn?.('[hypotheses] soft-promotion scan not started: hypothesis sink unavailable');
    return null;
  }

  let running = false;
  let timer = null;

  /**
   * Scan once. Never throws: a store that is down yields a `{ error }` result
   * the caller can log, exactly like the Kairos worker.
   */
  async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    try {
      const rows = await cognition.listHypotheses({ status: 'testing' });
      const result = { examined: 0, promoted: 0, skipped: 0, failed: 0, ids: [] };
      for (const row of Array.isArray(rows) ? rows : []) {
        const h = fromStoreRecord(row);
        result.examined += 1;
        if (!isSoftPromotable(h, policy)) {
          result.skipped += 1;
          continue;
        }
        try {
          // The sink diffs next against prev: identical apart from the status,
          // so it sends only the lifecycle verb (stepping the store through
          // `testing` where it has to) and mirrors the record — no patch, no
          // evidence calls.
          await sink.update(h.id, { ...h, status: 'corroborated' }, h);
          result.promoted += 1;
          result.ids.push(h.id);
        } catch (error) {
          result.failed += 1;
          logger.warn?.(`[hypotheses] soft-promotion failed for ${h.id}: ${error.message}`);
        }
      }
      if (result.promoted > 0) {
        logger.info?.(`[hypotheses] soft-promoted ${result.promoted} stranded micro statement(s)`);
      }
      return result;
    } catch (error) {
      logger.error?.(`[hypotheses] soft-promotion scan failed: ${error.message}`);
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
    logger.info?.(`[hypotheses] soft-promotion scan started (every ${intervalMs}ms)`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce, enabled: true };
}

module.exports = { createSoftPromotionScan, fromStoreRecord, DEFAULT_INTERVAL_MS };
