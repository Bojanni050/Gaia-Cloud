'use strict';

/**
 * Gaia's listening activity log — the last N transcription attempts, newest
 * first, for the admin surface (GET /admin/api/stt/log).
 *
 * The same posture as ttsLog.js — clients get calm, generic failures and
 * operators get facts — with one hard difference: **this log never carries
 * what was said.** An utterance is the user's own voice, and a transcript is
 * the user's own words; neither belongs in an operator diagnostic. Entries
 * record provider, model, how many audio bytes arrived, how long the call
 * took and how it ended — nothing else. `record` strips any field that could
 * carry audio or text, so a careless caller cannot leak it by accident.
 * In-memory only (a restart clears it).
 */

const { createTtsLog, DEFAULT_MAX_ENTRIES } = require('./ttsLog');

// Fields that could hold the user's voice or words. Dropped on record, always.
const FORBIDDEN = ['text', 'transcript', 'preview', 'audio', 'body', 'input', 'content'];

/**
 * @param {{ maxEntries?: number }} [options]
 * @returns {{ record: (entry: object) => object, list: () => object[], clear: () => void }}
 */
function createSttLog(options = {}) {
  const log = createTtsLog(options);

  function record(entry) {
    const safe = { ...entry };
    for (const key of FORBIDDEN) delete safe[key];
    return log.record(safe);
  }

  return { record, list: log.list, clear: log.clear };
}

module.exports = { createSttLog, DEFAULT_MAX_ENTRIES };
