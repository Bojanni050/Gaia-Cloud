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
 * @param {{
 *   store?: ReturnType<import('./intentModelStore').createIntentModelStore>,
 *   providerStore?: ReturnType<import('../providerStore').createProviderStore>,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 * @returns {{ baseUrl: string, model: string, authToken: string }}
 */
function resolveIntentModelConfig(options = {}) {
  const env = options.env || process.env;
  const envConfig = readIntentModelConfig(env);

  const stored = options.store ? options.store.getConfig() : null;

  // "Use the main provider" — borrow providerStore.js's shared credentials
  // instead of requiring a second copy of the same API key.
  if (stored && stored.useMainProvider) {
    const main = options.providerStore ? options.providerStore.getConfig() : null;
    if (main && main.apiKey) {
      return {
        baseUrl: main.baseUrl || '',
        model: stored.model || '',
        authToken: main.apiKey,
      };
    }
  }

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
