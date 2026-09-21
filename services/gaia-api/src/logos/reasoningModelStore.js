'use strict';

/**
 * Persisted configuration for ReasonIQ's reasoning model — the runtime-
 * configurable counterpart to reasoningModelClient.js's REASONIQ_MODEL_*
 * env vars (see reasoningModelConfigResolver.js for how the two combine).
 *
 * This is deliberately the only piece of runtime-writable state gaia-api
 * holds. It exists because an OpenRouter API key and a chosen model are
 * operational configuration a person sets once through the admin surface
 * (see adminRoutes.js), not something that should require a redeploy —
 * unlike SOUL or the foundation documents, which change deliberately and
 * are meant to require one (docs/evolution.md's "the friction of editing
 * SOUL is itself a feature" reasoning does not apply to an API key).
 *
 * Stored as a single JSON file, not a database — gaia-api has no database
 * today and this is one small record, not a table. The file must live on
 * a persistent volume in production (see docker-compose.yml) or the key
 * is lost on every redeploy, same caveat as any other untracked .env.
 *
 * The API key is never logged, never returned verbatim by getMasked(),
 * and never appears in any Logos dev-log line (reasonLog.js only ever
 * sees the resolved client, never this store).
 */

const fs = require('fs');
const path = require('path');

function resolveStorePath(env = process.env) {
  if (env.REASONIQ_CONFIG_PATH) return env.REASONIQ_CONFIG_PATH;
  // Dev: services/gaia-api/src/logos -> services/gaia-api/data/reasoniq-config.json
  const devPath = path.resolve(__dirname, '../../data/reasoniq-config.json');
  // Container: a mounted volume at /app/data (see docker-compose.yml's comment on this).
  const containerPath = '/app/data/reasoniq-config.json';
  return fs.existsSync('/app') ? containerPath : devPath;
}

function maskKey(apiKey) {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return '••••';
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

/**
 * @param {{ storePath?: string }} [options]
 */
function createReasoningModelStore(options = {}) {
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

  /** @returns {{ provider: string, baseUrl: string, model: string, visionModel: string, apiKey: string, updatedAt: string }|null} */
  function getConfig() {
    return readRaw();
  }

  /**
   * Merges and persists a partial update. `apiKey` is optional on update —
   * omitting it (vs. passing an empty string) keeps the previously stored
   * key, so re-saving a model choice never requires re-entering the key.
   * `visionModel` is a separate model id used only for image OCR
   * (ocrResolver.js) — same provider/baseUrl/apiKey as `model`, since
   * there's no reason to assume a second OpenRouter account for it.
   * Falls back to `model` wherever it's left unset (see
   * reasoningModelConfigResolver.js's resolveVisionModelConfig).
   * `useMainProvider` borrows providerStore.js's shared provider/baseUrl/
   * apiKey instead of requiring a second copy of the same credentials —
   * see reasoningModelConfigResolver.js for how the two combine.
   * @param {{ provider?: string, baseUrl?: string, model?: string, visionModel?: string, apiKey?: string, useMainProvider?: boolean }} partial
   */
  function saveConfig(partial) {
    const current = readRaw() || { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', visionModel: '', apiKey: '', useMainProvider: false };
    const next = {
      provider: partial.provider !== undefined ? partial.provider : current.provider,
      baseUrl: partial.baseUrl !== undefined ? partial.baseUrl : current.baseUrl,
      model: partial.model !== undefined ? partial.model : current.model,
      visionModel: partial.visionModel !== undefined ? partial.visionModel : (current.visionModel || ''),
      apiKey: partial.apiKey !== undefined ? partial.apiKey : current.apiKey,
      useMainProvider: partial.useMainProvider !== undefined ? Boolean(partial.useMainProvider) : Boolean(current.useMainProvider),
      updatedAt: new Date().toISOString(),
    };
    writeRaw(next);
    return next;
  }

  /** Safe to return to a client — the raw key never leaves this module. */
  function getMaskedConfig() {
    const config = readRaw();
    if (!config) {
      return { provider: null, baseUrl: null, model: null, visionModel: null, hasApiKey: false, maskedApiKey: null, useMainProvider: false, updatedAt: null };
    }
    return {
      provider: config.provider || null,
      baseUrl: config.baseUrl || null,
      model: config.model || null,
      visionModel: config.visionModel || null,
      hasApiKey: Boolean(config.apiKey),
      maskedApiKey: maskKey(config.apiKey),
      useMainProvider: Boolean(config.useMainProvider),
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

module.exports = { createReasoningModelStore, resolveStorePath, maskKey };
