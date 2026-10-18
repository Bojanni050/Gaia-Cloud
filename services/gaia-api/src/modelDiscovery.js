'use strict';

/**
 * Generic model discovery — retrieves the model catalog from a provider
 * and normalizes it into a consistent internal shape:
 *
 *   { id: string, name: string, capabilities: string[] }
 *
 * Provider-specific response formats are handled by thin adapters.
 * No hardcoded model catalogs — this module always fetches live data.
 *
 * Supported discovery patterns:
 *   - OpenAI-compatible: GET {baseUrl}/models (default)
 *   - EdenAI:            GET https://api.edenai.run/v3/models (or eu variant)
 *   - Mistral:           GET {baseUrl}/models (default https://api.mistral.ai/v1)
 *                        — OpenAI-shaped, but capabilities come back as a flat
 *                        object (vision, function_calling, ...) instead of the
 *                        input_modalities/supports_* shape other providers use,
 *                        so it gets its own normalizer. See
 *                        https://docs.mistral.ai/getting-started/platform-overview
 *   - DeepInfra:        GET {baseUrl}/models (default
 *                        https://api.deepinfra.com/v1/openai). OpenAI-shaped
 *                        at the top, with price, context length, tags and
 *                        description nested in `metadata` — so it gets its
 *                        own normalizer. Public list; no key required.
 *
 * The provider string determines which adapter is used. Unknown providers
 * fall back to the OpenAI-compatible pattern, which covers OpenRouter,
 * OpenAI, Alibaba Cloud Model Studio / DashScope, NVIDIA NIM / API catalog,
 * and most OpenAI-compatible endpoints. Alibaba Cloud has no dedicated
 * adapter — its /models response is plain OpenAI-shaped with no extra
 * capabilities metadata to normalize — but its base URL is
 * account/workspace-specific and must be copied from
 * the Model Studio console rather than assumed. Observed shapes:
 *   - workspace-scoped: https://{workspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1
 *     (e.g. Singapore: https://{workspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1)
 *   - shared regional:  https://dashscope-intl.aliyuncs.com/compatible-mode/v1 (international)
 *                       https://dashscope.aliyuncs.com/compatible-mode/v1 (Beijing)
 * See https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
 *
 * OpenCode (Go plan, https://opencode.ai/zen/go/v1) is likewise a plain OpenAI-shaped /models.
 * Gaia only speaks /chat/completions, so only the models OpenCode serves on that endpoint work
 * (GLM, Kimi, DeepSeek, MiMo, ...); the ones served on /responses or /messages do not.
 * See https://opencode.ai/docs/go
 *
 * NVIDIA (hosted API catalog, https://integrate.api.nvidia.com/v1) also has
 * no dedicated adapter — same reasoning: plain OpenAI-shaped /models, one
 * universal base URL, nothing provider-specific to normalize. See
 * https://docs.api.nvidia.com/nim/reference/llm-apis
 */

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Retrieve the model catalog from a provider.
 * @param {{
 *   provider: string,
 *   baseUrl: string,
 *   apiKey: string,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<Array<{ id: string, name: string, capabilities: string[] }>>}
 */
async function retrieveModels({ provider, baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl || fetch;
  const ms = timeoutMs || DEFAULT_TIMEOUT_MS;
  const normalizedProvider = String(provider || '').toLowerCase().trim();

  if (normalizedProvider === 'edenai') {
    return retrieveEdenAiModels({ apiKey, fetchImpl: fetchFn, timeoutMs: ms });
  }

  if (normalizedProvider === 'mistral') {
    return retrieveMistralModels({ baseUrl, apiKey, fetchImpl: fetchFn, timeoutMs: ms });
  }

  if (normalizedProvider === 'deepinfra') {
    return retrieveDeepInfraModels({ baseUrl, apiKey, fetchImpl: fetchFn, timeoutMs: ms });
  }

  if (normalizedProvider === 'fishaudio') {
    return require('./speech/fishAudioTts').listModels();
  }

  if (normalizedProvider === 'elevenlabs') {
    return require('./speech/elevenLabsTts').listModels({ baseUrl, apiKey, fetchImpl: fetchFn, timeoutMs: ms });
  }

  // Default: OpenAI-compatible /models endpoint
  return retrieveOpenAiCompatibleModels({ baseUrl, apiKey, fetchImpl: fetchFn, timeoutMs: ms });
}

const MISTRAL_DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';

/**
 * Mistral model discovery — GET {baseUrl}/models (defaults to Mistral's
 * own endpoint if no baseUrl is configured). Bearer-authenticated, same
 * shape as OpenAI's /models list, but each entry's `capabilities` is a
 * flat object of booleans (completion_chat, completion_fim,
 * function_calling, fine_tuning, vision) rather than the
 * input_modalities/supports_* shape used elsewhere — normalized
 * separately so those flags are read correctly instead of silently
 * dropped by the generic OpenAI-compatible normalizer.
 */
async function retrieveMistralModels({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const url = `${String(baseUrl || MISTRAL_DEFAULT_BASE_URL).replace(/\/+$/, '')}/models`;
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error('mistral unreachable');
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error('authentication failed');
    throw new Error('provider responded with an error');
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error('provider returned an unreadable response');
  }

  const models = Array.isArray(data?.data) ? data.data : [];
  return models
    .map((m) => normalizeMistralModel(m))
    .filter((m) => Boolean(m.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Normalize a single Mistral model entry. Capabilities come straight from
 * Mistral's own flat booleans — never invented.
 */
function normalizeMistralModel(m) {
  const caps = [];
  const c = m.capabilities;
  if (c) {
    if (c.vision) caps.push('vision');
    if (c.function_calling) caps.push('function_calling');
    if (c.completion_fim) caps.push('fim');
    if (c.fine_tuning) caps.push('fine_tuning');
  }
  return {
    id: m.id || '',
    name: m.name || m.id || '',
    capabilities: caps,
    // Mistral's /models response reports context length but not pricing
    // or a description.
    contextLength: typeof m.max_context_length === 'number' ? m.max_context_length : null,
    pricing: { prompt: null, completion: null },
    description: null,
  };
}

/**
 * EdenAI model discovery — GET /v3/models (public endpoint, no API key required).
 * Normalizes the EdenAI capabilities shape into a flat string array.
 */
async function retrieveEdenAiModels({ apiKey, fetchImpl, timeoutMs }) {
  const url = 'https://api.edenai.run/v3/models';
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error('edenai unreachable');
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error('authentication failed');
    throw new Error('provider responded with an error');
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error('provider returned an unreadable response');
  }

  const models = Array.isArray(data?.data) ? data.data : [];
  return models
    .map((m) => normalizeEdenAiModel(m))
    .filter((m) => Boolean(m.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Normalize a single EdenAI model entry.
 * Capabilities come from the provider's own metadata — never invented.
 */
function normalizeEdenAiModel(m) {
  const caps = [];
  const c = m.capabilities;
  if (c) {
    if (Array.isArray(c.input_modalities)) {
      if (c.input_modalities.includes('image')) caps.push('vision');
      if (c.input_modalities.includes('audio')) caps.push('audio');
      if (c.input_modalities.includes('video')) caps.push('video');
    }
    if (c.supports_reasoning) caps.push('reasoning');
    if (c.supports_function_calling) caps.push('function_calling');
    if (c.supports_web_search) caps.push('web_search');
  }
  return {
    id: m.id || '',
    name: m.model_name || m.name || m.id || '',
    capabilities: caps,
    // EdenAI's public /v3/models catalog reports context length and
    // per-token pricing (input_cost_per_token / output_cost_per_token,
    // USD per token as numbers), but no free-text description. Pricing is
    // mapped onto the same shape OpenRouter uses (prompt/completion, USD
    // per token) so the shared price formatting shows Eden's own rates,
    // not OpenRouter's.
    contextLength: typeof m.context_length === 'number' ? m.context_length : null,
    pricing: {
      prompt: m.pricing?.input_cost_per_token ?? null,
      completion: m.pricing?.output_cost_per_token ?? null,
    },
    description: null,
  };
}

/**
 * OpenAI-compatible model discovery — GET {baseUrl}/models.
 * Used by OpenRouter, OpenAI, and most compatible endpoints.
 */
async function retrieveOpenAiCompatibleModels({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error('provider unreachable');
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error('authentication failed');
    throw new Error('provider responded with an error');
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error('provider returned an unreadable response');
  }

  const models = Array.isArray(data?.data) ? data.data : [];
  return models
    .map((m) => normalizeOpenAiModel(m))
    .filter((m) => Boolean(m.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Normalize a single OpenAI-compatible model entry.
 * Attempts to infer capabilities from known provider metadata fields.
 * When capability metadata is absent, the model is still included —
 * the user can use Manual mode for it.
 *
 * Also carries context length and per-token pricing when the provider's
 * /models response includes them (OpenRouter does: context_length,
 * pricing.prompt / pricing.completion, both USD-per-token strings). Never
 * invented for providers that don't report it — those fields come back null.
 */
function normalizeOpenAiModel(m) {
  const caps = [];
  const c = m.capabilities;
  if (c) {
    if (Array.isArray(c.input_modalities)) {
      if (c.input_modalities.includes('image')) caps.push('vision');
      if (c.input_modalities.includes('audio')) caps.push('audio');
    }
    if (c.supports_reasoning) caps.push('reasoning');
    if (c.supports_function_calling) caps.push('function_calling');
  }
  // OpenRouter (and OpenAI-compatible endpoints that mirror it) describe what
  // a model can DO in `architecture` + `supported_parameters` rather than a
  // `capabilities` object. Read both, never inventing a flag that isn't there.
  if (m.architecture) {
    const modality = typeof m.architecture.modality === 'string' ? m.architecture.modality : '';
    const inputs = Array.isArray(m.architecture.input_modalities) ? m.architecture.input_modalities : [];
    if ((modality && modality.includes('image')) || inputs.includes('image')) {
      if (!caps.includes('vision')) caps.push('vision');
    }
    if (inputs.includes('audio') || modality.includes('audio')) {
      if (!caps.includes('audio')) caps.push('audio');
    }
    if (inputs.includes('video') || modality.includes('video')) {
      if (!caps.includes('video')) caps.push('video');
    }
  }
  if (Array.isArray(m.supported_parameters)) {
    const sp = m.supported_parameters;
    if ((sp.includes('tools') || sp.includes('tool_choice')) && !caps.includes('function_calling')) caps.push('function_calling');
    if ((sp.includes('reasoning') || sp.includes('include_reasoning') || sp.includes('reasoning_effort')) && !caps.includes('reasoning')) caps.push('reasoning');
    if ((sp.includes('web_search') || sp.includes('web_search_options')) && !caps.includes('web_search')) caps.push('web_search');
  }
  return {
    id: m.id || '',
    name: m.name || m.id || '',
    capabilities: caps,
    contextLength: typeof m.context_length === 'number' ? m.context_length : null,
    pricing: {
      prompt: m.pricing?.prompt ?? null,
      completion: m.pricing?.completion ?? null,
    },
    // OpenRouter's /models response includes a free-text description per
    // model; other OpenAI-compatible providers generally don't.
    description: typeof m.description === 'string' && m.description.trim() ? m.description.trim() : null,
  };
}

const OPENROUTER_ENDPOINTS_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter-specific: a single model id (e.g. "deepseek/deepseek-v4.1-flash")
 * is often served by several underlying inference providers (Qwen,
 * DeepInfra, Fireworks, ...), each with its own price and context length.
 * The bulk /models list (retrieveOpenAiCompatibleModels above) only
 * reports one aggregate price per model — this is OpenRouter's separate,
 * public, unauthenticated endpoint that lists the actual per-provider
 * breakdown: GET {baseUrl}/models/{author}/{slug}/endpoints. No API key
 * needed, and none of the other providers in this file have an
 * equivalent concept, so this stays OpenRouter-only.
 * @param {{ modelId: string, baseUrl?: string, fetchImpl?: Function, timeoutMs?: number }} options
 * @returns {Promise<Array<{ providerName: string, contextLength: number|null, pricing: { prompt: string|null, completion: string|null } }>>}
 */
async function retrieveOpenRouterModelEndpoints({ modelId, baseUrl, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl || fetch;
  const ms = timeoutMs || DEFAULT_TIMEOUT_MS;
  const base = String(baseUrl || OPENROUTER_ENDPOINTS_BASE_URL).replace(/\/+$/, '');
  const url = `${base}/models/${modelId}/endpoints`;

  let response;
  try {
    response = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    throw new Error('openrouter unreachable');
  }

  if (!response.ok) {
    if (response.status === 404) throw new Error('model not found');
    throw new Error('provider responded with an error');
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error('provider returned an unreadable response');
  }

  const endpoints = Array.isArray(data?.data?.endpoints) ? data.data.endpoints : [];
  return endpoints
    .map((e) => ({
      providerName: e.provider_name || e.name || '',
      contextLength: typeof e.context_length === 'number' ? e.context_length : null,
      pricing: {
        prompt: e.pricing?.prompt ?? null,
        completion: e.pricing?.completion ?? null,
      },
    }))
    .filter((e) => Boolean(e.providerName))
    .sort((a, b) => {
      const priceA = (Number(a.pricing.prompt) || 0) + (Number(a.pricing.completion) || 0);
      const priceB = (Number(b.pricing.prompt) || 0) + (Number(b.pricing.completion) || 0);
      return priceA - priceB;
    });
}


const DEEPINFRA_DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1/openai';

/**
 * DeepInfra model discovery — GET {baseUrl}/models, default
 * https://api.deepinfra.com/v1/openai/models.
 *
 * The list is public: no key is required, and a bogus Bearer is refused
 * with 401. Every entry is OpenAI-shaped at the top (`id, object, created,
 * owned_by, root, parent`) with everything worth showing nested in
 * `metadata`: `description`, `context_length`, `max_tokens`, `pricing`,
 * `discount` and `tags`. That is exactly why the generic OpenAI-compatible
 * normalizer showed nothing for DeepInfra — it reads `context_length`,
 * `pricing.prompt/completion`, `capabilities`, `architecture` and
 * `supported_parameters`, and none of those exist at that level here.
 *
 * Pricing units depend on the model kind and are not per token:
 *   - text models:  { input_tokens, output_tokens } — dollars per 1M tokens
 *                   (Llama-3.3-70B-Turbo 0.10/0.32, DeepSeek-V3 0.32/0.89,
 *                   matching DeepInfra's public price list on 2026-10-18)
 *   - image models: { per_image_unit } — dollars per image
 *   - speech:       { input_characters } — dollars per 1M characters
 * Only the per-token pair can be expressed in the internal USD-per-token
 * form the admin page formats; anything else is reported as not available
 * rather than turned into a wrong number.
 *
 * Tags map onto the capability vocabulary the page renders: vision|vlm ->
 * vision, reasoning|reasoning_effort -> reasoning, tts|stt -> audio,
 * video-gen -> video. `chat` describes the norm rather than a capability,
 * and `embed`, `image-gen` and `prompt_cache` have no equivalent.
 * See https://deepinfra.com/docs and https://api.deepinfra.com/openapi.json
 */
async function retrieveDeepInfraModels({ baseUrl, apiKey, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl || fetch;
  const url = `${String(baseUrl || DEEPINFRA_DEFAULT_BASE_URL).replace(/\/+$/, '')}/models`;
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error('deepinfra unreachable');
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error('authentication failed');
    throw new Error('provider responded with an error');
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error('provider returned an unreadable response');
  }

  const models = Array.isArray(data?.data) ? data.data : [];
  return models
    .map((m) => normalizeDeepInfraModel(m))
    .filter((m) => Boolean(m.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** DeepInfra tags -> the capability ids the admin page knows how to label. */
function deepInfraCapabilitiesFromTags(tags) {
  const caps = [];
  const has = (tag) => tags.includes(tag);
  if (has('vision') || has('vlm')) caps.push('vision');
  if (has('reasoning') || has('reasoning_effort')) caps.push('reasoning');
  if (has('tts') || has('stt')) caps.push('audio');
  if (has('video-gen')) caps.push('video');
  return caps;
}

/**
 * Dollars per 1M tokens -> the USD-per-token string the page formats.
 * Written as a plain decimal (0.0000001) rather than exponent notation, which
 * is the shape the other providers report and the shape the page documents.
 */
function perTokenFromPerMillion(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const perToken = n / 1e6;
  if (perToken === 0) return '0';
  const fixed = perToken.toFixed(15).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '0' ? '0' : fixed;
}

function normalizeDeepInfraModel(m) {
  const meta = (m && m.metadata) || {};
  const tags = Array.isArray(meta.tags) ? meta.tags.map((t) => String(t).toLowerCase()) : [];
  const pricing = meta.pricing || {};
  const id = m && m.id ? String(m.id) : '';
  const context = [meta.context_length, meta.max_tokens].find((v) => typeof v === 'number' && v > 0) || null;
  const description = typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : null;
  return {
    id,
    name: id,
    capabilities: deepInfraCapabilitiesFromTags(tags),
    contextLength: context,
    pricing: {
      prompt: perTokenFromPerMillion(pricing.input_tokens),
      completion: perTokenFromPerMillion(pricing.output_tokens),
    },
    description,
  };
}

module.exports = {
  retrieveModels,
  retrieveEdenAiModels,
  retrieveOpenAiCompatibleModels,
  retrieveMistralModels,
  retrieveOpenRouterModelEndpoints,
  normalizeEdenAiModel,
  normalizeOpenAiModel,
  normalizeMistralModel,
  retrieveDeepInfraModels,
  normalizeDeepInfraModel,
};
