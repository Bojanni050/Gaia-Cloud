'use strict';

/**
 * Kairos worker — the incremental orchestrator (Layer 2 → 3 boundary).
 *
 * Each run: read the watermark, fetch raw observations since it, group them
 * with the deterministic clusterer, synthesize the CLOSED clusters, persist
 * them (idempotent upsert) and emit each one. Then advance the watermark.
 *
 * THE WATERMARK AXIS (fixed 2026-10-12). Foundation's read seam FILTERS on
 * `captured_at` (system ingest time: `GET /api/memory/episodes?since=`), but the
 * clusterer GROUPS on `observed_at` (event time). For live capture the two are
 * close, but for a BACKFILL they are not (capture-rs can ingest a year of
 * events over a few days), so a cluster's `captured_at` can be anywhere. The old
 * rule advanced the watermark to the last processed cluster's `captured_at`,
 * which could jump past observations that had not been processed yet — a silent
 * skip on a mid-run failure — and could go backwards (re-fetching everything).
 *
 * The fixed rule, `computeSafeWatermark(batch, finalized, current)`:
 *   - the watermark may only name a `captured_at` value below which EVERY
 *     observation is already finalized (in a closed cluster we processed or
 *     skipped). That is `max(captured_at)` among observations strictly below the
 *     earliest still-unfinalized observation's `captured_at`;
 *   - when everything is finalized it is simply `max(captured_at)` of the batch;
 *   - it never moves backwards (monotonic).
 * Because Foundation's `since` is exclusive, that guarantee means the next fetch
 * re-returns exactly the unfinalized observations — never fewer.
 *
 * Failure-safety, both mirroring Foundation's own reflection job
 * (server/hypothesisReflectionSync.js):
 *   1. Only CLOSED clusters are finalized (the clusterer's trailing open run is
 *      left for the next poll so it grows into one episode, not many fragments).
 *   2. A failing cluster STOPS the batch (its observations are re-fetched), and
 *      the watermark is advanced only over the safely-finalized prefix.
 *
 * Re-fetch is cheap: a cluster whose episode already exists (`readEpisode`) is
 * SKIPPED — no second model call — and counts as finalized, so a conservative
 * watermark never re-spends tokens.
 */

const { groupObservations } = require('./clusterer');

// Kairos synthesizes NARRATIVE activity episodes. Only screen/activity
// observations belong in that: `source_type === 'system-observation'` (what
// capture-rs feeds). Chats (`chat-import`) are already summarized by
// Chronicle-Gaia; documents are not activity either. Everything else is
// deliberately left out — one owner per job.
const CLUSTERABLE_SOURCE_TYPE = 'system-observation';

/**
 * Split a fetched batch into the observations Kairos may cluster and the ones
 * it must leave alone. Pure, no I/O, and never silently keeps an unknown source:
 * a missing or unrecognised `source_type` goes to `skipped` too.
 *
 * @param {Array<{source_type?: string}>} observations
 * @returns {{ clusterable: Array, skipped: Array, skippedByType: Record<string, number> }}
 */
function selectClusterable(observations) {
  const clusterable = [];
  const skipped = [];
  const skippedByType = {};
  for (const o of Array.isArray(observations) ? observations : []) {
    const type = o && typeof o.source_type === 'string' ? o.source_type : null;
    if (type === CLUSTERABLE_SOURCE_TYPE) {
      clusterable.push(o);
    } else {
      skipped.push(o);
      const key = type || '(missing)';
      skippedByType[key] = (skippedByType[key] || 0) + 1;
    }
  }
  return { clusterable, skipped, skippedByType };
}

/**
 * The largest `captured_at` below which every observation is finalized, without
 * ever moving backwards. Pure. See the module header for the reasoning.
 *
 * @param {import('./types').KairosObservation[]} batch
 * @param {Array<{observations?: Array}>} finalizedClusters
 * @param {string|null} currentWatermark
 * @returns {string|null}
 */
function computeSafeWatermark(batch, finalizedClusters, currentWatermark) {
  const ms = (o) => {
    const v = o && o.captured_at != null ? o.captured_at : null;
    if (v == null) return NaN;
    return new Date(v).getTime();
  };

  const finalizedIds = new Set();
  for (const cluster of finalizedClusters || []) {
    for (const o of (cluster && cluster.observations) || []) {
      if (o && o.id != null) finalizedIds.add(String(o.id));
    }
  }

  const unfinalized = (batch || []).filter((o) => !finalizedIds.has(String(o && o.id)));

  let next = null;
  if (unfinalized.length === 0) {
    const all = batch.map(ms).filter(Number.isFinite);
    next = all.length ? Math.max(...all) : null;
  } else {
    const cut = Math.min(...unfinalized.map(ms).filter(Number.isFinite));
    if (Number.isFinite(cut)) {
      const below = batch.map(ms).filter((v) => Number.isFinite(v) && v < cut);
      next = below.length ? Math.max(...below) : null;
    }
  }

  const currentMs = currentWatermark ? new Date(currentWatermark).getTime() : null;
  if (next == null) return currentWatermark || null;
  if (currentMs != null && next <= currentMs) return currentWatermark;
  return new Date(next).toISOString();
}

