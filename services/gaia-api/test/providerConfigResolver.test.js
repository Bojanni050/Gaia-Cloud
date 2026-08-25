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
