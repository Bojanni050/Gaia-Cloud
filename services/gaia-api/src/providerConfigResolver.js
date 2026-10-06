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

  // A role with its own custom provider wins outright — it names its own
  // endpoint, key and model, so the Main Provider's catalog is irrelevant.
  const roleProvider = stored && stored.roleProviders ? stored.roleProviders[role] : null;
  if (roleProvider && roleProvider.useMainProvider === false && roleProvider.baseUrl && roleProvider.model) {
    return {
      provider: roleProvider.provider || 'custom',
      baseUrl: roleProvider.baseUrl,
      model: roleProvider.model,
      apiKey: roleProvider.apiKey || '',
    };
  }

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
 * Resolve TTS configuration — independent from the main provider by
 * default, but `tts.useMainProvider` borrows the same provider's own
 * provider/baseUrl/apiKey instead of requiring a second copy of it.
 * @param {{ getConfig: Function }} providerStore
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, model: string, apiKey: string, provider: string, voiceId: string }|null}
 */
function resolveTtsConfig(providerStore, env = process.env) {
  const stored = providerStore ? providerStore.getConfig() : null;

  if (stored && stored.tts && stored.tts.useMainProvider && stored.tts.model && stored.apiKey) {
    return {
      provider: stored.provider || 'openrouter',
      baseUrl: stored.baseUrl || '',
      model: stored.tts.model,
      apiKey: stored.apiKey,
      voiceId: stored.tts.voiceId || '',
    };
  }

  if (stored && stored.tts && stored.tts.provider && stored.tts.model) {
    return {
      provider: stored.tts.provider,
      baseUrl: stored.tts.baseUrl || '',
      model: stored.tts.model,
      apiKey: stored.tts.apiKey || '',
      voiceId: stored.tts.voiceId || '',
    };
  }

  // Fall back to environment variables
  if (env.GAIA_TTS_BASE_URL && env.GAIA_TTS_MODEL) {
    return {
      provider: 'env',
      baseUrl: env.GAIA_TTS_BASE_URL,
      model: env.GAIA_TTS_MODEL,
      apiKey: env.GAIA_TTS_AUTH_TOKEN || '',
      voiceId: env.GAIA_TTS_VOICE_ID || '',
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

    case 'kairos':
      // The episode synthesizer (Logos's younger sibling). Independent of the
      // reasoning role: an operator may point Kairos at a cheaper/faster model.
      if (env.KAIROS_MODEL_BASE_URL && env.KAIROS_MODEL_NAME) {
        return {
          provider: env.KAIROS_MODEL_PROVIDER || 'env',
          baseUrl: env.KAIROS_MODEL_BASE_URL,
          model: env.KAIROS_MODEL_NAME,
          apiKey: env.KAIROS_MODEL_API_KEY || '',
        };
      }
      return null;

    case 'selfmemory':
      // Gaia's own-memory pass (reasoning/selfMemory.js). Independent of the
      // reasoning role so an operator can point it at its own model; falls
      // back to the reasoning role when no dedicated env is set, so it works
      // out of the box.
      if (env.SELFMEMORY_MODEL_BASE_URL && env.SELFMEMORY_MODEL_NAME) {
        return {
          provider: env.SELFMEMORY_MODEL_PROVIDER || 'env',
          baseUrl: env.SELFMEMORY_MODEL_BASE_URL,
          model: env.SELFMEMORY_MODEL_NAME,
          apiKey: env.SELFMEMORY_MODEL_API_KEY || '',
        };
      }
      return resolveEnvFallback('reasoning', env);

    default:
      return null;
  }
}

/**
 * Resolve the backup generation provider: the independently stored
 * `generationBackup` config first, GAIA_BACKUP_* env vars as fallback.
 * Returns null when no backup is configured. The backup is a plain
 * inference provider — provider priority is config order, never content.
 * @param {{ getConfig: Function }} providerStore
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, model: string, apiKey: string, provider: string }|null}
 */
function resolveBackupConfig(providerStore, env = process.env) {
  const stored = providerStore ? providerStore.getConfig() : null;
  const backup = stored && stored.generationBackup ? stored.generationBackup : null;
  if (backup && backup.baseUrl && backup.model) {
    return {
      provider: backup.provider || 'backup',
      baseUrl: backup.baseUrl,
      model: backup.model,
      apiKey: backup.apiKey || '',
    };
  }
  if (env.GAIA_BACKUP_BASE_URL && env.GAIA_BACKUP_MODEL) {
    return {
      provider: env.GAIA_BACKUP_PROVIDER || 'env-backup',
      baseUrl: env.GAIA_BACKUP_BASE_URL,
      model: env.GAIA_BACKUP_MODEL,
      apiKey: env.GAIA_BACKUP_AUTH_TOKEN || '',
    };
  }
  return null;
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
    kairos: resolveRoleConfig('kairos', providerStore, env) !== null,
    selfmemory: resolveRoleConfig('selfmemory', providerStore, env) !== null,
    tts: resolveTtsConfig(providerStore, env) !== null,
  };
}

module.exports = { resolveRoleConfig, resolveBackupConfig, resolveTtsConfig, resolveEnvFallback, deriveCapabilities };
