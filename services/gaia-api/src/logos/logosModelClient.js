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
const { identityHeadersFor } = require('../providerHeaders');

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
  // The new name wins, but a junk value in it must not erase a usable legacy
  // one: a typo would silently reset the budget to the default.
  for (const raw of [env.LOGOS_MODEL_TIMEOUT_MS, env.REASONIQ_MODEL_TIMEOUT_MS]) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return REASONING_TIMEOUT_MS;
}
// Backward-compat alias.
const readReasoningTimeoutMs = readLogosTimeoutMs;

const isTimeout = (error) => Boolean(error) && (error.name === 'TimeoutError' || error.name === 'AbortError');

/**
 * The provider answered 200 with nothing usable in `choices[0].message.content`.
 * Distinct from a transport failure because the cause is different and so is
 * the right response: the model (or its gateway) decided not to produce text,
 * which a fresh call often does produce. Logos retries this, and does not
 * retry a timeout — repeating a 20-second wait only buys the same wait again.
 */
class EmptyModelContentError extends Error {
  constructor() {
    super('logos model returned no content');
    this.name = 'EmptyModelContentError';
  }
}

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
 * DeepSeek-V4-Flash on DeepInfra answers `{}` — literally two characters — for
 * any large Logos prompt when `response_format: {"type":"json_object"}` is set,
 * and it does so in about a second. The very same prompt without that field
 * produces the whole analysis (measured 2026-10-23 on the real turn: 9 of 10
 * turns returned `{}` in json mode; 3 of 3 returned complete JSON without it).
 * So json mode is not asked for by default — the prompt already demands JSON,
 * and a code fence is cheaper to strip than a silently empty analysis is to
 * lose. LOGOS_RESPONSE_FORMAT=json asks for it again, for a provider that
 * genuinely needs the hint.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function defaultResponseFormat(env = process.env) {
  return env.LOGOS_RESPONSE_FORMAT === 'json' ? { type: 'json_object' } : null;
}

/**
 * Models that are not in json mode like to answer inside a ```json fence.
 * Stripping it is not a repair of the answer — the JSON inside is exactly what
 * the prompt asked for, and anything that is still wrong after this is caught
 * by the validator.
 */
function stripCodeFence(text) {
  const trimmed = String(text).trim();
  const fenced = /^```(?:json|javascript|js)?\s*\r?\n([\s\S]*?)\r?\n?```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Creates Logos's reasoning model client. `chat()` requests a single,
 * non-streaming, structured-JSON completion — Logos is a cognitive
 * step inside one turn, not a chat surface, so there is no streaming
 * concern here the way there is in hermesClient.js.
 *
 * @param {{ baseUrl?: string, model?: string, apiKey?: string, provider?: string, fetchImpl?: Function, timeoutMs?: number, logSystem?: string, logPurpose?: string, env?: NodeJS.ProcessEnv }} [options]
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
  const defaultFormat = defaultResponseFormat(options.env || process.env);
  // Which subsystem this client serves, for the llm.call log line. Logos's own
  // reflection is 'logos'; the Aion pass reuses this client but is a different
  // thing, so it labels its calls 'aion' — otherwise /admin's decision log shows
  // two "Logos reason" models and conflates them, as happened live.
  const logSystem = options.logSystem || 'logos';
  const logPurpose = options.logPurpose || 'reason';

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
        system: logSystem,
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        purpose: logPurpose,
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
    Object.assign(headers, identityHeadersFor(config.baseUrl));

    const responseFormat = options.responseFormat === undefined ? defaultFormat : options.responseFormat;
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
      throw new EmptyModelContentError();
    }
    logCall(true);
    return stripCodeFence(content);
  }

  return { chat, config, isConfigured: () => isConfigured(config) };
}

module.exports = { createLogosModelClient, createReasoningModelClient: createLogosModelClient, readLogosModelConfig, readReasoningModelConfig: readLogosModelConfig, readLogosTimeoutMs, readReasoningTimeoutMs, isConfigured, EmptyModelContentError, defaultResponseFormat, stripCodeFence };