/**
 * @param {{
 *   bankId: string,
 *   now?: () => Date,
 *   readWatermark: () => Promise<string|null>,
 *   writeWatermark: (iso: string) => Promise<void>,
 *   fetchObservations: (sinceIso: string|null) => Promise<import('./types').KairosObservation[]>,
 *   synthesize: (cluster: import('./types').ObservationCluster, bankId: string) => Promise<object>,
 *   saveEpisode: (episode: object) => Promise<void>,
 *   readEpisode?: (episodeId: string) => Promise<object|null>,
 *   episodeIdFor?: (clusterId: string) => string,
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
  readEpisode,
  episodeIdFor,
  emit,
  logger = console,
} = {}) {
  if (!bankId) throw new Error('kairos worker requires a bankId');
  const required = { readWatermark, writeWatermark, fetchObservations, synthesize, saveEpisode };
  for (const [name, fn] of Object.entries(required)) {
    if (typeof fn !== 'function') throw new Error(`kairos worker requires ${name}`);
  }

  /** The episode already stored for a cluster, or null (skip = no model call). */
  async function existingEpisode(cluster) {
    if (typeof readEpisode !== 'function' || typeof episodeIdFor !== 'function') return null;
    try {
      return await readEpisode(episodeIdFor(cluster.id));
    } catch (_) {
      return null; // 404 or an unreachable store: treat as "not done", re-synthesize.
    }
  }

  /**
   * One batch: fetch, cluster, finalize closed clusters (synthesize or skip),
   * advance the watermark safely. @returns {Promise<object>}
   */
  async function runOnce() {
    const since = await readWatermark();
    const observations = await fetchObservations(since);
    if (!Array.isArray(observations) || observations.length === 0) {
      return { processed: 0, emitted: 0, skipped: 0, failed: 0 };
    }

    // Source selection is the boundary: only activity observations are clustered.
    // The skipped ones count as finalized for THIS batch's watermark (so a
    // chat-only batch still advances), but are never clustered, never
    // synthesized and never persisted.
    const { clusterable, skipped, skippedByType } = selectClusterable(observations);
    if (skipped.length > 0) {
      logger.info?.(`[kairos] skipped ${skipped.length} non-clusterable observations by source_type: ${JSON.stringify(skippedByType)}`);
    }

    const clusters = groupObservations(clusterable, { now: now().toISOString() });
    const finalized = [];
    if (skipped.length > 0) finalized.push({ observations: skipped });
    let finalizedClusters = 0;
    let processed = 0;
    let emitted = 0;
    let skippedEpisodes = 0;

    const advance = async () => {
      const next = computeSafeWatermark(observations, finalized, since);
      if (next && next !== since) {
        try {
          await writeWatermark(next);
        } catch (_) {
          // Best-effort: a failed watermark write just means a re-fetch next run.
        }
      }
    };

    for (const cluster of clusters) {
      try {
        const existing = await existingEpisode(cluster);
        if (existing) {
          // Already synthesized in an earlier run (re-fetched on a conservative
          // watermark): finalize it WITHOUT a second model call.
          skippedEpisodes += 1;
          finalizedClusters += 1;
          finalized.push(cluster);
          continue;
        }
        const episode = await synthesize(cluster, bankId);
        await saveEpisode(episode);
        processed += 1;
        finalizedClusters += 1;
        finalized.push(cluster);
        if (emit) {
          emitted += 1;
          try {
            emit(episode);
          } catch (emitError) {
            logger.warn?.(`[kairos] emit failed for ${episode.id}: ${emitError.message}`);
          }
        }
      } catch (error) {
        // Stop the run here: do NOT finalize this cluster, so its observations
        // are re-fetched. The watermark still advances over the safe prefix.
        logger.error?.(`[kairos] synthesis failed for ${cluster.id}, stopping batch: ${error.message}`);
        await advance();
        return { processed, emitted, skipped: skippedEpisodes, failed: clusters.length - finalizedClusters };
      }
    }

    await advance();
    return { processed, emitted, skipped: skippedEpisodes, failed: 0 };
  }

  return { runOnce };
}

module.exports = { createKairosWorker, computeSafeWatermark, selectClusterable, CLUSTERABLE_SOURCE_TYPE };
