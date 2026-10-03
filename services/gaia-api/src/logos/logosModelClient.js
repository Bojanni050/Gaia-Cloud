'use strict';

/**
 * Logos's model client — the single OpenAI-compatible chat seam behind the
 * unified V3 Logos faculty (and, separately, OCR/vision transcription via
 * ocrResolver.js, which reuses the same provider credentials with its own
 * vision model id). Deliberately separate from hermesClient.js: Hermes is
 * a capability Gaia may task explicitly; this client is part of Logos's
 * own cognitive implementation and Gaia's background reflection.
 *
 * Configuration arrives as explicit { provider, baseUrl, model, apiKey }
 * — resolved by the caller from the unified provider roles
 * (providerStore.js role 'reasoning', 'vision' for OCR) with
 * REASONIQ_MODEL_* env vars as the ops-level fallback. Unset baseUrl/model
 * = "no model configured"; Logos degrades to shallow-only reflection
 * rather than failing the turn.
 */

const { logLlmCall } = require('./llmCallLog');

const DEFAULT_TIMEOUT_MS = 60000;

// Logos's own budget for one reasoning call. A failed call degrades to a
// shallow result, so waiting a full minute on a slow or queued model (seen
// on free OpenRouter models) only delays the turn for nothing. The client
// default above stays generous because the same client also serves OCR.
const REASONING_TIMEOUT_MS = 20000;

/**
 * @param {NodeJS.ProcessEnv} env REASONIQ_MODEL_TIMEOUT_MS overrides the default
 * @returns {number}
 */
function readLogosTimeoutMs(env = process.env) {
  const n = Number(env.LOGOS_MODEL_TIMEOUT_MS ?? env.REASONIQ_MODEL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : REASONING_TIMEOUT_MS;
}
// Backward-compat alias.
const readReasoningTimeoutMs = readLogosTimeoutMs;

const isTimeout = (error) => Boolean(error) && (error.name === 'TimeoutError' || error.name === 'AbortError');

/** @param {NodeJS.ProcessEnv} env */
function readLogosModelConfig(env = process.env) {
  return {
    provider: env.REASONIQ_MODEL_PROVIDER || 'openai-compatible',
    baseUrl: env.REASONIQ_MODEL_BASE_URL || '',
    model: env.REASONIQ_MODEL_NAME || '',
    apiKey: env.REASONIQ_MODEL_API_KEY || '',
  };
}

function isConfigured(config) {
  return Boolean(config.baseUrl && config.model);
}

/**
 * Creates Logos's reasoning model client. `chat()` requests a single,
 * non-streaming, structured-JSON completion — Logos is a cognitive
 * step inside one turn, not a chat surface, so there is no streaming
 * concern here the way there is in hermesClient.js.
 *
 * @param {{ baseUrl?: string, model?: string, apiKey?: string, provider?: string, fetchImpl?: Function, timeoutMs?: number }} [options]
 */
function createLogosModelClient(options = {}) {
  const config = {
    provider: options.provider || 'openai-compatible',
    baseUrl: String(options.baseUrl || '').replace(/\/+$/, ''),
    model: options.model || '',
    apiKey: options.apiKey || '',
  };
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  /**
   * @param {Array<{role: string, content: string|Array<object>}>} messages content may be a plain string, or an OpenAI-compatible content-block array (e.g. for image_url blocks — see ocrResolver.js)
   * @param {{ responseFormat?: object|null, logger?: (line: string) => void, contextId?: string|null, correlationId?: string|null }} [options] Defaults to forcing `{type:"json_object"}`, Logos's own need — omitted from the request entirely, not just unset, when explicitly passed `null` (e.g. a freeform-text caller like OCR that isn't asking Logos's structured-output question). `logger` is the same per-turn sink reasonIQ.js's evaluate() receives for logReasoningResult — forwarded here so an actual LLM call gets logged too (kind 'llm.call'), distinct from the reasoning result itself. `contextId`/`correlationId` come from the reasoning input, so an actual call can be tied to the turn it served in the admin log.
   * @returns {Promise<string>} the raw text content of the completion — the caller parses/validates it, this client does not.
   */
  async function chat(messages, options = {}) {
    const startedAt = Date.now();
    const logCall = (ok, errorMessage) => {
      if (!options.logger) return;
      logLlmCall({
        system: 'logos',
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        purpose: 'reason',
        latencyMs: Date.now() - startedAt,
        ok,
        errorMessage: errorMessage || null,
        contextId: options.contextId || null,
        correlationId: options.correlationId || null,
      }, options.logger);
    };

    if (!isConfigured(config)) {
      throw new Error('logos model not configured (provider role "reasoning" or REASONIQ_MODEL_BASE_URL / REASONIQ_MODEL_NAME unset)');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const responseFormat = options.responseFormat === undefined ? { type: 'json_object' } : options.responseFormat;
    const body = { model: config.model, stream: false, messages };
    if (responseFormat) body.response_format = responseFormat;

    let response;
    try {
      response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`[logos:model] unreachable at ${config.baseUrl}: ${error.message}`);
      logCall(false, isTimeout(error) ? 'timeout' : 'unreachable');
      throw new Error('logos model unreachable');
    }

    if (!response.ok) {
      console.error(`[logos:model] responded ${response.status} at ${config.baseUrl}`);
      logCall(false, `HTTP ${response.status}`);
      throw new Error('logos model responded with an error');
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      // The timeout also covers reading the body: a model that sends headers
      // and then stalls surfaces here, not in the fetch above.
      console.error(`[logos:model] unreadable response at ${config.baseUrl}`);
      logCall(false, isTimeout(error) ? 'timeout' : 'unreadable response');
      throw new Error('logos model returned an unreadable response');
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : undefined;
    if (typeof content !== 'string' || content.length === 0) {
      console.error(`[logos:model] no content in response at ${config.baseUrl}`);
      logCall(false, 'no content in response');
      throw new Error('logos model returned no content');
    }
    logCall(true);
    return content;
  }

  return { chat, config, isConfigured: () => isConfigured(config) };
}

module.exports = { createLogosModelClient, createReasoningModelClient: createLogosModelClient, readLogosModelConfig, readReasoningModelConfig: readLogosModelConfig, readLogosTimeoutMs, readReasoningTimeoutMs, isConfigured };
