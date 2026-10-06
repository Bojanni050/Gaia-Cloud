'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRoleConfig, resolveTtsConfig, resolveEnvFallback, deriveCapabilities } = require('../src/providerConfigResolver');

function createMockStore(config) {
  return { getConfig: () => config };
}

// --- resolveRoleConfig ---

test('resolveRoleConfig: uses provider store config when apiKey is present', () => {
  const store = createMockStore({
    provider: 'edenai',
    baseUrl: 'https://api.edenai.run/v1',
    apiKey: 'sk-eden-secret',
    roles: {
      generation: { mode: 'catalog', model: 'google/gemini-flash' },
      reasoning: { mode: 'manual', model: 'anthropic/claude' },
      vision: { mode: 'catalog', model: '' },
    },
  });
  const config = resolveRoleConfig('generation', store);
  assert.equal(config.provider, 'edenai');
  assert.equal(config.baseUrl, 'https://api.edenai.run/v1');
  assert.equal(config.model, 'google/gemini-flash');
  assert.equal(config.apiKey, 'sk-eden-secret');
});

test('resolveRoleConfig: returns null when role has no model', () => {
  const store = createMockStore({
    provider: 'edenai',
    baseUrl: 'https://api.edenai.run/v1',
    apiKey: 'sk-eden-secret',
    roles: {
      generation: { mode: 'catalog', model: '' },
      reasoning: { mode: 'catalog', model: '' },
      vision: { mode: 'catalog', model: '' },
    },
  });
  assert.equal(resolveRoleConfig('generation', store), null);
});

test('resolveRoleConfig: falls back to env vars when no store config', () => {
  const env = {
    GAIA_NATIVE_BASE_URL: 'https://openrouter.ai/api/v1',
    GAIA_NATIVE_MODEL: 'google/gemini-2.5-flash',
    GAIA_NATIVE_AUTH_TOKEN: 'token',
  };
  const config = resolveRoleConfig('generation', null, env);
  assert.equal(config.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.model, 'google/gemini-2.5-flash');
  assert.equal(config.apiKey, 'token');
});

test('resolveRoleConfig: falls back to env vars when store has no apiKey', () => {
  const store = createMockStore({
    provider: 'edenai',
    baseUrl: 'https://api.edenai.run/v1',
    apiKey: '',
    roles: { generation: { mode: 'catalog', model: 'x' } },
  });
  const env = {
    GAIA_NATIVE_BASE_URL: 'https://openrouter.ai/api/v1',
    GAIA_NATIVE_MODEL: 'google/gemini-2.5-flash',
  };
  const config = resolveRoleConfig('generation', store, env);
  assert.equal(config.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.model, 'google/gemini-2.5-flash');
});

// --- resolveEnvFallback ---

test('resolveEnvFallback: generation reads GAIA_NATIVE_* vars', () => {
  const env = { GAIA_NATIVE_BASE_URL: 'https://x.com/v1', GAIA_NATIVE_MODEL: 'm1', GAIA_NATIVE_AUTH_TOKEN: 't1' };
  const config = resolveEnvFallback('generation', env);
  assert.equal(config.baseUrl, 'https://x.com/v1');
  assert.equal(config.model, 'm1');
  assert.equal(config.apiKey, 't1');
});

test('resolveEnvFallback: generation returns null when vars unset', () => {
  assert.equal(resolveEnvFallback('generation', {}), null);
});

test('resolveEnvFallback: reasoning reads REASONIQ_MODEL_* vars', () => {
  const env = { REASONIQ_MODEL_BASE_URL: 'https://r.com', REASONIQ_MODEL_NAME: 'rm1', REASONIQ_MODEL_API_KEY: 'rk', REASONIQ_MODEL_PROVIDER: 'openrouter' };
  const config = resolveEnvFallback('reasoning', env);
  assert.equal(config.baseUrl, 'https://r.com');
  assert.equal(config.model, 'rm1');
  assert.equal(config.apiKey, 'rk');
  assert.equal(config.provider, 'openrouter');
});

test('resolveEnvFallback: reasoning returns null when vars unset', () => {
  assert.equal(resolveEnvFallback('reasoning', {}), null);
});

test('resolveEnvFallback: vision falls back to reasoning config', () => {
  const env = { REASONIQ_MODEL_BASE_URL: 'https://r.com', REASONIQ_MODEL_NAME: 'rm1' };
  const config = resolveEnvFallback('vision', env);
  assert.equal(config.baseUrl, 'https://r.com');
  assert.equal(config.model, 'rm1');
});

