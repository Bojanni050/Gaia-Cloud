'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  retrieveModels,
  retrieveEdenAiModels,
  retrieveOpenAiCompatibleModels,
  retrieveMistralModels,
  normalizeEdenAiModel,
  normalizeOpenAiModel,
  normalizeMistralModel,
} = require('../src/modelDiscovery');

// --- normalizeEdenAiModel ---

test('normalizeEdenAiModel: extracts capabilities from EdenAI metadata', () => {
  const m = {
    id: 'google/gemini-flash-latest',
    model_name: 'gemini-3.6-flash',
    capabilities: {
      input_modalities: ['text', 'image', 'video', 'file', 'audio'],
      output_modalities: ['text'],
      supports_reasoning: true,
      supports_web_search: true,
      supports_function_calling: true,
    },
  };
  const result = normalizeEdenAiModel(m);
  assert.equal(result.id, 'google/gemini-flash-latest');
  assert.equal(result.name, 'gemini-3.6-flash');
  assert.ok(result.capabilities.includes('vision'));
  assert.ok(result.capabilities.includes('audio'));
  assert.ok(result.capabilities.includes('video'));
  assert.ok(result.capabilities.includes('reasoning'));
  assert.ok(result.capabilities.includes('function_calling'));
  assert.ok(result.capabilities.includes('web_search'));
});

test('normalizeEdenAiModel: handles missing capabilities gracefully', () => {
  const m = { id: 'some/model', model_name: 'Some Model' };
  const result = normalizeEdenAiModel(m);
  assert.equal(result.id, 'some/model');
  assert.equal(result.name, 'Some Model');
  assert.deepEqual(result.capabilities, []);
});

test('normalizeEdenAiModel: handles null capabilities', () => {
  const m = { id: 'x', name: 'X', capabilities: null };
  const result = normalizeEdenAiModel(m);
  assert.deepEqual(result.capabilities, []);
});

test('normalizeEdenAiModel: falls back to name then id', () => {
  assert.equal(normalizeEdenAiModel({ id: 'a' }).name, 'a');
  assert.equal(normalizeEdenAiModel({ id: 'a', name: 'B' }).name, 'B');
  assert.equal(normalizeEdenAiModel({ id: 'a', model_name: 'C', name: 'B' }).name, 'C');
});

// --- normalizeOpenAiModel ---

test('normalizeOpenAiModel: extracts capabilities from OpenAI metadata', () => {
  const m = {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    capabilities: {
      input_modalities: ['text', 'image'],
      supports_reasoning: false,
      supports_function_calling: true,
    },
  };
  const result = normalizeOpenAiModel(m);
  assert.equal(result.id, 'openai/gpt-4o');
  assert.equal(result.name, 'GPT-4o');
  assert.ok(result.capabilities.includes('vision'));
  assert.ok(result.capabilities.includes('function_calling'));
  assert.ok(!result.capabilities.includes('reasoning'));
});

test('normalizeOpenAiModel: detects vision from architecture.modality', () => {
  const m = {
    id: 'model-x',
    name: 'Model X',
    architecture: { modality: 'text+image->text' },
  };
  const result = normalizeOpenAiModel(m);
  assert.ok(result.capabilities.includes('vision'));
});

test('normalizeOpenAiModel: handles missing capabilities', () => {
  const m = { id: 'y', name: 'Y' };
  const result = normalizeOpenAiModel(m);
  assert.deepEqual(result.capabilities, []);
});

// --- retrieveEdenAiModels (mocked fetch) ---

