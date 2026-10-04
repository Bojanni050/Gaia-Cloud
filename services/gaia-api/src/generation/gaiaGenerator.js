'use strict';

/**
 * Gaia's native generator — produces a Gaia-voiced reply directly, without
 * Hermes or any other capability.
 *
 * This is Gaia's own voice on the live path: direct generation of a
 * conversational, relational, simple reply. It talks to an OpenAI-compatible
 * `/chat/completions` endpoint configured independently of Hermes — same
 * HTTP shape (because that shape is common infrastructure), completely
 * separate wiring (own base URL, own model, own auth token).
 *
 * What this module does:
 *   - Generates a Gaia-voiced reply from a message list that already
 *     includes the SOUL system prompt, memory context, and conversation
 *     history (assembled by turn.js, exactly like it does for Hermes).
 *   - Supports both non-streaming (`generate`) and streaming (`stream`).
 *
 * What this module does NOT do:
 *   - Choose capabilities or tools.
 *   - Run IntentIQ, ReasonIQ, or Hindsight.
 *   - Call Hermes (directly or indirectly).
 *   - Perform orchestration of any kind.
 *   - Decide whether native generation should be used (the turn always uses
 *     it on the live path; there is no routing decision to make here).
 *
 * Configuration (independent of HERMES_*):
 *   GAIA_NATIVE_BASE_URL   – OpenAI-compatible base URL.
 *   GAIA_NATIVE_MODEL      – model identifier sent to that endpoint.
 *   GAIA_NATIVE_AUTH_TOKEN  – optional bearer token.
 */

const { logLlmCall } = require('../logos/llmCallLog');

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Typed generation error — internal only, never reaches the client
 * (responseEngine.toCalmError owns the client wording). Carries the HTTP
 * status and a retryable flag so the failover seam
 * (generationFailover.js) can decide primary → backup without leaking
 * provider details.
 */
class GenerationError extends Error {
  constructor(message, { status = null, retryable = false, code = null } = {}) {
    super(message);
    this.name = 'GenerationError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

function isTimeoutError(error) {
  return Boolean(
    error
    && (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

/**
 * Failover policy: retry on the backup for timeouts, network failures,
 * 429 and 5xx. Never for config errors or other 4xx.
 * @param {Error} error
 * @returns {boolean}
 */
function isRetryableGenerationError(error) {
  if (!error) return false;
  if (error instanceof GenerationError) return error.retryable === true;
  return false;
}

/**
 * Reads native generator configuration from environment variables.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, model: string, authToken: string }}
 */
function readNativeConfig(env = process.env) {
  return {
    baseUrl: env.GAIA_NATIVE_BASE_URL || '',
    model: env.GAIA_NATIVE_MODEL || '',
    authToken: env.GAIA_NATIVE_AUTH_TOKEN || '',
  };
}

/**
 * @param {{ baseUrl: string, model: string }} config
 * @returns {boolean}
 */
function isConfigured(config) {
  return Boolean(config.baseUrl && config.model);
}

/**
 * Creates Gaia's native generator.
 *
 * @param {{
 *   baseUrl: string,
 *   model: string,
 *   authToken?: string,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   logger?: (line: string) => void,
 * }} options `logger` is bound once here rather than passed per-call: unlike
 *   IntentIQ/ReasonIQ (which get a fresh per-turn logger from turn.js
 *   threaded through their own options), the native generator is a
 *   singleton constructed once at server startup and invoked from the turn
 *   with no logger in scope there — so server.js supplies
 *   the same console.log+decisionStore sink at construction time instead.
 * @returns {{
 *   generate: (messages: Array<{role: string, content: string}>, options?: object) => Promise<string>,
 *   stream: (messages: Array<{role: string, content: string}>, options?: { onDelta?: Function }) => Promise<string>,
 * }}
 */
function createGaiaGenerator(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const model = options.model || '';
  const authToken = options.authToken || '';
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const logger = options.logger;

  const logCall = (ok, errorMessage, latencyMs, purpose) => {
    if (!logger) return;
    logLlmCall({
      system: 'native',
      provider: 'gaia-native',
      baseUrl,
      model,
      purpose,
      latencyMs,
      ok,
      errorMessage: errorMessage || null,
    }, logger);
  };

  if (!baseUrl) {
    throw new Error('GAIA_NATIVE_BASE_URL is required for native generation');
  }
  if (!model) {
    throw new Error('GAIA_NATIVE_MODEL is required for native generation');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  /**
   * Non-streaming generation — returns the full reply as a string.
   * @param {Array<{role: string, content: string|Array}>} messages
   * @returns {Promise<string>}
   */
  async function generate(messages) {
    const startedAt = Date.now();
    // Diagnostic logging (temporary)
    const imageBlockPresent = messages.some((m) =>
      Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')
    );
    console.log(JSON.stringify({
      kind: 'vision.trace',
      stage: 'native_generator',
      model,
      messageCount: messages.length,
      imageBlockPresent,
    }));

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, stream: false, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`[gaia:native] unreachable at ${baseUrl}: ${error.message}`);
      logCall(false, 'unreachable', Date.now() - startedAt, 'generate');
      if (isTimeoutError(error)) {
        throw new GenerationError('native generator timed out', { retryable: true, code: 'timeout' });
      }
      throw new GenerationError('native generator unreachable', { retryable: true, code: 'network' });
    }

    if (!response.ok) {
      const status = typeof response.status === 'number' ? response.status : null;
      console.error(`[gaia:native] responded ${response.status} at ${baseUrl}`);
      logCall(false, `HTTP ${response.status}`, Date.now() - startedAt, 'generate');
      const retryable = status === 429 || (typeof status === 'number' && status >= 500);
      throw new GenerationError('native generator responded with an error', { status, retryable });
    }

    let data;
    try {
      data = await response.json();
    } catch (_) {
      console.error(`[gaia:native] unreadable response at ${baseUrl}`);
      logCall(false, 'unreadable response', Date.now() - startedAt, 'generate');
      throw new GenerationError('native generator returned an unreadable response', { retryable: false, code: 'unreadable' });
    }

    // Raw response logging — always visible in docker logs, never to the client.
    console.log(JSON.stringify({
      kind: 'native.raw_response',
      model,
      status: response.status,
      data,
    }));

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : undefined;
    if (typeof content !== 'string' || content.length === 0) {
      console.error(`[gaia:native] no content in response at ${baseUrl}`);
      logCall(false, 'no content in response', Date.now() - startedAt, 'generate');
      throw new GenerationError('native generator returned no content', { retryable: false, code: 'no_content' });
    }
    logCall(true, null, Date.now() - startedAt, 'generate');
    return content;
  }

  /**
   * Streaming generation — calls `onDelta(chunk, isReasoning)` per token
   * and resolves with the full accumulated text. Same shape as
   * hermesClient.js's `stream()` so the Response Engine seam
   * treats them identically.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ signal?: AbortSignal, onDelta?: (chunk: string, isReasoning?: boolean) => void }} [options]
   * @returns {Promise<string>}
   */
  async function stream(messages, { signal, onDelta } = {}) {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, stream: true, messages }),
        signal,
      });
    } catch (error) {
      console.error(`[gaia:native] stream unreachable at ${baseUrl}: ${error.message}`);
      logCall(false, 'unreachable', Date.now() - startedAt, 'stream');
      if (isTimeoutError(error)) {
        throw new GenerationError('native generator timed out', { retryable: true, code: 'timeout' });
      }
      throw new GenerationError('native generator unreachable', { retryable: true, code: 'network' });
    }

