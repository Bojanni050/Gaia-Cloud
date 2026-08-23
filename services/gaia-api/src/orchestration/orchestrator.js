'use strict';

/**
 * The Orchestrator — executes a Decision (decision/decisionEngine.js). It
 * makes no judgment calls of its own: no "this looks hard, let's use
 * Hermes" logic lives here. Given the same Decision, it always does the
 * same thing.
 *
 *   native      -> invoke the native generator (gaiaGenerator.js) when
 *                   available; structured error when not configured
 *   capability  -> resolve the named capability and invoke it
 *   tool        -> resolve the named tool capability and invoke it (same
 *                   resolution path as `capability` — a tool is just a
 *                   capability whose id happens to be tool-shaped)
 *   clarify     -> structured result, no capability call
 *   refuse      -> structured result, no capability call
 *
 * A capability's raw output is returned as-is; this module never touches
 * capability internals (retries, provider routing, streaming framing) and
 * never writes to a response itself — see responseEngine.js for the seam
 * that turns an ExecutionResult into what the client actually sees.
 */

const { validateDecision } = require('../decision/decisionSchema');

/**
 * @typedef {Object} ExecutionResult
 * @property {'native'|'capability'|'tool'|'clarify'|'refuse'} action
 * @property {string} [capability]
 * @property {*} [output] - the capability's raw result, or null when none was called
 * @property {string} [error] - set when a named capability/tool was not available
 * @property {string} [reason] - carried through from the Decision, for clarify/refuse
 */

/**
 * @param {import('../decision/decisionSchema').Decision} decision
 * @param {{
 *   capabilities?: Record<string, { invoke: (messages: Array, options?: object) => Promise<*> }>,
 *   nativeGenerator?: { generate: Function, stream?: Function },
 *   messages?: Array,
 *   onDelta?: Function,
 * }} [context]
 * @returns {Promise<ExecutionResult>}
 */
async function execute(decision, { capabilities = {}, nativeGenerator, messages, onDelta } = {}) {
  const problem = validateDecision(decision);
  if (problem) {
    throw new Error(`Orchestrator received an invalid decision: ${problem}`);
  }

  switch (decision.action) {
    case 'native': {
      if (!nativeGenerator || typeof nativeGenerator.generate !== 'function') {
        return { action: 'native', output: null, error: 'native generator is not available' };
      }
      // Streaming when possible: if the caller wants deltas and the
      // generator supports them, stream; otherwise fall back to the
      // non-streaming generate() path.
      let output;
      if (onDelta && typeof nativeGenerator.stream === 'function') {
        output = await nativeGenerator.stream(messages, { onDelta });
      } else {
        output = await nativeGenerator.generate(messages);
      }
      return { action: 'native', output };
    }

    case 'capability':
    case 'tool': {
      const capability = capabilities[decision.capability];
      if (!capability || typeof capability.invoke !== 'function') {
        return {
          action: decision.action,
          capability: decision.capability,
          output: null,
          error: `capability "${decision.capability}" is not available`,
        };
      }
      const output = await capability.invoke(messages, { onDelta, task: decision.task, input: decision.input });
      return { action: decision.action, capability: decision.capability, output };
    }

    case 'clarify':
      return { action: 'clarify', output: null, reason: decision.reason };

    case 'refuse':
      return { action: 'refuse', output: null, reason: decision.reason };

    /* istanbul ignore next -- unreachable: validateDecision already rejects any other action */
    default:
      throw new Error(`Orchestrator cannot execute unknown decision action: ${decision.action}`);
  }
}

module.exports = { execute };
