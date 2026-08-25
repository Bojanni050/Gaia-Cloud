'use strict';

/**
 * Persisted configuration for the single model provider and four
 * role-based model selections (Generation, Reasoning, Vision, TTS).
 *
 * Follows the same persistence pattern as reasoningModelStore.js —
 * a single JSON file, runtime-writable via the admin surface, never
 * leaking API keys to clients.
 *
 * Stored data shape:
 *   {
 *     provider: "edenai" | "openrouter" | ...,
 *     baseUrl: "https://...",
 *     apiKey: "...",
 *     catalog: [ { id, name, capabilities: [...] } ],
 *     catalogRetrievedAt: ISO timestamp,
 *     roles: {
 *       generation: { mode: "catalog"|"manual", model: "..." },
 *       reasoning:  { mode: "catalog"|"manual", model: "..." },
 *       vision:     { mode: "catalog"|"manual", model: "..." },
 *     },
 *     tts: {
 *       provider: "...",
 *       baseUrl: "...",
 *       apiKey: "...",
 *       model: "...",
 *     },
 *     updatedAt: ISO timestamp,
 *   }
 *
 * API keys never appear in getMaskedConfig(), logs, or client output.
 */

const fs = require('fs');
const path = require('path');

function resolveStorePath(env = process.env) {
  if (env.GAIA_PROVIDER_CONFIG_PATH) return env.GAIA_PROVIDER_CONFIG_PATH;
  const devPath = path.resolve(__dirname, '../data/provider-config.json');
  const containerPath = '/app/data/provider-config.json';
  return fs.existsSync('/app') ? containerPath : devPath;
}

function maskKey(apiKey) {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return '••••';
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

const DEFAULT_ROLES = Object.freeze({
  generation: { mode: 'catalog', model: '' },
  reasoning: { mode: 'catalog', model: '' },
  vision: { mode: 'catalog', model: '' },
});

const DEFAULT_TTS = Object.freeze({
  provider: '',
  baseUrl: '',
  apiKey: '',
  model: '',
});

/**
 * @param {{ storePath?: string }} [options]
 */
function createProviderStore(options = {}) {
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

  /** @returns {object|null} full stored config including raw apiKey */
  function getConfig() {
    return readRaw();
  }

  /**
   * Save provider configuration (provider, baseUrl, apiKey).
   * apiKey is optional — omitting it keeps the previously stored key.
   */
  function saveProviderConfig(partial) {
    const current = readRaw() || { provider: '', baseUrl: '', apiKey: '', catalog: [], catalogRetrievedAt: null, roles: { ...DEFAULT_ROLES }, tts: { ...DEFAULT_TTS } };
    const next = {
      ...current,
      provider: partial.provider !== undefined ? partial.provider : current.provider,
      baseUrl: partial.baseUrl !== undefined ? partial.baseUrl : current.baseUrl,
      apiKey: partial.apiKey !== undefined ? partial.apiKey : current.apiKey,
      updatedAt: new Date().toISOString(),
    };
    writeRaw(next);
    return next;
  }

  /**
   * Save the model catalog (result of Retrieve Models).
   * Replaces the entire catalog; does not touch provider/roles.
   */
  function saveCatalog(catalog, retrievedAt) {
    const current = readRaw() || { provider: '', baseUrl: '', apiKey: '', roles: { ...DEFAULT_ROLES }, tts: { ...DEFAULT_TTS } };
    const next = {
      ...current,
      catalog: Array.isArray(catalog) ? catalog : [],
      catalogRetrievedAt: retrievedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeRaw(next);
    return next;
  }

  /**
   * Save a role selection (generation, reasoning, vision, or tts).
   * @param {"generation"|"reasoning"|"vision"|"tts"} role
   * @param {{ mode: "catalog"|"manual", model: string }} selection
   */
  function saveRoleSelection(role, selection) {
    if (!DEFAULT_ROLES.hasOwnProperty(role)) {
      throw new Error(`unknown role: ${role}`);
    }
    const current = readRaw() || { provider: '', baseUrl: '', apiKey: '', catalog: [], catalogRetrievedAt: null, roles: { ...DEFAULT_ROLES }, tts: { ...DEFAULT_TTS } };
    const roles = { ...current.roles, [role]: { mode: selection.mode || 'catalog', model: selection.model || '' } };
    const next = {
      ...current,
      roles,
      updatedAt: new Date().toISOString(),
    };
    writeRaw(next);
    return next;
  }

  /**
   * Save independent TTS configuration (provider, baseUrl, apiKey, model).
   * TTS is fully independent from the main provider — can be a different
   * provider with its own API key.
   * @param {{ provider?: string, baseUrl?: string, apiKey?: string, model?: string }} partial
   */
  function saveTtsConfig(partial) {
    const current = readRaw() || { provider: '', baseUrl: '', apiKey: '', catalog: [], catalogRetrievedAt: null, roles: { ...DEFAULT_ROLES }, tts: { ...DEFAULT_TTS } };
    const currentTts = current.tts || { ...DEFAULT_TTS };
    const next = {
      ...current,
      tts: {
        provider: partial.provider !== undefined ? partial.provider : currentTts.provider,
        baseUrl: partial.baseUrl !== undefined ? partial.baseUrl : currentTts.baseUrl,
        apiKey: partial.apiKey !== undefined ? partial.apiKey : currentTts.apiKey,
        model: partial.model !== undefined ? partial.model : currentTts.model,
      },
      updatedAt: new Date().toISOString(),
    };
    writeRaw(next);
    return next;
  }

  /** Safe to return to a client — raw key never leaves this module. */
  function getMaskedConfig() {
    const config = readRaw();
    if (!config) {
      return {
        provider: null, baseUrl: null, hasApiKey: false, maskedApiKey: null,
        catalog: [], catalogRetrievedAt: null,
        roles: { ...DEFAULT_ROLES },
        tts: { ...DEFAULT_TTS, hasApiKey: false, maskedApiKey: null },
        updatedAt: null,
      };
    }
    const tts = config.tts || { ...DEFAULT_TTS };
    return {
      provider: config.provider || null,
      baseUrl: config.baseUrl || null,
      hasApiKey: Boolean(config.apiKey),
      maskedApiKey: maskKey(config.apiKey),
      catalog: Array.isArray(config.catalog) ? config.catalog : [],
      catalogRetrievedAt: config.catalogRetrievedAt || null,
      roles: { ...DEFAULT_ROLES, ...(config.roles || {}) },
      tts: {
        provider: tts.provider || '',
        baseUrl: tts.baseUrl || '',
        model: tts.model || '',
        hasApiKey: Boolean(tts.apiKey),
        maskedApiKey: maskKey(tts.apiKey),
      },
      updatedAt: config.updatedAt || null,
    };
  }

  function clear() {
    try {
      fs.unlinkSync(storePath);
    } catch (_) { /* already gone */ }
  }

  return { getConfig, saveProviderConfig, saveCatalog, saveRoleSelection, saveTtsConfig, getMaskedConfig, clear, storePath };
}

module.exports = { createProviderStore, resolveStorePath, maskKey, DEFAULT_ROLES, DEFAULT_TTS };