test('resolveEnvFallback: tts reads GAIA_TTS_* vars', () => {
  const env = { GAIA_TTS_BASE_URL: 'https://tts.com', GAIA_TTS_MODEL: 'tts1', GAIA_TTS_AUTH_TOKEN: 'tk' };
  const config = resolveEnvFallback('tts', env);
  // TTS is now handled by resolveTtsConfig, not resolveEnvFallback
  // resolveEnvFallback no longer handles 'tts' case
  assert.equal(config, null);
});

test('resolveEnvFallback: tts returns null when vars unset', () => {
  assert.equal(resolveEnvFallback('tts', {}), null);
});

test('resolveEnvFallback: unknown role returns null', () => {
  assert.equal(resolveEnvFallback('unknown', {}), null);
});

// --- resolveTtsConfig ---

test('resolveTtsConfig: uses provider store TTS config when present', () => {
  const store = createMockStore({
    provider: 'edenai',
    tts: { provider: 'xiaomi', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'tts-key', model: 'mimo-tts' },
  });
  const config = resolveTtsConfig(store);
  assert.equal(config.provider, 'xiaomi');
  assert.equal(config.baseUrl, 'https://api.xiaomimimo.com/v1');
  assert.equal(config.model, 'mimo-tts');
  assert.equal(config.apiKey, 'tts-key');
});

test('resolveTtsConfig: returns null when TTS has no model', () => {
  const store = createMockStore({
    tts: { provider: 'xiaomi', baseUrl: 'https://x', model: '' },
  });
  assert.equal(resolveTtsConfig(store), null);
});

test('resolveTtsConfig: returns null when no TTS config', () => {
  const store = createMockStore({});
  assert.equal(resolveTtsConfig(store), null);
});

test('resolveTtsConfig: falls back to env vars', () => {
  const env = { GAIA_TTS_BASE_URL: 'https://tts.com', GAIA_TTS_MODEL: 'tts1', GAIA_TTS_AUTH_TOKEN: 'tk' };
  const config = resolveTtsConfig(null, env);
  assert.equal(config.provider, 'env');
  assert.equal(config.baseUrl, 'https://tts.com');
  assert.equal(config.model, 'tts1');
  assert.equal(config.apiKey, 'tk');
  assert.equal(config.voiceId, '');
});

test('resolveTtsConfig: passes the stored voiceId through (Mistral), defaulting to empty', () => {
  const withVoice = createMockStore({
    tts: { provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'voxtral-mini-tts-2603', voiceId: 'gaia-voice-1' },
  });
  assert.equal(resolveTtsConfig(withVoice).voiceId, 'gaia-voice-1');
  const withoutVoice = createMockStore({
    tts: { provider: 'xiaomi', baseUrl: 'https://x', model: 'mimo-tts' },
  });
  assert.equal(resolveTtsConfig(withoutVoice).voiceId, '');
  assert.equal(resolveTtsConfig(null, { GAIA_TTS_BASE_URL: 'https://tts.com', GAIA_TTS_MODEL: 'tts1', GAIA_TTS_VOICE_ID: 'env-voice' }).voiceId, 'env-voice');
});

test('resolveTtsConfig: env fallback returns null when vars unset', () => {
  assert.equal(resolveTtsConfig(null, {}), null);
});

// --- deriveCapabilities ---

test('deriveCapabilities: all false when nothing configured', () => {
  const caps = deriveCapabilities(null, {});
  assert.equal(caps.generation, false);
  assert.equal(caps.reasoning, false);
  assert.equal(caps.vision, false);
  assert.equal(caps.tts, false);
});

test('deriveCapabilities: reflects store role selections', () => {
  const store = createMockStore({
    provider: 'edenai',
    baseUrl: 'https://api.edenai.run/v1',
    apiKey: 'sk-secret',
    roles: {
      generation: { mode: 'catalog', model: 'g1' },
      reasoning: { mode: 'manual', model: 'r1' },
      vision: { mode: 'catalog', model: '' },
    },
    tts: { provider: 'xiaomi', model: 't1' },
  });
  const caps = deriveCapabilities(store);
  assert.equal(caps.generation, true);
  assert.equal(caps.reasoning, true);
  assert.equal(caps.vision, false);
  assert.equal(caps.tts, true);
});

