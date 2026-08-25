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
 *       tts:        { mode: "catalog"|"manual", model: "..." },
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
  tts: { mode: 'catalog', model: '' },
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
    const current = readRaw() || { provider: '', baseUrl: '', apiKey: '', catalog: [], catalogRetrievedAt: null, roles: { ...DEFAULT_ROLES } };
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
    const current = readRaw() || { provider: '', baseUrl: '', apiKey: '', roles: { ...DEFAULT_ROLES } };
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
    const current = readRaw() || { provider: '', baseUrl: '', apiKey: '', catalog: [], catalogRetrievedAt: null, roles: { ...DEFAULT_ROLES } };
    const roles = { ...current.roles, [role]: { mode: selection.mode || 'catalog', model: selection.model || '' } };
    const next = {
      ...current,
      roles,
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
        updatedAt: null,
      };
    }
    return {
      provider: config.provider || null,
      baseUrl: config.baseUrl || null,
      hasApiKey: Boolean(config.apiKey),
      maskedApiKey: maskKey(config.apiKey),
      catalog: Array.isArray(config.catalog) ? config.catalog : [],
      catalogRetrievedAt: config.catalogRetrievedAt || null,
      roles: { ...DEFAULT_ROLES, ...(config.roles || {}) },
      updatedAt: config.updatedAt || null,
    };
  }

  function clear() {
    try {
      fs.unlinkSync(storePath);
    } catch (_) { /* already gone */ }
  }

  return { getConfig, saveProviderConfig, saveCatalog, saveRoleSelection, getMaskedConfig, clear, storePath };
}

module.exports = { createProviderStore, resolveStorePath, maskKey, DEFAULT_ROLES };
