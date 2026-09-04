'use strict';

/**
 * Persisted configuration for IntentIQ's semantic-classification model —
 * the runtime-writable, admin-surface counterpart to intentModelClient.js's
 * GAIA_INTENT_* env vars (see intentModelConfigResolver.js for how the two
 * combine). Mirrors reasoningModelStore.js's shape and reasoning
 * deliberately, so the admin panel's "pick a provider, save a key, fetch
 * models, choose one" flow works identically for both — see admin.html's
 * IntentIQ section.
 *
 * Stored as a single JSON file, same convention as reasoningModelStore.js/
 * providerStore.js. The API key is never logged and never returned
 * verbatim by getMaskedConfig().
 */

const fs = require('fs');
const path = require('path');
const { maskKey } = require('./reasoningModelStore');

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

  /** @returns {{ provider: string, baseUrl: string, model: string, apiKey: string, updatedAt: string }|null} */
  function getConfig() {
    return readRaw();
  }

  /**
   * Merges and persists a partial update. `apiKey` is optional on update —
   * omitting it (vs. passing an empty string) keeps the previously stored
   * key, so re-saving a model choice never requires re-entering the key
   * (same convention as reasoningModelStore.js's saveConfig).
   * @param {{ provider?: string, baseUrl?: string, model?: string, apiKey?: string }} partial
   */
  function saveConfig(partial) {
    const current = readRaw() || { provider: '', baseUrl: '', model: '', apiKey: '' };
    const next = {
      provider: partial.provider !== undefined ? partial.provider : current.provider,
      baseUrl: partial.baseUrl !== undefined ? partial.baseUrl : current.baseUrl,
      model: partial.model !== undefined ? partial.model : current.model,
      apiKey: partial.apiKey !== undefined ? partial.apiKey : current.apiKey,
      updatedAt: new Date().toISOString(),
    };
    writeRaw(next);
    return next;
  }

  /** Safe to return to a client — the raw key never leaves this module. */
  function getMaskedConfig() {
    const config = readRaw();
    if (!config) {
      return { provider: null, baseUrl: null, model: null, hasApiKey: false, maskedApiKey: null, updatedAt: null };
    }
    return {
      provider: config.provider || null,
      baseUrl: config.baseUrl || null,
      model: config.model || null,
      hasApiKey: Boolean(config.apiKey),
      maskedApiKey: maskKey(config.apiKey),
      updatedAt: config.updatedAt || null,
    };
  }

  function clear() {
    try {
      fs.unlinkSync(storePath);
    } catch (_) { /* already gone */ }
  }

  return { getConfig, saveConfig, getMaskedConfig, clear, storePath };
}

module.exports = { createIntentModelStore, resolveStorePath };
