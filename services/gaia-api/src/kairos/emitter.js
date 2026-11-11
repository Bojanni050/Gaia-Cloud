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
const DIGEST_EVENT = 'kairos:digest';

function emitEpisode(episode) {
  if (episode) episodeEvents.emit(EPISODE_EVENT, episode);
}

function onEpisode(handler) {
  episodeEvents.on(EPISODE_EVENT, handler);
  return () => episodeEvents.off(EPISODE_EVENT, handler);
}

/**
 * A freshly written day overview goes over the same stream as the episodes, so
 * an open Command Center shows it without a reload. Separate event name: the
 * client must not mistake an overview for a card.
 */
function emitDigest(digest) {
  if (digest) episodeEvents.emit(DIGEST_EVENT, digest);
}

function onDigest(handler) {
  episodeEvents.on(DIGEST_EVENT, handler);
  return () => episodeEvents.off(DIGEST_EVENT, handler);
}

module.exports = {
  episodeEvents,
  EPISODE_EVENT,
  DIGEST_EVENT,
  emitEpisode,
  onEpisode,
  emitDigest,
  onDigest,
};