test('retrieveEdenAiModels: fetches and normalizes models', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({
      data: [
        { id: 'google/gemini-flash', model_name: 'Gemini Flash', capabilities: { input_modalities: ['text', 'image'], supports_reasoning: true } },
        { id: 'openai/gpt-4o', model_name: 'GPT-4o', capabilities: { input_modalities: ['text'] } },
      ],
    }),
  };
  const fetchImpl = async () => fakeResponse;
  const models = await retrieveEdenAiModels({ apiKey: 'test', fetchImpl, timeoutMs: 5000 });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'google/gemini-flash');
  assert.ok(models[0].capabilities.includes('vision'));
  assert.ok(models[0].capabilities.includes('reasoning'));
  assert.equal(models[1].id, 'openai/gpt-4o');
  assert.ok(!models[1].capabilities.includes('vision'));
});

test('retrieveEdenAiModels: sorts by name', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({
      data: [
        { id: 'b/model-b', model_name: 'Beta' },
        { id: 'a/model-a', model_name: 'Alpha' },
      ],
    }),
  };
  const fetchImpl = async () => fakeResponse;
  const models = await retrieveEdenAiModels({ fetchImpl, timeoutMs: 5000 });
  assert.equal(models[0].name, 'Alpha');
  assert.equal(models[1].name, 'Beta');
});

test('retrieveEdenAiModels: throws on network error', async () => {
  const fetchImpl = async () => { throw new Error('network fail'); };
  await assert.rejects(
    () => retrieveEdenAiModels({ fetchImpl, timeoutMs: 5000 }),
    { message: 'edenai unreachable' }
  );
});

test('retrieveEdenAiModels: throws on 401', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    () => retrieveEdenAiModels({ fetchImpl, timeoutMs: 5000 }),
    { message: 'authentication failed' }
  );
});

test('retrieveEdenAiModels: throws on non-200', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(
    () => retrieveEdenAiModels({ fetchImpl, timeoutMs: 5000 }),
    { message: 'provider responded with an error' }
  );
});

test('retrieveEdenAiModels: throws on unreadable JSON', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  await assert.rejects(
    () => retrieveEdenAiModels({ fetchImpl, timeoutMs: 5000 }),
    { message: 'provider returned an unreadable response' }
  );
});

// --- retrieveOpenAiCompatibleModels (mocked fetch) ---

test('retrieveOpenAiCompatibleModels: fetches and normalizes models', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({
      data: [
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', context_length: 128000 },
      ],
    }),
  };
  const fetchImpl = async () => fakeResponse;
  const models = await retrieveOpenAiCompatibleModels({ baseUrl: 'https://openrouter.ai/api/v1', fetchImpl, timeoutMs: 5000 });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'openai/gpt-4o-mini');
  assert.equal(models[0].name, 'GPT-4o Mini');
});

test('retrieveOpenAiCompatibleModels: throws on network error', async () => {
  const fetchImpl = async () => { throw new Error('network fail'); };
  await assert.rejects(
    () => retrieveOpenAiCompatibleModels({ baseUrl: 'https://example.com', fetchImpl, timeoutMs: 5000 }),
    { message: 'provider unreachable' }
  );
});

// --- normalizeMistralModel ---

test('normalizeMistralModel: extracts capabilities from Mistral\'s flat booleans', () => {
  const m = {
    id: 'pixtral-large-latest',
    name: 'pixtral-large-latest',
    capabilities: {
      completion_chat: true,
      completion_fim: false,
      function_calling: true,
      fine_tuning: false,
      vision: true,
    },
  };
  const result = normalizeMistralModel(m);
  assert.equal(result.id, 'pixtral-large-latest');
  assert.equal(result.name, 'pixtral-large-latest');
  assert.ok(result.capabilities.includes('vision'));
  assert.ok(result.capabilities.includes('function_calling'));
  assert.ok(!result.capabilities.includes('fim'));
  assert.ok(!result.capabilities.includes('fine_tuning'));
});

test('normalizeMistralModel: handles missing capabilities gracefully', () => {
  const m = { id: 'mistral-small-latest', name: 'mistral-small-latest' };
  const result = normalizeMistralModel(m);
  assert.equal(result.id, 'mistral-small-latest');
  assert.deepEqual(result.capabilities, []);
});

