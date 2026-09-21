'use strict';

/**
 * Combines the persisted admin config (reasoningModelStore.js) with the
 * REASONIQ_MODEL_* env vars into the single config
 * reasoningModelClient.js needs. The stored config — set through the
 * admin surface — wins whenever it has an API key; env vars remain the
 * ops-level fallback/override for deployments that would rather manage
 * this the same way HERMES_* is managed (.env only, no admin surface).
 */

const { readReasoningModelConfig } = require('./reasoningModelClient');

/**
 * @param {{
 *   store?: ReturnType<import('./reasoningModelStore').createReasoningModelStore>,
 *   providerStore?: ReturnType<import('../providerStore').createProviderStore>,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 */
function resolveReasoningModelConfig(options = {}) {
  const env = options.env || process.env;
  const envConfig = readReasoningModelConfig(env);

  const stored = options.store ? options.store.getConfig() : null;

  // "Use the main provider" — the admin surface's shared Provider config
  // (providerStore.js), credentials borrowed rather than duplicated. Only
  // the model choice stays ReasonIQ's own.
  if (stored && stored.useMainProvider) {
    const main = options.providerStore ? options.providerStore.getConfig() : null;
    if (main && main.apiKey) {
      return {
        provider: main.provider || 'openrouter',
        baseUrl: main.baseUrl || 'https://openrouter.ai/api/v1',
        model: stored.model || '',
        apiKey: main.apiKey,
      };
    }
  }

  if (stored && stored.apiKey) {
    return {
      provider: stored.provider || 'openrouter',
      baseUrl: stored.baseUrl || 'https://openrouter.ai/api/v1',
      model: stored.model || '',
      apiKey: stored.apiKey,
    };
  }

  return envConfig;
}

/**
 * Same resolution as resolveReasoningModelConfig, but for OCR/vision
 * (ocrResolver.js) — same provider/baseUrl/apiKey (no reason to assume a
 * second OpenRouter account), but the model id comes from the stored
 * config's `visionModel`, falling back to the main `model` when
 * `visionModel` hasn't been set. There is no vision-specific env var —
 * REASONIQ_MODEL_* alone has no vision/text distinction to make, so the
 * env fallback path (no admin config saved yet) just reuses whatever
 * ReasonIQ itself would use.
 * @param {{ store?: ReturnType<import('./reasoningModelStore').createReasoningModelStore>, env?: NodeJS.ProcessEnv }} [options]
 */
function resolveVisionModelConfig(options = {}) {
  const base = resolveReasoningModelConfig(options);
  const stored = options.store ? options.store.getConfig() : null;
  // base.apiKey (not stored.apiKey) so this also applies when the
  // credentials came from useMainProvider rather than the store's own key.
  if (stored && base.apiKey && stored.visionModel) {
    return { ...base, model: stored.visionModel };
  }
  return base;
}

module.exports = { resolveReasoningModelConfig, resolveVisionModelConfig };
