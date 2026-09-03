'use strict';

/**
 * Hermes capability adapter (P0 — Gaia-roadmap).
 *
 * Hermes is the FIRST implementation of the generic Logos ↔ Capability
 * contract (logos/capabilityContract.js) — never the contract itself. This
 * module is the only place that knows how Hermes is invoked (the existing
 * `{ chat, stream }` interface of src/hermesClient.js, as wired in
 * src/turn.js) and translates in both directions:
 *
 *   generic CapabilityRequest  →  Hermes messages (chat/stream payload)
 *   Hermes string / throw      →  generic CapabilityResult
 *
 * All Hermes-specific details (message roles, skill-instruction phrasing,
 * chat-vs-stream selection) live here and nowhere else. Logos
 * (logos/capabilityContract.js, logos/capabilityLoop.js) only ever sees the
 * generic `{ id, invokeCapability }` adapter interface, so a future
 * capability can ship its own adapter without touching the contract.
 *
 * Reuses the existing Hermes interface unchanged — no change to
 * hermesClient.js, no change to the live turn.js wiring (P0 introduces the
 * contract path alongside it; rewiring the live turn is not part of P0).
 */

const { validateCapabilityRequest, toCapabilityResult } = require('../logos/capabilityContract');
const { runCapabilityLoop } = require('../logos/capabilityLoop');

/** Last string user turn — the instruction fallback for the legacy shape. */
function lastUserString(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return null;
}

function describeExpectedOutcome(expectedOutcome) {
  if (typeof expectedOutcome === 'string') return expectedOutcome.trim();
  if (expectedOutcome && typeof expectedOutcome.description === 'string') {
    return expectedOutcome.description.trim();
  }
  return '';
}

/**
 * Default translation of a generic request to Hermes messages.
 *
 * When the runtime hands over assembled messages (the normal path), they
 * pass through VERBATIM — same order, same content blocks, multimodal
 * included — so the Hermes payload is byte-for-byte what it always was.
 * Only two narrow additions ever apply, both after the leading system
 * messages / at the tail, mirroring the previous turn.js wiring:
 *
 *   - a selected skill becomes the explicit skill instruction;
 *   - a REFORMULATED instruction (retry loop `alternative`) is appended as
 *     a final user note, so the new approach actually reaches Hermes. An
 *     unchanged instruction is never duplicated.
 *
 * Without assembled messages (direct adapter use) the payload is built
 * from objective/instruction/expected_outcome instead. Callers may inject
 * their own `buildMessages(request)`; the default stays dependency-free.
 */
function defaultBuildMessages(request) {
  const contextMessages = request.context && Array.isArray(request.context.messages)
    ? request.context.messages.filter((m) => m && typeof m.role === 'string' && 'content' in m)
    : [];
  const skill = request.context && typeof request.context.skill === 'string' && request.context.skill.trim()
    ? request.context.skill.trim()
    : null;

  if (contextMessages.length === 0) {
    const messages = [{
      role: 'system',
      content: [
        `Objective: ${String(request.objective || '').trim()}`,
        `Expected outcome: ${describeExpectedOutcome(request.expected_outcome)}`,
      ].join('\n'),
    }];
    if (skill) {
      messages.push({
        role: 'system',
        content: `Use the Hermes skill "${skill}" for this task. Load and execute that skill yourself.`,
      });
    }
    messages.push({ role: 'user', content: String(request.instruction || '').trim() });
    return messages;
  }

  const messages = contextMessages.map((m) => ({ role: m.role, content: m.content }));
  if (skill) {
    // Same explicit skill instruction the runtime has always sent
    // (previously assembled in turn.js): Hermes loads and executes the
    // skill itself. Centralized here so this adapter stays the single
    // translation site.
    let insertAt = 0;
    while (insertAt < messages.length && messages[insertAt] && messages[insertAt].role === 'system') insertAt += 1;
    messages.splice(insertAt, 0, {
      role: 'system',
      content: `Use the Hermes skill "${skill}" for this task. Load and execute that skill yourself.`,
    });
  }
  // Append the instruction only when it carries something new (an
  // `alternative` reformulation). The initial instruction already is the
  // last user turn — duplicating it would change every payload for nothing.
  const last = messages[messages.length - 1];
  const lastUserText = last && last.role === 'user' && typeof last.content === 'string' ? last.content : null;
  const instruction = String(request.instruction || '').trim();
  if (lastUserText !== null && instruction && instruction !== lastUserText) {
    messages.push({ role: 'user', content: instruction });
  }
  return messages;
}

