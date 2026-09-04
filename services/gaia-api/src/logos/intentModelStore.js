'use strict';

/**
 * Persisted runtime override for IntentIQ's semantic-classification model
 * id — the admin-surface counterpart to intentModelClient.js's
 * GAIA_INTENT_MODEL env var (see intentModelConfigResolver.js for how the
 * two combine). Mirrors reasoningModelStore.js's shape and reasoning for
 * why this is runtime-writable state: a chosen model id is operational
 * configuration someone picks through the admin panel, not something that
 * should require a redeploy.
 *
 * Deliberately narrower than reasoningModelStore.js: only the model id is
 * admin-editable here. GAIA_INTENT_BASE_URL/GAIA_INTENT_AUTH_TOKEN stay
 * env-only — they identify which endpoint/account IntentIQ talks to at
 * all, which is still ops-level configuration, not a day-to-day choice
 * the way swapping models is.
 */

const fs = require('fs');
const path = require('path');

function resolveStorePath(env = process.env) {
  if (env.INTENTIQ_CONFIG_PATH) return env.INTENTIQ_CONFIG_PATH;
  const devPath = path.resolve(__dirname, '../../data/intentiq-config.json');
  const containerPath = '/app/data/intentiq-config.json';
  return fs.existsSync('/app') ? containerPath : devPath;
}

/**
 * @param {{ storePath?: string }} [options]
 */
function createIntentModelStore(options = {}) {
  const storePath = options.storePath || resolveStorePath();

  function readRaw() {
    try {
      const text = fs.readFileSync(storePath, 'utf-8');
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function writeRaw(data) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** @returns {{ model: string, updatedAt: string }|null} */
  function getConfig() {
    return readRaw();
  }

  /**
   * @param {{ model: string }} partial `model` empty/blank clears the
   *   override (falls back to GAIA_INTENT_MODEL) rather than persisting
   *   an empty string, so the resolver's "stored wins when non-empty"
   *   check stays simple.
   */
  function saveConfig(partial) {
    const model = typeof partial.model === 'string' ? partial.model.trim() : '';
    if (!model) {
      clear();
      return { model: '', updatedAt: new Date().toISOString() };
    }
    const next = { model, updatedAt: new Date().toISOString() };
    writeRaw(next);
    return next;
  }

  function getMaskedConfig() {
    const config = readRaw();
    return { model: (config && config.model) || null, updatedAt: (config && config.updatedAt) || null };
  }

  function clear() {
    try {
      fs.unlinkSync(storePath);
    } catch (_) { /* already gone */ }
  }

  return { getConfig, saveConfig, getMaskedConfig, clear, storePath };
}

module.exports = { createIntentModelStore, resolveStorePath };
