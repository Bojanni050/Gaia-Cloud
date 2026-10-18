'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  retrieveModels,
  retrieveEdenAiModels,
  retrieveOpenAiCompatibleModels,
  retrieveMistralModels,
  retrieveDeepInfraModels,
  retrieveOpenRouterModelEndpoints,
  normalizeEdenAiModel,
  normalizeOpenAiModel,
  normalizeMistralModel,
  normalizeDeepInfraModel,
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

test('normalizeEdenAiModel: maps EdenAI per-token pricing onto the shared prompt/completion shape', () => {
  const m = {
    id: 'deepinfra/XiaomiMiMo/MiMo-V2.6-Pro',
    model_name: 'MiMo-V2.6-Pro',
    context_length: 1048576,
    pricing: { input_cost_per_token: 4.35e-7, output_cost_per_token: 8.7e-7 },
  };
  const result = normalizeEdenAiModel(m);
  assert.equal(result.pricing.prompt, 4.35e-7);
  assert.equal(result.pricing.completion, 8.7e-7);
  assert.equal(result.contextLength, 1048576);
});

test('normalizeEdenAiModel: leaves pricing null when EdenAI reports none', () => {
  const result = normalizeEdenAiModel({ id: 'a/model', model_name: 'A' });
  assert.equal(result.pricing.prompt, null);
  assert.equal(result.pricing.completion, null);
  assert.equal(result.contextLength, null);
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

test('normalizeOpenAiModel: reads OpenRouter supported_parameters (tools, reasoning, web_search)', () => {
  const m = {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    architecture: { modality: 'text->text', input_modalities: ['text'] },
    supported_parameters: ['tools', 'tool_choice', 'reasoning', 'web_search'],
  };
  const caps = normalizeOpenAiModel(m).capabilities;
  assert.ok(caps.includes('function_calling'));
  assert.ok(caps.includes('reasoning'));
  assert.ok(caps.includes('web_search'));
  assert.ok(!caps.includes('vision'));
});

test('normalizeOpenAiModel: reads OpenRouter input_modalities for vision/audio/video', () => {
  const m = {
    id: 'x',
    name: 'X',
    architecture: { modality: 'text+image+audio->text', input_modalities: ['text', 'image', 'audio', 'video'] },
  };
  const caps = normalizeOpenAiModel(m).capabilities;
  assert.ok(caps.includes('vision'));
  assert.ok(caps.includes('audio'));
  assert.ok(caps.includes('video'));
});

test('normalizeOpenAiModel: never invents a capability the provider did not report', () => {
  const m = { id: 'z', name: 'Z', architecture: { modality: 'text->text', input_modalities: ['text'] }, supported_parameters: ['temperature', 'max_tokens'] };
  assert.deepEqual(normalizeOpenAiModel(m).capabilities, []);
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

test('retrieveModels: routes Alibaba Cloud through the OpenAI-compatible adapter against its own base URL', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({ data: [{ id: 'qwen-max', name: 'Qwen Max' }] }),
  };
  let capturedUrl, capturedHeaders;
  const fetchImpl = async (url, init) => { capturedUrl = url; capturedHeaders = init.headers; return fakeResponse; };
  // Workspace-scoped base URL, as issued from the Model Studio console —
  // not the shared dashscope-intl.aliyuncs.com endpoint some docs lead with.
  const models = await retrieveModels({
    provider: 'alibaba',
    baseUrl: 'https://ws-example12345.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    apiKey: 'test-key',
    fetchImpl,
    timeoutMs: 5000,
  });
  assert.equal(capturedUrl, 'https://ws-example12345.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models');
  assert.equal(capturedHeaders.Authorization, 'Bearer test-key');
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'qwen-max');
});

test('retrieveModels: routes NVIDIA through the OpenAI-compatible adapter against integrate.api.nvidia.com', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({ data: [{ id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' }] }),
  };
  let capturedUrl, capturedHeaders;
  const fetchImpl = async (url, init) => { capturedUrl = url; capturedHeaders = init.headers; return fakeResponse; };
  const models = await retrieveModels({
    provider: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: 'test-key',
    fetchImpl,
    timeoutMs: 5000,
  });
  assert.equal(capturedUrl, 'https://integrate.api.nvidia.com/v1/models');
  assert.equal(capturedHeaders.Authorization, 'Bearer test-key');
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'meta/llama-3.3-70b-instruct');
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

// --- retrieveOpenRouterModelEndpoints (mocked fetch) ---

test('retrieveOpenRouterModelEndpoints: fetches, normalizes, and sorts by combined price', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({
      data: {
        endpoints: [
          { provider_name: 'DeepInfra', context_length: 128000, pricing: { prompt: '0.0000002', completion: '0.0000006' } },
          { provider_name: 'Qwen', context_length: 128000, pricing: { prompt: '0.0000001', completion: '0.00000039' } },
        ],
      },
    }),
  };
  let capturedUrl;
  const fetchImpl = async (url) => { capturedUrl = url; return fakeResponse; };
  const endpoints = await retrieveOpenRouterModelEndpoints({ modelId: 'deepseek/deepseek-v4.1-flash', fetchImpl, timeoutMs: 5000 });
  assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints');
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0].providerName, 'Qwen');
  assert.equal(endpoints[1].providerName, 'DeepInfra');
});

