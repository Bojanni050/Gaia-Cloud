'use strict';

/**
 * Combines the persisted admin config (intentModelStore.js) with the
 * GAIA_INTENT_* env vars into the single config intentModelClient.js
 * needs. Mirrors reasoningModelConfigResolver.js: the stored config — set
 * through the admin surface — wins whenever it has an API key; env vars
 * remain the ops-level fallback for deployments that would rather manage
 * this via .env only, with no admin surface involved.
 */

const { readIntentModelConfig } = require('./intentModelClient');

/**
 * @param {{ store?: ReturnType<import('./intentModelStore').createIntentModelStore>, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ baseUrl: string, model: string, authToken: string }}
 */
function resolveIntentModelConfig(options = {}) {
  const env = options.env || process.env;
  const envConfig = readIntentModelConfig(env);

  const stored = options.store ? options.store.getConfig() : null;
  if (stored && stored.apiKey) {
    return {
      baseUrl: stored.baseUrl || '',
      model: stored.model || '',
      authToken: stored.apiKey,
    };
  }

  return envConfig;
}

module.exports = { resolveIntentModelConfig };
