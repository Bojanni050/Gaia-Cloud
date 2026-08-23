'use strict';

/**
 * Gaia Decision Engine — the schema its decisions must satisfy.
 *
 * A Decision is Gaia's own answer to "what do I do with this turn?" — never
 * a capability's. Kept intentionally tiny: five actions, no
 * `useHermes`-style flags, no capability-specific fields beyond what every
 * capability/tool call needs (`capability`, `task`, `input`). See
 * decisionEngine.js for how a Decision gets produced and orchestrator.js for
 * how one gets executed.
 */

const ACTIONS = Object.freeze(['native', 'capability', 'tool', 'clarify', 'refuse']);

/**
 * @typedef {Object} Decision
 * @property {'native'|'capability'|'tool'|'clarify'|'refuse'} action
 * @property {string} [capability] - required when action is 'capability' or 'tool'
 * @property {string} [task]
 * @property {object} [input]
 * @property {string} [reason] - debuggable, human-readable ("why this action")
 */

/**
 * Validates a Decision object. Returns null when valid, or a human-readable
 * problem string. Never throws.
 * @param {*} decision
 * @returns {string|null}
 */
function validateDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    return 'decision must be an object';
  }
  if (!ACTIONS.includes(decision.action)) {
    return `decision.action must be one of: ${ACTIONS.join(', ')}`;
  }
  if ((decision.action === 'capability' || decision.action === 'tool')) {
    if (typeof decision.capability !== 'string' || decision.capability.length === 0) {
      return `decision.action "${decision.action}" requires a non-empty decision.capability`;
    }
  }
  return null;
}

module.exports = { ACTIONS, validateDecision };