test('retrieveOpenRouterModelEndpoints: filters out entries without a provider name', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({ data: { endpoints: [{ pricing: {} }, { provider_name: 'Together AI', pricing: {} }] } }),
  };
  const fetchImpl = async () => fakeResponse;
  const endpoints = await retrieveOpenRouterModelEndpoints({ modelId: 'a/b', fetchImpl, timeoutMs: 5000 });
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].providerName, 'Together AI');
});

test('retrieveOpenRouterModelEndpoints: throws on network error', async () => {
  const fetchImpl = async () => { throw new Error('network fail'); };
  await assert.rejects(
    () => retrieveOpenRouterModelEndpoints({ modelId: 'a/b', fetchImpl, timeoutMs: 5000 }),
    { message: 'openrouter unreachable' }
  );
});

test('retrieveOpenRouterModelEndpoints: throws "model not found" on 404', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    () => retrieveOpenRouterModelEndpoints({ modelId: 'a/b', fetchImpl, timeoutMs: 5000 }),
    { message: 'model not found' }
  );
});

// --- normalizeDeepInfraModel / retrieveDeepInfraModels ---

// Shapes taken verbatim from the live list on 2026-10-18: everything that
// matters sits in `metadata`, and the top level only carries id/object/
// created/owned_by/root/parent — which is why the generic OpenAI-compatible
// normalizer showed nothing for DeepInfra.
const DEEPINFRA_CHAT = {
  id: 'Qwen/Qwen3.5-9B',
  object: 'model',
  created: 0,
  owned_by: 'deepinfra',
  root: 'Qwen/Qwen3.5-9B',
  parent: null,
  metadata: {
    description: 'Qwen3.5-9B is a high-performance model from the Qwen3.5 series.',
    context_length: 262144,
    max_tokens: 262144,
    pricing: { input_tokens: 0.1, output_tokens: 0.15 },
    discount: null,
    tags: ['chat', 'vlm', 'vision', 'reasoning_effort', 'reasoning'],
  },
};

test('normalizeDeepInfraModel: reads price, context length, tags and description from metadata', () => {
  const result = normalizeDeepInfraModel(DEEPINFRA_CHAT);
  assert.equal(result.id, 'Qwen/Qwen3.5-9B');
  assert.equal(result.name, 'Qwen/Qwen3.5-9B');
  assert.deepEqual(result.capabilities, ['vision', 'reasoning']);
  assert.equal(result.contextLength, 262144);
  // dollars per 1M tokens in, USD-per-token out: 0.10 and 0.15 per million.
  assert.equal(result.pricing.prompt, '0.0000001');
  assert.equal(result.pricing.completion, '0.00000015');
  assert.equal(result.description, 'Qwen3.5-9B is a high-performance model from the Qwen3.5 series.');
});