test('deriveCapabilities: reflects env vars when no store', () => {
  const env = {
    GAIA_NATIVE_BASE_URL: 'https://x.com',
    GAIA_NATIVE_MODEL: 'm1',
    GAIA_TTS_BASE_URL: 'https://tts.com',
    GAIA_TTS_MODEL: 't1',
  };
  const caps = deriveCapabilities(null, env);
  assert.equal(caps.generation, true);
  assert.equal(caps.reasoning, false);
  assert.equal(caps.vision, false);
  assert.equal(caps.tts, true);
});

// --- resolveBackupConfig (v3.0 failover) ---

const { resolveBackupConfig } = require('../src/providerConfigResolver');

test('resolveBackupConfig: uses the stored backup config when baseUrl and model are set', () => {
  const store = createMockStore({
    generationBackup: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'backup-model', apiKey: 'bk' },
  });
  const config = resolveBackupConfig(store, {});
  assert.equal(config.provider, 'openrouter');
  assert.equal(config.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.model, 'backup-model');
  assert.equal(config.apiKey, 'bk');
});

test('resolveBackupConfig: returns null when the stored backup has no model', () => {
  const store = createMockStore({ generationBackup: { provider: 'openrouter', baseUrl: 'https://x', model: '', apiKey: '' } });
  assert.equal(resolveBackupConfig(store, {}), null);
});

test('resolveBackupConfig: returns null when nothing is stored and no env fallback exists', () => {
  assert.equal(resolveBackupConfig(createMockStore({}), {}), null);
  assert.equal(resolveBackupConfig(null, {}), null);
});

test('resolveBackupConfig: falls back to GAIA_BACKUP_* env vars', () => {
  const env = { GAIA_BACKUP_BASE_URL: 'https://backup.internal/v1', GAIA_BACKUP_MODEL: 'b1', GAIA_BACKUP_AUTH_TOKEN: 'bt' };
  const config = resolveBackupConfig(null, env);
  assert.equal(config.baseUrl, 'https://backup.internal/v1');
  assert.equal(config.model, 'b1');
  assert.equal(config.apiKey, 'bt');
});

test('resolveBackupConfig: stored backup wins over env vars', () => {
  const store = createMockStore({
    generationBackup: { provider: 'stored', baseUrl: 'https://stored/v1', model: 's1', apiKey: '' },
  });
  const env = { GAIA_BACKUP_BASE_URL: 'https://env/v1', GAIA_BACKUP_MODEL: 'e1' };
  const config = resolveBackupConfig(store, env);
  assert.equal(config.baseUrl, 'https://stored/v1');
  assert.equal(config.model, 's1');
});

// --- per-role custom provider (generation / kairos / aion) ---

test('resolveRoleConfig: a role custom provider wins over the Main Provider selection', () => {
  const store = createMockStore({
    provider: 'edenai',
    baseUrl: 'https://api.edenai.run/v1',
    apiKey: 'sk-main',
    roles: { generation: { mode: 'catalog', model: 'main-model' } },
    roleProviders: {
      generation: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-custom', useMainProvider: false },
    },
  });
  const config = resolveRoleConfig('generation', store);
  assert.deepEqual(config, { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-custom' });
});

test('resolveRoleConfig: useMainProvider true (the default) ignores the custom block', () => {
  const store = createMockStore({
    provider: 'edenai',
    baseUrl: 'https://api.edenai.run/v1',
    apiKey: 'sk-main',
    roles: { kairos: { mode: 'catalog', model: 'main-model' } },
    roleProviders: {
      kairos: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-custom', useMainProvider: true },
    },
  });
  const config = resolveRoleConfig('kairos', store);
  assert.equal(config.provider, 'edenai');
  assert.equal(config.model, 'main-model');
});

test('resolveRoleConfig: an incomplete custom provider falls through to the Main Provider', () => {
  const store = createMockStore({
    provider: 'edenai',
    baseUrl: 'https://api.edenai.run/v1',
    apiKey: 'sk-main',
    roles: { aion: { mode: 'catalog', model: 'main-model' } },
    roleProviders: { aion: { baseUrl: 'https://api.openai.com/v1', model: '', useMainProvider: false } },
  });
  const config = resolveRoleConfig('aion', store);
  assert.equal(config.provider, 'edenai');
  assert.equal(config.model, 'main-model');
});

test('deriveCapabilities: a custom-provider role counts as active', () => {
  const store = createMockStore({
    provider: 'edenai',
    baseUrl: 'https://api.edenai.run/v1',
    apiKey: 'sk-main',
    roles: { generation: { mode: 'catalog', model: '' } },
    roleProviders: {
      generation: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', useMainProvider: false },
    },
  });
  assert.equal(deriveCapabilities(store).generation, true);
});
