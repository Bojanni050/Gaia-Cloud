'use strict';

/**
 * Gaia's native generator — produces a Gaia-voiced reply directly, without
 * Hermes or any other capability.
 *
 * This is Gaia's own voice for turns the Decision Engine routes to `native`
 * (conversational, relational, simple). It talks to an OpenAI-compatible
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
 *   - Decide whether native generation should be used (the Decision Engine
 *     already made that call).
 *
 * Configuration (independent of HERMES_*):
 *   GAIA_NATIVE_BASE_URL   – OpenAI-compatible base URL.
 *   GAIA_NATIVE_MODEL      – model identifier sent to that endpoint.
 *   GAIA_NATIVE_AUTH_TOKEN  – optional bearer token.
 */

const DEFAULT_TIMEOUT_MS = 60000;

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
 * }} options
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
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<string>}
   */
  async function generate(messages) {
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
      throw new Error('native generator unreachable');
    }

    if (!response.ok) {
      console.error(`[gaia:native] responded ${response.status} at ${baseUrl}`);
      throw new Error('native generator responded with an error');
    }

    let data;
    try {
      data = await response.json();
    } catch (_) {
      console.error(`[gaia:native] unreadable response at ${baseUrl}`);
      throw new Error('native generator returned an unreadable response');
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : undefined;
    if (typeof content !== 'string' || content.length === 0) {
      console.error(`[gaia:native] no content in response at ${baseUrl}`);
      throw new Error('native generator returned no content');
    }
    return content;
  }

  /**
   * Streaming generation — calls `onDelta(chunk, isReasoning)` per token
   * and resolves with the full accumulated text. Same shape as
   * hermesClient.js's `stream()` so the Orchestrator/Response Engine seam
   * treats them identically.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ signal?: AbortSignal, onDelta?: (chunk: string, isReasoning?: boolean) => void }} [options]
   * @returns {Promise<string>}
   */
  async function stream(messages, { signal, onDelta } = {}) {
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
      throw new Error('native generator unreachable');
    }

    if (!response.ok || !response.body) {
      console.error(`[gaia:native] stream responded ${response.status} at ${baseUrl}`);
      throw new Error('native generator responded with an error');
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
      throw new Error('native generator stream failed');
    }

    if (fullText.length === 0) {
      console.error(`[gaia:native] stream produced no content at ${baseUrl}`);
      throw new Error('native generator returned no content');
    }
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
 * @returns {{ generate: Function, stream: Function }|undefined}
 */
function createFromEnv(env = process.env) {
  const config = readNativeConfig(env);
  return isConfigured(config) ? createGaiaGenerator(config) : undefined;
}

module.exports = { createGaiaGenerator, readNativeConfig, isConfigured, createFromEnv };
