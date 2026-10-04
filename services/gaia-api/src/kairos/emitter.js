'use strict';

/**
 * One in-process event emitter for freshly synthesized Kairos episodes. The
 * worker emits here; the SSE route (kairosRoutes.js) subscribes here. Kept as
 * a single shared module so both sides reference the same bus without the
 * server having to thread it through — and so the SSE route can live in the
 * same process as the worker.
 */
const { EventEmitter } = require('events');

const episodeEvents = new EventEmitter();
episodeEvents.setMaxListeners(0); // one listener per connected SSE client

const EPISODE_EVENT = 'kairos:episode';

function emitEpisode(episode) {
  if (episode) episodeEvents.emit(EPISODE_EVENT, episode);
}

function onEpisode(handler) {
  episodeEvents.on(EPISODE_EVENT, handler);
  return () => episodeEvents.off(EPISODE_EVENT, handler);
}

module.exports = { episodeEvents, EPISODE_EVENT, emitEpisode, onEpisode };
