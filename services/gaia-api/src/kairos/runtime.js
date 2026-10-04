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
const { createSynthesizer } = require('./synthesizer');
const { emitEpisode } = require('./emitter');
const { resolveRoleConfig } = require('../providerConfigResolver');

const DEFAULT_INTERVAL_MS = 30000;

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
} = {}) {
  if ((env.GAIA_KAIROS_ENABLED || 'false') !== 'true') return null;
  if (!foundation || typeof foundation.listObservationsSince !== 'function') {
    logger.warn?.('[kairos] not started: Foundation read seam unavailable');
    return null;
  }
  if (!cognition || typeof cognition.createKairosEpisode !== 'function') {
    logger.warn?.('[kairos] not started: Cognition client unavailable');
    return null;
  }

  const synthesizer = createSynthesizer({
    resolveConfig: () => resolveRoleConfig('kairos', providerStore, env),
    fetchImpl,
    logger,
  });

  const worker = createKairosWorker({
    bankId,
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

  function start() {
    if (timer) return;
    timer = setInterval(() => { void runOnce(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    void runOnce();
    logger.info?.(`[kairos] worker started for bank ${bankId} (every ${intervalMs}ms)`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce, enabled: true };
}

module.exports = { createKairosRuntime, DEFAULT_INTERVAL_MS };