    if (!response.ok || !response.body) {
      const status = typeof response.status === 'number' ? response.status : null;
      console.error(`[gaia:native] stream responded ${response.status} at ${baseUrl}`);
      logCall(false, `HTTP ${response.status}`, Date.now() - startedAt, 'stream');
      const retryable = status === 429 || (typeof status === 'number' && status >= 500);
      throw new GenerationError('native generator responded with an error', { status, retryable });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');

        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const delta = parseSseFrame(frame);
          if (!delta) continue;
          if (delta.content) {
            fullText += delta.content;
            if (onDelta) onDelta(delta.content, false);
          }
          if (delta.reasoning) {
            if (onDelta) onDelta(delta.reasoning, true);
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error(`[gaia:native] stream read failed at ${baseUrl}: ${error.message}`);
      logCall(false, 'stream read failed', Date.now() - startedAt, 'stream');
      throw new GenerationError('native generator stream failed', { retryable: true, code: 'stream_read' });
    }

    if (fullText.length === 0) {
      console.error(`[gaia:native] stream produced no content at ${baseUrl}`);
      logCall(false, 'no content in response', Date.now() - startedAt, 'stream');
      throw new GenerationError('native generator returned no content', { retryable: false, code: 'no_content' });
    }
    logCall(true, null, Date.now() - startedAt, 'stream');
    return fullText;
  }

  return { generate, stream };
}

/** @param {string} frame */
function parseSseFrame(frame) {
  const lines = frame.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    try {
      const obj = JSON.parse(payload);
      const delta = obj?.choices?.[0]?.delta;
      if (delta) {
        return {
          content: delta.content || '',
          reasoning: delta.reasoning_content || '',
        };
      }
    } catch (_) { /* malformed frame, skip */ }
  }
  return null;
}

/**
 * Composes readNativeConfig + isConfigured + createGaiaGenerator into the
 * one call server.js needs: a ready-to-use native generator when
 * GAIA_NATIVE_BASE_URL/GAIA_NATIVE_MODEL are set, or `undefined` when they
 * are not — the same "leave unset to route everything through Hermes"
 * degrade this module has always documented (see .env.example). Callers
 * should treat `undefined` as "no native generator available" and simply
 * omit it, exactly like an omitted `tools` param elsewhere in this codebase.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(line: string) => void} [logger] forwarded to createGaiaGenerator
 *   for llm.call logging — see its own doc comment for why this is bound
 *   at construction rather than passed per-call.
 * @returns {{ generate: Function, stream: Function }|undefined}
 */
function createFromEnv(env = process.env, logger) {
  const config = readNativeConfig(env);
  return isConfigured(config) ? createGaiaGenerator({ ...config, logger }) : undefined;
}

module.exports = { createGaiaGenerator, readNativeConfig, isConfigured, createFromEnv, GenerationError, isRetryableGenerationError };
