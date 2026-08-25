'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProviderStore, maskKey, DEFAULT_ROLES } = require('../src/providerStore');

function tempStore() {
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-store-')), 'config.json');
  return createProviderStore({ storePath });
}

test('maskKey: short keys are fully masked, longer keys show first/last 4', () => {
  assert.equal(maskKey(''), null);
  assert.equal(maskKey(null), null);
  assert.equal(maskKey('short'), '••••');
  assert.equal(maskKey('sk-eden-abcdefghij1234'), 'sk-e…1234');
});

test('getConfig returns null before anything is saved', () => {
  const store = tempStore();
  assert.equal(store.getConfig(), null);
});

test('saveProviderConfig persists and getConfig reads it back', () => {
  const store = tempStore();
  store.saveProviderConfig({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v1', apiKey: 'sk-eden-secret' });
  const config = store.getConfig();
  assert.equal(config.provider, 'edenai');
  assert.equal(config.baseUrl, 'https://api.edenai.run/v1');
  assert.equal(config.apiKey, 'sk-eden-secret');
  assert.ok(config.updatedAt);
});

test('saveProviderConfig with a partial update keeps the previously stored apiKey', () => {
  const store = tempStore();
  store.saveProviderConfig({ apiKey: 'sk-eden-secret', provider: 'edenai', baseUrl: 'https://api.edenai.run/v1' });
  store.saveProviderConfig({ provider: 'openrouter' }); // no apiKey field
  const config = store.getConfig();
  assert.equal(config.apiKey, 'sk-eden-secret');
  assert.equal(config.provider, 'openrouter');
});

test('saveCatalog persists models and catalogRetrievedAt', () => {
  const store = tempStore();
  store.saveProviderConfig({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v1' });
  const catalog = [
    { id: 'google/gemini-flash', name: 'Gemini Flash', capabilities: ['vision'] },
    { id: 'openai/gpt-4o', name: 'GPT-4o', capabilities: [] },
  ];
  store.saveCatalog(catalog, '2026-01-01T00:00:00Z');
  const config = store.getConfig();
  assert.equal(config.catalog.length, 2);
  assert.equal(config.catalog[0].id, 'google/gemini-flash');
  assert.equal(config.catalogRetrievedAt, '2026-01-01T00:00:00Z');
});

test('saveCatalog replaces the entire catalog', () => {
  const store = tempStore();
  store.saveProviderConfig({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v1' });
  store.saveCatalog([{ id: 'a', name: 'A', capabilities: [] }]);
  store.saveCatalog([{ id: 'b', name: 'B', capabilities: [] }]);
  const config = store.getConfig();
  assert.equal(config.catalog.length, 1);
  assert.equal(config.catalog[0].id, 'b');
});

test('saveRoleSelection persists role config', () => {
  const store = tempStore();
  store.saveProviderConfig({ provider: 'edenai', baseUrl: 'https://api.edenai.run/v1' });
  store.saveRoleSelection('generation', { mode: 'catalog', model: 'google/gemini-flash' });
  store.saveRoleSelection('tts', { mode: 'manual', model: 'mimo-tts' });
  const config = store.getConfig();
  assert.equal(config.roles.generation.mode, 'catalog');
  assert.equal(config.roles.generation.model, 'google/gemini-flash');
  assert.equal(config.roles.tts.mode, 'manual');
  assert.equal(config.roles.tts.model, 'mimo-tts');
});

test('saveRoleSelection throws for unknown role', () => {
  const store = tempStore();
  assert.throws(() => store.saveRoleSelection('unknown', { mode: 'catalog', model: 'x' }), /unknown role/);
});

test('saveRoleSelection does not affect other roles', () => {
  const store = tempStore();
  store.saveRoleSelection('generation', { mode: 'catalog', model: 'g1' });
  store.saveRoleSelection('reasoning', { mode: 'manual', model: 'r1' });
  store.saveRoleSelection('generation', { mode: 'manual', model: 'g2' });
  const config = store.getConfig();
  assert.equal(config.roles.generation.model, 'g2');
  assert.equal(config.roles.reasoning.model, 'r1');
});

test('getMaskedConfig never returns the raw apiKey', () => {
  const store = tempStore();
  store.saveProviderConfig({ apiKey: 'sk-eden-secret-value', provider: 'edenai' });
  const masked = store.getMaskedConfig();
  assert.equal(masked.hasApiKey, true);
  assert.notEqual(masked.maskedApiKey, 'sk-eden-secret-value');
  assert.ok(!JSON.stringify(masked).includes('sk-eden-secret-value'));
});

test('getMaskedConfig before any save reports defaults', () => {
  const store = tempStore();
  const masked = store.getMaskedConfig();
  assert.equal(masked.provider, null);
  assert.equal(masked.baseUrl, null);
  assert.equal(masked.hasApiKey, false);
  assert.equal(masked.maskedApiKey, null);
  assert.deepEqual(masked.catalog, []);
  assert.equal(masked.catalogRetrievedAt, null);
  assert.deepEqual(masked.roles, DEFAULT_ROLES);
});

test('getMaskedConfig includes roles and catalog (not secrets)', () => {
  const store = tempStore();
  store.saveProviderConfig({ apiKey: 'secret', provider: 'edenai' });
  store.saveCatalog([{ id: 'm1', name: 'Model 1', capabilities: ['vision'] }]);
  store.saveRoleSelection('vision', { mode: 'catalog', model: 'm1' });
  const masked = store.getMaskedConfig();
  assert.equal(masked.catalog.length, 1);
  assert.equal(masked.roles.vision.model, 'm1');
  assert.ok(!JSON.stringify(masked).includes('secret'));
});

test('saveProviderConfig creates the parent directory if it does not exist yet', () => {
  const nested = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-store-')), 'nested', 'dir', 'config.json');
  const store = createProviderStore({ storePath: nested });
  store.saveProviderConfig({ apiKey: 'x' });
  assert.ok(fs.existsSync(nested));
});

test('clear removes the stored config', () => {
  const store = tempStore();
  store.saveProviderConfig({ apiKey: 'x' });
  store.clear();
  assert.equal(store.getConfig(), null);
});

test('DEFAULT_ROLES contains all four roles with empty defaults', () => {
  assert.deepEqual(DEFAULT_ROLES, {
    generation: { mode: 'catalog', model: '' },
    reasoning: { mode: 'catalog', model: '' },
    vision: { mode: 'catalog', model: '' },
    tts: { mode: 'catalog', model: '' },
  });
});
