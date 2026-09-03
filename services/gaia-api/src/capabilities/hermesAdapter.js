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

function describeExpectedOutcome(expectedOutcome) {
  if (typeof expectedOutcome === 'string') return expectedOutcome.trim();
  if (expectedOutcome && typeof expectedOutcome.description === 'string') {
    return expectedOutcome.description.trim();
  }
  return '';
}

/**
 * Default translation of a generic request to Hermes messages: the contract
 * fields become explicit context the model can work with. Callers may inject
 * their own `buildMessages(request)`; the default stays dependency-free.
 */
function defaultBuildMessages(request) {
  const messages = [];
  const contextMessages = request.context && Array.isArray(request.context.messages)
    ? request.context.messages.filter((m) => m && typeof m.content === 'string')
    : [];
  messages.push({
    role: 'system',
    content: [
      `Objective: ${request.objective.trim()}`,
      `Expected outcome: ${describeExpectedOutcome(request.expected_outcome)}`,
    ].join('\n'),
  });
  if (typeof request.context?.skill === 'string' && request.context.skill.trim()) {
    messages.push({
      role: 'system',
      content: `Apply the capability skill "${request.context.skill.trim()}" for this task.`,
    });
  }
  for (const m of contextMessages) messages.push({ role: m.role || 'user', content: m.content });
  messages.push({ role: 'user', content: request.instruction.trim() });
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

  return { id, invokeCapability };
}

module.exports = { createHermesCapability, defaultBuildMessages };