test('normalizeMistralModel: falls back to id when name is absent', () => {
  assert.equal(normalizeMistralModel({ id: 'codestral-latest' }).name, 'codestral-latest');
});

// --- retrieveMistralModels (mocked fetch) ---

test('retrieveMistralModels: fetches and normalizes models', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({
      object: 'list',
      data: [
        { id: 'mistral-large-latest', name: 'mistral-large-latest', capabilities: { function_calling: true, vision: false } },
        { id: 'pixtral-large-latest', name: 'pixtral-large-latest', capabilities: { vision: true } },
      ],
    }),
  };
  let capturedUrl, capturedHeaders;
  const fetchImpl = async (url, init) => { capturedUrl = url; capturedHeaders = init.headers; return fakeResponse; };
  const models = await retrieveMistralModels({ baseUrl: 'https://api.mistral.ai/v1', apiKey: 'test-key', fetchImpl, timeoutMs: 5000 });
  assert.equal(capturedUrl, 'https://api.mistral.ai/v1/models');
  assert.equal(capturedHeaders.Authorization, 'Bearer test-key');
  assert.equal(models.length, 2);
  assert.ok(models.find((m) => m.id === 'pixtral-large-latest').capabilities.includes('vision'));
});

test('retrieveMistralModels: defaults to api.mistral.ai when no baseUrl is configured', async () => {
  const fakeResponse = { ok: true, json: async () => ({ data: [] }) };
  let capturedUrl;
  const fetchImpl = async (url) => { capturedUrl = url; return fakeResponse; };
  await retrieveMistralModels({ baseUrl: '', apiKey: '', fetchImpl, timeoutMs: 5000 });
  assert.equal(capturedUrl, 'https://api.mistral.ai/v1/models');
});

test('retrieveMistralModels: throws on network error', async () => {
  const fetchImpl = async () => { throw new Error('network fail'); };
  await assert.rejects(
    () => retrieveMistralModels({ baseUrl: 'https://api.mistral.ai/v1', fetchImpl, timeoutMs: 5000 }),
    { message: 'mistral unreachable' }
  );
});

test('retrieveMistralModels: throws on 401', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    () => retrieveMistralModels({ baseUrl: 'https://api.mistral.ai/v1', fetchImpl, timeoutMs: 5000 }),
    { message: 'authentication failed' }
  );
});

// --- retrieveModels (router) ---

test('retrieveModels: routes to EdenAI adapter for edenai provider', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({ data: [{ id: 'test/model', model_name: 'Test' }] }),
  };
  const fetchImpl = async () => fakeResponse;
  const models = await retrieveModels({ provider: 'edenai', baseUrl: '', apiKey: '', fetchImpl, timeoutMs: 5000 });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'test/model');
});

test('retrieveModels: routes to Mistral adapter for mistral provider', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({ data: [{ id: 'mistral-medium-latest', name: 'mistral-medium-latest', capabilities: { vision: true } }] }),
  };
  const fetchImpl = async () => fakeResponse;
  const models = await retrieveModels({ provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: '', fetchImpl, timeoutMs: 5000 });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'mistral-medium-latest');
  assert.ok(models[0].capabilities.includes('vision'));
});

test('retrieveModels: routes to OpenAI-compatible adapter for unknown provider', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({ data: [{ id: 'test/model', name: 'Test' }] }),
  };
  const fetchImpl = async () => fakeResponse;
  const models = await retrieveModels({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', fetchImpl, timeoutMs: 5000 });
  assert.equal(models.length, 1);
});

test('retrieveModels: filters out models without id', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({ data: [{ id: 'valid', name: 'Valid' }, { name: 'No ID' }] }),
  };
  const fetchImpl = async () => fakeResponse;
  const models = await retrieveModels({ provider: 'edenai', fetchImpl, timeoutMs: 5000 });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'valid');
});
