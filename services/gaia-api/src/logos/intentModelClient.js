'use strict';

/**
 * IntentIQ's semantic-classification model client — deliberately separate
 * from hermesClient.js (Gaia's capability) and from
 * reasoningModelClient.js (ReasonIQ's own reasoning model). Intent
 * classification is a second, independent interpretation layer alongside
 * the existing heuristic classifier (intentIQ.js); it never calls Hermes,
 * never selects a capability, and is never selected or routed to by Gaia.
 * The two clients happen to share an OpenAI-compatible HTTP shape because
 * that shape is common infrastructure, not because IntentIQ depends on
 * Hermes or ReasonIQ — this file has no reference to either, and reads its
 * own, independent environment variables.
 *
 * Intent classification is meant to be cheap and fast (a small, structured
 * JSON judgment, not open-ended generation), so this client defaults to
 * forcing `response_format: json_object`, same posture as ReasonIQ's own
 * model client — see reasoningModelClient.js.
 *
 * Configuration (independent of HERMES_*, REASONIQ_MODEL_*, GAIA_NATIVE_*):
 *   GAIA_INTENT_BASE_URL   - OpenAI-compatible base URL. Unset = "no
 *                             semantic classifier configured"; IntentIQ
 *                             degrades to heuristic-only classification
 *                             rather than failing the turn (see
 *                             intentIQ.js's classifySemantic).
 *   GAIA_INTENT_MODEL      - model identifier sent to that endpoint.
 *   GAIA_INTENT_AUTH_TOKEN - optional bearer token.
 */

const DEFAULT_TIMEOUT_MS = 20000;

/** @param {NodeJS.ProcessEnv} [env] */
function readIntentModelConfig(env = process.env) {
  return {
    baseUrl: env.GAIA_INTENT_BASE_URL || '',
    model: env.GAIA_INTENT_MODEL || '',
    authToken: env.GAIA_INTENT_AUTH_TOKEN || '',
  };
}

/** @param {{ baseUrl: string, model: string }} config */
function isConfigured(config) {
  return Boolean(config.baseUrl && config.model);
}

/**
 * Creates IntentIQ's semantic-classification model client. `chat()`
 * requests a single, non-streaming, structured-JSON completion — intent
 * classification is a per-turn interpretation step, not a chat surface,
 * so there is no streaming concern here the way there is in
 * hermesClient.js.
 *
 * @param {{ baseUrl: string, model: string, authToken?: string, fetchImpl?: Function, timeoutMs?: number }} options
 * @returns {{ chat: (messages: Array) => Promise<string> }}
 */
function createIntentModelClient(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const model = options.model || '';
  const authToken = options.authToken || '';
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!baseUrl) {
    throw new Error('GAIA_INTENT_BASE_URL is required for semantic intent classification');
  }
  if (!model) {
    throw new Error('GAIA_INTENT_MODEL is required for semantic intent classification');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  /**
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<string>} the raw text content of the completion — the caller (intentIQ.js) parses/validates it, this client does not.
   */
  async function chat(messages) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, stream: false, messages, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`[intentIQ:model] unreachable at ${baseUrl}: ${error.message}`);
      throw new Error('intent model unreachable');
    }

    if (!response.ok) {
      console.error(`[intentIQ:model] responded ${response.status} at ${baseUrl}`);
      throw new Error('intent model responded with an error');
    }

    let data;
    try {
      data = await response.json();
    } catch (_) {
      console.error(`[intentIQ:model] unreadable response at ${baseUrl}`);
      throw new Error('intent model returned an unreadable response');
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : undefined;
    if (typeof content !== 'string' || content.length === 0) {
      console.error(`[intentIQ:model] no content in response at ${baseUrl}`);
      throw new Error('intent model returned no content');
    }
    return content;
  }

  return { chat };
}

/**
 * Composes readIntentModelConfig + isConfigured + createIntentModelClient
 * — mirrors gaiaGenerator.js's/mimoTts.js's/braveSearch.js's own
 * createFromEnv. Returns `undefined` when GAIA_INTENT_BASE_URL/
 * GAIA_INTENT_MODEL are unset, so IntentIQ can treat "no semantic
 * classifier available" the same uniform way every other optional
 * provider in this codebase is treated.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ chat: Function }|undefined}
 */
function createFromEnv(env = process.env) {
  const config = readIntentModelConfig(env);
  return isConfigured(config) ? createIntentModelClient(config) : undefined;
}

module.exports = { createIntentModelClient, readIntentModelConfig, isConfigured, createFromEnv };