/**
 * @param {{
 *   hermes: { chat?: Function, stream?: Function }, // existing Hermes interface
 *   buildMessages?: (request: object) => Array,     // optional message translation override
 *   id?: string,                                    // adapter id (default 'hermes')
 * }} options
 * @returns {{ id: string, invokeCapability: (request: object) => Promise<object> }}
 */
function createHermesCapability({ hermes, buildMessages = defaultBuildMessages, id = 'hermes' } = {}) {
  if (!hermes || (typeof hermes.chat !== 'function' && typeof hermes.stream !== 'function')) {
    throw new Error('createHermesCapability requires a hermes client with chat() and/or stream()');
  }
  if (typeof buildMessages !== 'function') {
    throw new Error('createHermesCapability requires buildMessages to be a function');
  }

  async function invokeCapability(request, options = {}) {
    const problem = validateCapabilityRequest(request);
    if (problem) {
      return {
        ok: false, technicalSuccess: false, output: null,
        error: `invalid capability request: ${problem}`,
        requiresUserInput: false, missingInfo: null,
      };
    }
    let messages;
    try {
      messages = buildMessages(request);
    } catch (err) {
      return {
        ok: false, technicalSuccess: false, output: null,
        error: `could not translate capability request: ${String((err && err.message) || err)}`,
        requiresUserInput: false, missingInfo: null,
      };
    }
    try {
      // turn.js parity: streamed when the caller wants deltas, chat otherwise.
      const output = (options.onDelta && typeof hermes.stream === 'function')
        ? await hermes.stream(messages, { onDelta: options.onDelta })
        : (typeof hermes.chat === 'function'
          ? await hermes.chat(messages)
          : await hermes.stream(messages, {}));
      return toCapabilityResult(output);
    } catch (err) {
      return toCapabilityResult({ ok: false, error: String((err && err.message) || err) });
    }
  }

  /**
   * Backward-compatible `{ invoke(messages, options) }` shape for callers
   * that predate the contract (custom orchestrate injections, external
   * consumers). NOT a second loop or a second translation: it synthesizes
   * a neutral default request and runs the SAME loop through the SAME
   * `invokeCapability` above, then returns the raw output string — throwing
   * on failure exactly like the old direct call did.
   */
  async function invoke(messages, options = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const request = {
      objective: (options && typeof options.task === 'string' && options.task) || 'respond',
      instruction: lastUserString(list) || 'respond',
      expected_outcome: { description: 'A completed Hermes response', minLength: 1 },
      context: {
        messages: list,
        ...(options && typeof options.skill === 'string' && options.skill ? { skill: options.skill } : {}),
      },
    };
    const loop = await runCapabilityLoop({
      request,
      adapter: { id, invokeCapability },
      max_attempts: options && options.max_attempts,
      adapterOptions: { onDelta: options && options.onDelta },
    });
    if (loop.verdict === 'success' && loop.lastResult) {
      return loop.lastResult.data !== undefined ? loop.lastResult.data : loop.lastResult.output;
    }
    throw new Error((loop.lastEvaluation && loop.lastEvaluation.reason) || 'hermes execution failed');
  }

  return { id, invokeCapability, invoke };
}

module.exports = { createHermesCapability, defaultBuildMessages };
