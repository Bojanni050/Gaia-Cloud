'use strict';

/**
 * Gaia's voice activity log — the last N speech-synthesis attempts,
 * newest first, for the admin surface (GET /admin/api/tts/log).
 *
 * TTS is deliberately fire-and-forget toward clients: the desktop
 * swallows speech failures so a silent voice can never break a turn,
 * and POST /speech answers failures with calm, generic wording. That
 * leaves operators blind — "she doesn't speak, and nothing says why".
 * This buffer is the other half of that posture: clients stay calm,
 * operators get facts. In-memory only (a restart clears it): it is a
 * diagnostic tail, not an audit trail — the durable decision log
 * (decisionStore.js) already owns that shape for cognition.
 *
 * Entries never carry secrets: provider, model, and voiceId are already
 * operator-visible via the masked TTS config, and the text preview is a
 * fragment of a reply the server saved in full anyway
 * (conversationStore.js). No apiKey, no endpoint, no stack — ever.
 */

const DEFAULT_MAX_ENTRIES = 50;

/**
 * @param {{ maxEntries?: number }} [options]
 * @returns {{ record: (entry: object) => object, list: () => object[], clear: () => void }}
 */
function createTtsLog({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = [];

  function record(entry) {
    const stored = { at: new Date().toISOString(), ...entry };
    entries.unshift(stored);
    if (entries.length > maxEntries) entries.length = maxEntries;
    return stored;
  }

  function list() {
    return entries.slice();
  }

  function clear() {
    entries.length = 0;
  }

  return { record, list, clear };
}

module.exports = { createTtsLog, DEFAULT_MAX_ENTRIES };
