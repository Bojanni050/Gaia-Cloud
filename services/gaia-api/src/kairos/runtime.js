'use strict';

/**
 * Kairos runtime — wires the pieces into a running pipeline for one bank:
 *
 *   Foundation read seam ─▶ clusterer ─▶ synthesizer (admin 'kairos' role)
 *        ─▶ cognition store (via cognitionClient) ─▶ Hindsight mirror
 *        ─▶ emitter ─▶ SSE route
 *
 * It is created once at server startup behind GAIA_KAIROS_ENABLED and is
 * entirely best-effort: no Foundation, no Cognition, or no Kairos model simply
 * means the worker does not start — never a failed turn or a crashed server.
 */

const { createKairosWorker } = require('./worker');
const { createSynthesizer, episodeIdFor } = require('./synthesizer');
const { emitEpisode } = require('./emitter');
const { resolveRoleConfig } = require('../providerConfigResolver');
const { flag } = require('../flags');

const DEFAULT_INTERVAL_MS = 30000;
// One run processes at most this many clusters before it writes the watermark
// and hands the rest to the next run (~120 * ~7s ≈ 15 min). See worker.js.
const DEFAULT_MAX_CLUSTERS_PER_RUN = 120;

/**
 * @param {{
 *   bankId: string,
 *   foundation?: object,
 *   cognition: object,
 *   providerStore?: object,
 *   syncEpisode?: (episode: object) => Promise<object|void>,
 *   env?: NodeJS.ProcessEnv,
 *   intervalMs?: number,
 *   logger?: object,
 *   fetchImpl?: Function,
 * }} deps
 * @returns {{ start: () => void, stop: () => void, runOnce: () => Promise<object>, enabled: boolean }|null}
 */
const PASS = 'kairos-worker'; // the name it answers to in GET /admin/api/scans

function createKairosRuntime({
  bankId,
  foundation,
  cognition,
  providerStore,
  syncEpisode,
  env = process.env,
  intervalMs = Number(env.GAIA_KAIROS_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  logger = console,
  fetchImpl = fetch,
  now = Date.now,
  registry = null,
} = {}) {
  if (!flag(env, 'GAIA_KAIROS_ENABLED', { default: false })) {
    registry?.declare(PASS, { enabled: false, reason: 'GAIA_KAIROS_ENABLED is off (default)' });
    return null;
  }
  if (!foundation || typeof foundation.listObservationsSince !== 'function') {
    logger.warn?.('[kairos] not started: Foundation read seam unavailable');
    registry?.declare(PASS, { enabled: false, reason: 'Foundation read seam unavailable' });
    return null;
  }
  if (!cognition || typeof cognition.createKairosEpisode !== 'function') {
    logger.warn?.('[kairos] not started: Cognition client unavailable');
    registry?.declare(PASS, { enabled: false, reason: 'Cognition client unavailable' });
    return null;
  }
  registry?.declare(PASS, { enabled: true, intervalMs });

  const synthesizer = createSynthesizer({
    resolveConfig: () => resolveRoleConfig('kairos', providerStore, env),
    fetchImpl,
    logger,
  });

  const worker = createKairosWorker({
    bankId,
    maxClustersPerRun:
      Number(env.GAIA_KAIROS_MAX_CLUSTERS_PER_RUN) || DEFAULT_MAX_CLUSTERS_PER_RUN,
    readWatermark: () => cognition.getKairosState(),
    writeWatermark: (iso) => cognition.setKairosState(iso),
    fetchObservations: (since) => foundation.listObservationsSince(since),
    synthesize: (cluster, bank) => synthesizer.synthesize(cluster, bank),
    saveEpisode: async (episode) => {
      await cognition.createKairosEpisode(episode);
      // Mirror into Hindsight (the derived store), best-effort — a mirror
      // failure must never block the episode itself.
      if (syncEpisode) {
        try {
          await syncEpisode(episode);
        } catch (error) {
          logger.warn?.(`[kairos] hindsight mirror failed for ${episode.id}: ${error.message}`);
        }
      }
    },
    // Skip a cluster whose episode already exists (no second model call): a
    // conservative watermark re-fetches observations, never re-spends tokens.
    episodeIdFor: (clusterId) => episodeIdFor(bankId, clusterId),
    readEpisode: async (id) => {
      if (!cognition || typeof cognition.getKairosEpisode !== 'function') return null;
      try {
        return await cognition.getKairosEpisode(id);
      } catch (_) {
        return null; // 404 (not synthesized yet) or an unreachable store.
      }
    },
    emit: emitEpisode,
    logger,
  });

  let timer = null;
  let running = false;

  async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    try {
      return await worker.runOnce();
    } catch (error) {
      logger.error?.(`[kairos] run failed: ${error.message}`);
      return { error: error.message };
    } finally {
      running = false;
    }
  }

  /**
   * One run, recorded — the timer and a hand-asked run both go through here, so
   * `GET /admin/api/scans` can show what this pass last did. The re-entrancy
   * answer (`{ skipped: true }`) is not a run and is not recorded.
   */
  async function pass() {
    const at = now();
    const result = await runOnce();
    if (!(result && result.skipped === true)) registry?.record(PASS, { at, durationMs: now() - at, result });
    return result;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void pass(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    void pass();
    logger.info?.(`[kairos] worker started for bank ${bankId} (every ${intervalMs}ms)`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce: pass, enabled: true };
}

module.exports = { createKairosRuntime, DEFAULT_INTERVAL_MS };
