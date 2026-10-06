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
 *   - Optionally runs a bounded tool loop: when `tools` + `onToolCall` are
 *     supplied, the model may call a tool; the call is executed here and the
 *     result fed back, and the final text is what the caller receives — the
 *     return type stays a plain string, so callers never see the machinery.
 *     Only the primary generator gets tools; the backup stays a plain
 *     inference provider.
 *
 * What this module does NOT do:
 *   - Choose capabilities or decide memory (the caller supplies the tools).
 *   - Run IntentIQ, ReasonIQ, or Hindsight.
 *   - Call Hermes (directly or indirectly).
 *   - Perform orchestration of any kind.
 *
 * Configuration (independent of HERMES_*):
 *   GAIA_NATIVE_BASE_URL   – OpenAI-compatible base URL.
 *   GAIA_NATIVE_MODEL      – model identifier sent to that endpoint.
 *   GAIA_NATIVE_AUTH_TOKEN  – optional bearer token.
 */

const { logLlmCall } = require('../logos/llmCallLog');

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_TOOL_ROUNDS = 3;

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

/** One tool call in the OpenAI-compatible shape, flattened to what we need. */
function normalizeToolCall(tc) {
  return {
    id: tc && tc.id ? tc.id : '',
    name: tc && tc.function && tc.function.name ? tc.function.name : '',
    arguments: tc && tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : '',
  };
}

/** Tolerant parse of a tool call's arguments — a bad blob is an empty object. */
function parseToolArguments(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** Accumulate streamed tool_call deltas by their `index`. */
function accumulateToolCalls(acc, deltas) {
  for (const delta of deltas) {
    const idx = typeof delta.index === 'number' ? delta.index : acc.length;
    const slot = acc[idx] || (acc[idx] = { id: '', name: '', arguments: '' });
    if (delta.id) slot.id = delta.id;
    if (delta.function && delta.function.name) slot.name = delta.function.name;
    if (delta.function && typeof delta.function.arguments === 'string') slot.arguments += delta.function.arguments;
  }
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
 *   tools?: Array<object>,           OpenAI-compatible tool schemas
 *   onToolCall?: (name: string, args: object) => Promise<string>|string,
 *   maxToolRounds?: number,
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
  const tools = Array.isArray(options.tools) && options.tools.length > 0 ? options.tools : null;
  const onToolCall = typeof options.onToolCall === 'function' ? options.onToolCall : null;
  const maxToolRounds = Number.isInteger(options.maxToolRounds) && options.maxToolRounds >= 0
    ? options.maxToolRounds
    : DEFAULT_MAX_TOOL_ROUNDS;
  const toolsAvailable = Boolean(tools && onToolCall);

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

  function requestBody(messages, stream, withTools) {
    const body = { model, stream, messages };
    if (withTools) body.tools = tools;
    return body;
  }

  /** One non-streaming request. Returns { content, toolCalls }. */
  async function postNonStreaming(messages, withTools) {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody(messages, false, withTools)),
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

    console.log(JSON.stringify({
      kind: 'native.raw_response',
      model,
      status: response.status,
      data,
    }));

    const message = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
    const content = typeof message.content === 'string' ? message.content : '';
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map(normalizeToolCall) : [];
    logCall(true, null, Date.now() - startedAt, 'generate');
    return { content, toolCalls };
  }

  /** One streaming request; forwards content via onDelta. Returns { content, toolCalls }. */
  async function postStreaming(messages, { signal, onDelta }, withTools) {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody(messages, true, withTools)),
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
    const toolCalls = [];

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
          if (delta.toolCalls && delta.toolCalls.length > 0) {
            accumulateToolCalls(toolCalls, delta.toolCalls);
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error(`[gaia:native] stream read failed at ${baseUrl}: ${error.message}`);
      logCall(false, 'stream read failed', Date.now() - startedAt, 'stream');
      throw new GenerationError('native generator stream failed', { retryable: true, code: 'stream_read' });
    }

    logCall(true, null, Date.now() - startedAt, 'stream');
    return { content: fullText, toolCalls: toolCalls.filter(Boolean).map((c) => normalizeToolCall({ id: c.id, function: { name: c.name, arguments: c.arguments } })) };
  }

  /** Execute the tool calls of one round and append the assistant + tool messages. */
  async function appendToolRound(messages, assistantContent, calls) {
    const assistantMessage = {
      role: 'assistant',
      content: assistantContent || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      })),
    };
    const toolMessages = [];
    for (const call of calls) {
      let resultText = 'Unknown action.';
      try {
        resultText = String((await onToolCall(call.name, parseToolArguments(call.arguments))) || 'Done.');
      } catch (error) {
        resultText = 'That could not be done.';
        console.warn(`[gaia:native] tool ${call.name} failed: ${error.message}`);
      }
      toolMessages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
    return [...messages, assistantMessage, ...toolMessages];
  }

  /**
   * Run generation, looping through at most `maxToolRounds` tool calls. A
   * provider that rejects `tools` outright (4xx) is retried once without
   * them, so an unsupported endpoint degrades instead of failing the turn.
   * Always resolves with the final plain text.
   */
  async function runToolLoop(messages, mode) {
    let current = messages;
    let withTools = toolsAvailable;
    let toolRounds = 0;
    let fallbackUsed = false;

    for (;;) {
      let result;
      try {
        result = mode.stream
          ? await postStreaming(current, mode, withTools)
          : await postNonStreaming(current, withTools);
      } catch (error) {
        const toolsRejected = withTools
          && error instanceof GenerationError
          && typeof error.status === 'number' && error.status >= 400 && error.status < 500;
        if (toolsRejected && !fallbackUsed) {
          fallbackUsed = true;
          withTools = false;
          console.warn(`[gaia:native] tools rejected (HTTP ${error.status}); retrying without tools`);
          continue;
        }
        throw error;
      }

      const calls = withTools ? result.toolCalls : [];
      if (calls.length === 0) {
        if (!result.content) {
          console.error(`[gaia:native] no content in response at ${baseUrl}`);
          throw new GenerationError('native generator returned no content', { retryable: false, code: 'no_content' });
        }
        return result.content;
      }
      if (toolRounds >= maxToolRounds) {
        if (result.content) return result.content;
        throw new GenerationError('native generator exhausted tool rounds', { retryable: false, code: 'tool_rounds' });
      }
      toolRounds += 1;
      current = await appendToolRound(current, result.content, calls);
    }
  }

  const toolNames = tools
    ? tools.map((t) => t && t.function && t.function.name).filter(Boolean)
    : [];

  return {
    generate: (messages) => runToolLoop(messages, { stream: false }),
    stream: (messages, { signal, onDelta } = {}) => runToolLoop(messages, { stream: true, signal, onDelta }),
    toolNames,
  };
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
          toolCalls: Array.isArray(delta.tool_calls) ? delta.tool_calls : [],
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
 * @param {object} [extra] extra createGaiaGenerator options (e.g. tools +
 *   onToolCall) merged over the env-derived config.
 * @returns {{ generate: Function, stream: Function }|undefined}
 */
function createFromEnv(env = process.env, logger, extra = {}) {
  const config = readNativeConfig(env);
  return isConfigured(config) ? createGaiaGenerator({ ...config, logger, ...extra }) : undefined;
}

module.exports = {
  createGaiaGenerator,
  readNativeConfig,
  isConfigured,
  createFromEnv,
  GenerationError,
  isRetryableGenerationError,
  parseToolArguments,
  accumulateToolCalls,
  parseSseFrame,
};
