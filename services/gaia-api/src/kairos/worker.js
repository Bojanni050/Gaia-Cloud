'use strict';

/**
 * Kairos worker — the incremental orchestrator (Layer 2 → 3 boundary).
 *
 * Each run: read the watermark, fetch raw observations since it, group them
 * with the deterministic clusterer, synthesize the CLOSED clusters, persist
 * them (idempotent upsert) and emit each one. Then advance the watermark.
 *
 * Two failure-safety rules, both mirroring Foundation's own reflection job
 * (server/hypothesisReflectionSync.js):
 *
 *   1. Only CLOSED clusters are finalized (clusterer's finalizeOpen stays
 *      false). The trailing, still-open run is left for the next poll so it
 *      grows into one episode instead of fragmenting into many.
 *   2. The watermark advances only past the last CONTIGUOUS cluster that
 *      succeeded. If a cluster fails (model timeout, invalid output), the run
 *      stops advancing at the cluster before it — the failed observations are
 *      re-fetched and retried next run, never silently skipped.
 *
 * The watermark axis is captured_at (system time), because that is what
 * Foundation's read seam filters on. Clustering itself uses observed_at
 * (event time).
 */

const { groupObservations } = require('./clusterer');

/**
 * @param {{
 *   bankId: string,
 *   now?: () => Date,
 *   readWatermark: () => Promise<string|null>,
 *   writeWatermark: (iso: string) => Promise<void>,
 *   fetchObservations: (sinceIso: string|null) => Promise<import('./types').KairosObservation[]>,
 *   synthesize: (cluster: import('./types').ObservationCluster, bankId: string) => Promise<object>,
 *   saveEpisode: (episode: object) => Promise<void>,
 *   emit?: (episode: object) => void,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} deps
 */
function createKairosWorker({
  bankId,
  now = () => new Date(),
  readWatermark,
  writeWatermark,
  fetchObservations,
  synthesize,
  saveEpisode,
  emit,
  logger = console,
} = {}) {
  if (!bankId) throw new Error('kairos worker requires a bankId');
  const required = { readWatermark, writeWatermark, fetchObservations, synthesize, saveEpisode };
  for (const [name, fn] of Object.entries(required)) {
    if (typeof fn !== 'function') throw new Error(`kairos worker requires ${name}`);
  }

  /**
   * One batch: fetch, cluster, synthesize closed clusters, advance watermark.
   * @returns {Promise<{ processed: number, emitted: number, failed: number }>}
   */
  async function runOnce() {
    const since = await readWatermark();
    const observations = await fetchObservations(since);
    if (!Array.isArray(observations) || observations.length === 0) {
      return { processed: 0, emitted: 0, failed: 0 };
    }

    const clusters = groupObservations(observations, { now: now().toISOString() });
    let processed = 0;
    let emitted = 0;

    for (const cluster of clusters) {
      try {
        const episode = await synthesize(cluster, bankId);
        await saveEpisode(episode);
        processed += 1;
        if (emit) {
          emitted += 1;
          try {
            emit(episode);
          } catch (emitError) {
            logger.warn?.(`[kairos] emit failed for ${episode.id}: ${emitError.message}`);
          }
        }
        // Persist contiguous progress immediately. Advancing only when we got
        // here for every cluster before this one means a later failure never
        // discards an earlier success — the watermark is written up to the
        // last cluster that actually completed.
        await writeWatermark(cluster.window_end);
      } catch (error) {
        // Stop the run here: do NOT advance past this cluster, so its
        // observations are retried on the next run.
        logger.error?.(`[kairos] synthesis failed for ${cluster.id}, stopping batch: ${error.message}`);
        return { processed, emitted, failed: clusters.length - processed };
      }
    }

    return { processed, emitted, failed: 0 };
  }

  return { runOnce };
}

module.exports = { createKairosWorker };
