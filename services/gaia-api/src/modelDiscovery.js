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
 *
 * The provider string determines which adapter is used. Unknown providers
 * fall back to the OpenAI-compatible pattern, which covers OpenRouter,
 * OpenAI, and most OpenAI-compatible endpoints.
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
  // OpenRouter-specific: check architecture or provider hints
  if (m.architecture) {
    if (m.architecture.modality && m.architecture.modality.includes('image')) {
      if (!caps.includes('vision')) caps.push('vision');
    }
  }
  return {
    id: m.id || '',
    name: m.name || m.id || '',
    capabilities: caps,
  };
}

module.exports = {
  retrieveModels,
  retrieveEdenAiModels,
  retrieveOpenAiCompatibleModels,
  retrieveMistralModels,
  normalizeEdenAiModel,
  normalizeOpenAiModel,
  normalizeMistralModel,
};
