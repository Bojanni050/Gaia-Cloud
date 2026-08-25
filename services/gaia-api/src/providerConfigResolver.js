'use strict';

/**
 * Resolves model configurations for each role (Generation, Reasoning,
 * Vision) from the provider store's persisted role selections, and TTS
 * independently from its own config.
 *
 * Falls back to env vars when no provider store config exists, preserving
 * backwards compatibility with GAIA_NATIVE_*, REASONIQ_MODEL_*, and
 * GAIA_TTS_* environment variables.
 */

/**
 * Resolve the configuration for a specific role.
 * @param {"generation"|"reasoning"|"vision"} role
 * @param {{ getConfig: Function }} providerStore
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, model: string, apiKey: string, provider: string }|null}
 */
function resolveRoleConfig(role, providerStore, env = process.env) {
  const stored = providerStore ? providerStore.getConfig() : null;

  // If the provider store has a configured provider with an apiKey, use it
  if (stored && stored.apiKey && stored.provider) {
    const roles = stored.roles || {};
    const selection = roles[role];
    if (selection && selection.model) {
      return {
        provider: stored.provider,
        baseUrl: stored.baseUrl || '',
        model: selection.model,
        apiKey: stored.apiKey,
      };
    }
  }

  // Fall back to environment variables for backwards compatibility
  return resolveEnvFallback(role, env);
}

/**
 * Resolve TTS configuration — fully independent from the main provider.
 * @param {{ getConfig: Function }} providerStore
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, model: string, apiKey: string, provider: string }|null}
 */
function resolveTtsConfig(providerStore, env = process.env) {
  const stored = providerStore ? providerStore.getConfig() : null;

  if (stored && stored.tts && stored.tts.provider && stored.tts.model) {
    return {
      provider: stored.tts.provider,
      baseUrl: stored.tts.baseUrl || '',
      model: stored.tts.model,
      apiKey: stored.tts.apiKey || '',
    };
  }

  // Fall back to environment variables
  if (env.GAIA_TTS_BASE_URL && env.GAIA_TTS_MODEL) {
    return {
      provider: 'env',
      baseUrl: env.GAIA_TTS_BASE_URL,
      model: env.GAIA_TTS_MODEL,
      apiKey: env.GAIA_TTS_AUTH_TOKEN || '',
    };
  }
  return null;
}

/**
 * Environment variable fallback — preserves existing .env-based config
 * when no provider store config exists.
 */
function resolveEnvFallback(role, env) {
  switch (role) {
    case 'generation':
      if (env.GAIA_NATIVE_BASE_URL && env.GAIA_NATIVE_MODEL) {
        return {
          provider: 'env',
          baseUrl: env.GAIA_NATIVE_BASE_URL,
          model: env.GAIA_NATIVE_MODEL,
          apiKey: env.GAIA_NATIVE_AUTH_TOKEN || '',
        };
      }
      return null;

    case 'reasoning':
      if (env.REASONIQ_MODEL_BASE_URL && env.REASONIQ_MODEL_NAME) {
        return {
          provider: env.REASONIQ_MODEL_PROVIDER || 'env',
          baseUrl: env.REASONIQ_MODEL_BASE_URL,
          model: env.REASONIQ_MODEL_NAME,
          apiKey: env.REASONIQ_MODEL_API_KEY || '',
        };
      }
      return null;

    case 'vision':
      return resolveEnvFallback('reasoning', env);

    default:
      return null;
  }
}

/**
 * Derive capability availability from the provider store's role selections.
 * @param {{ getConfig: Function }} providerStore
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ generation: boolean, reasoning: boolean, vision: boolean, tts: boolean }}
 */
function deriveCapabilities(providerStore, env = process.env) {
  return {
    generation: resolveRoleConfig('generation', providerStore, env) !== null,
    reasoning: resolveRoleConfig('reasoning', providerStore, env) !== null,
    vision: resolveRoleConfig('vision', providerStore, env) !== null,
    tts: resolveTtsConfig(providerStore, env) !== null,
  };
}

module.exports = { resolveRoleConfig, resolveTtsConfig, resolveEnvFallback, deriveCapabilities };
