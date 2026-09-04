'use strict';

/**
 * Combines the persisted admin override (intentModelStore.js) with the
 * GAIA_INTENT_* env vars into the single config intentModelClient.js
 * needs. Mirrors reasoningModelConfigResolver.js: the stored model id —
 * set through the admin surface — wins whenever one is saved; baseUrl and
 * authToken always come from env, since intentModelStore.js never
 * persists those (see its own header comment for why).
 */

const { readIntentModelConfig } = require('./intentModelClient');

/**
 * @param {{ store?: ReturnType<import('./intentModelStore').createIntentModelStore>, env?: NodeJS.ProcessEnv }} [options]
 */
function resolveIntentModelConfig(options = {}) {
  const env = options.env || process.env;
  const envConfig = readIntentModelConfig(env);

  const stored = options.store ? options.store.getConfig() : null;
  if (stored && stored.model) {
    return { ...envConfig, model: stored.model };
  }
  return envConfig;
}

module.exports = { resolveIntentModelConfig };