test('normalizeDeepInfraModel: a non-text model reports no per-token price instead of a wrong one', () => {
  const image = normalizeDeepInfraModel({ id: 'Bria/Bria-3.2', metadata: { pricing: { per_image_unit: 0.04 }, tags: ['image-gen'], context_length: null, max_tokens: null } });
  assert.deepEqual(image.capabilities, []);
  assert.equal(image.contextLength, null);
  assert.deepEqual(image.pricing, { prompt: null, completion: null });
  const speech = normalizeDeepInfraModel({ id: 'sesame/csm-1b', metadata: { pricing: { input_characters: 7 }, tags: ['tts'] } });
  assert.deepEqual(speech.capabilities, ['audio']);
  assert.deepEqual(speech.pricing, { prompt: null, completion: null });
});

test('normalizeDeepInfraModel: video and reasoning tags map onto the labels the page renders', () => {
  const video = normalizeDeepInfraModel({ id: 'x/video', metadata: { tags: ['video-gen'] } });
  assert.deepEqual(video.capabilities, ['video']);
  const plain = normalizeDeepInfraModel({ id: 'x/embed', metadata: { tags: ['embed', 'prompt_cache'] } });
  assert.deepEqual(plain.capabilities, []);
});

test('normalizeDeepInfraModel: a free model is zero, not unknown, and missing metadata is survivable', () => {
  const free = normalizeDeepInfraModel({ id: 'x/free', metadata: { pricing: { input_tokens: 0, output_tokens: 0 } } });
  assert.deepEqual(free.pricing, { prompt: '0', completion: '0' });
  const bare = normalizeDeepInfraModel({ id: 'x/bare' });
  assert.deepEqual(bare, { id: 'x/bare', name: 'x/bare', capabilities: [], contextLength: null, pricing: { prompt: null, completion: null }, description: null });
  assert.equal(normalizeDeepInfraModel({}).id, '');
});

test('retrieveDeepInfraModels: fetches, normalizes and sorts, with no key needed', async () => {
  let capturedUrl, capturedHeaders;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    return { ok: true, json: async () => ({ object: 'list', data: [DEEPINFRA_CHAT, { id: 'Bria/Bria-3.2', metadata: { tags: ['image-gen'] } }, { metadata: {} }] }) };
  };
  const models = await retrieveDeepInfraModels({ baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: '', fetchImpl, timeoutMs: 5000 });
  assert.equal(capturedUrl, 'https://api.deepinfra.com/v1/openai/models');
  assert.equal(capturedHeaders.Authorization, undefined);
  assert.deepEqual(models.map((m) => m.id), ['Bria/Bria-3.2', 'Qwen/Qwen3.5-9B']);
});

test('retrieveDeepInfraModels: defaults to DeepInfra, sends the key when there is one, and reports a 401', async () => {
  let capturedUrl, capturedHeaders;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    return { ok: true, json: async () => ({ data: [] }) };
  };
  await retrieveDeepInfraModels({ apiKey: 'deep-key', fetchImpl, timeoutMs: 5000 });
  assert.equal(capturedUrl, 'https://api.deepinfra.com/v1/openai/models');
  assert.equal(capturedHeaders.Authorization, 'Bearer deep-key');
  await assert.rejects(
    () => retrieveDeepInfraModels({ apiKey: 'bad', fetchImpl: async () => ({ ok: false, status: 401 }), timeoutMs: 5000 }),
    /authentication failed/
  );
  await assert.rejects(
    () => retrieveDeepInfraModels({ fetchImpl: async () => { throw new Error('offline'); }, timeoutMs: 5000 }),
    /deepinfra unreachable/
  );
});

test('retrieveModels: routes to the DeepInfra adapter for deepinfra provider', async () => {
  let capturedUrl;
  const fetchImpl = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ data: [DEEPINFRA_CHAT] }) }; };
  const models = await retrieveModels({ provider: 'deepinfra', baseUrl: 'https://api.deepinfra.com/v1/openai', fetchImpl, timeoutMs: 5000 });
  assert.equal(capturedUrl, 'https://api.deepinfra.com/v1/openai/models');
  assert.equal(models[0].contextLength, 262144);
  assert.equal(models[0].pricing.prompt, '0.0000001');
});
