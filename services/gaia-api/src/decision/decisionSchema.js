'use strict';

/**
 * Gaia Decision Engine — the schema its decisions must satisfy.
 *
 * A Decision is Gaia's own answer to "what do I do with this turn?" — never
 * a capability's. Five actions, no `useHermes`-style flags, no
 * capability-specific fields beyond what every capability/tool call needs
 * (`capability`, `task`, `input`). See decisionEngine.js for how a Decision
 * gets produced and orchestrator.js for how one gets executed.
 *
 * A Decision is a small *plan*, not just a single action: `context`,
 * `reasoning` and `capabilities` describe what Gaia judged this turn
 * needs, alongside `action` itself. The Orchestrator never reads these
 * three fields — it only ever acts on `action`/`capability`/`task`/`input`
 * — so they exist purely for observability (logging, the admin decision
 * log) and for a future Response Engine that wants richer context about
 * *why* a decision was made. They are optional and additive: any existing
 * Decision missing them (e.g. a caller's own error-fallback object) is
 * still perfectly valid.
 *
 *   - `context`: which existing context sources this decision's answer
 *     draws on — today only `'hindsight'` is meaningful. Hindsight is
 *     never a capability Gaia "calls" for an answer; it is context that
 *     gets folded in before `native`/`capability` runs (see turn.js — the
 *     recall already happens before decide() is ever invoked). A decision
 *     can combine `context: ['hindsight']` with any action.
 *   - `reasoning`: how much reasoning this turn needed — 'none' | 'light'
 *     | 'deep' — interpreting ReasonIQ's own reasoningDepth
 *     ('shallow'/'deep') plus whether ReasonIQ ran at all, never a second,
 *     duplicate complexity classifier (see decisionEngine.js's own note).
 *   - `capabilities`: the specialist capability id(s) this decision
 *     actually needs, if any — mirrors `capability` for `capability`/`tool`
 *     actions, empty for `native`/`clarify`/`refuse`.
 *
 * v2.2 spec §8-9: capability_candidate vs capability_execute:
 *   - `capability_candidate`: what MIGHT be useful (a routing hint, never
 *     forced into execution)
 *   - `capability_execute`: whether the capability is ACTUALLY authorized
 *     to run (the Response Engine may override this when conversational
 *     context makes direct Gaia response more appropriate)
 *
 * NOTE on multi-step plans: a future `action: 'sequence'` with a `steps`
 * array (e.g. [{action:'context', source:'hindsight'}, {action:'capability',
 * capability:'hermes'}, {action:'native'}]) is a real extension point this
 * shape is deliberately compatible with — adding it later means adding one
 * more ACTIONS entry and one more Orchestrator case, not redesigning this
 * schema. It is intentionally NOT implemented yet: today's flow already
 * covers every case this pass needs (context is always resolved before
 * decide() runs; a decision only ever needs one action to execute), and
 * building real sequencing now would be exactly the kind of orchestration
 * complexity nothing currently requires.
 */

const ACTIONS = Object.freeze(['native', 'capability', 'tool', 'clarify', 'refuse']);
const REASONING_LEVELS = Object.freeze(['none', 'light', 'deep']);

/**
 * @typedef {Object} Decision
 * @property {'native'|'capability'|'tool'|'clarify'|'refuse'} action
 * @property {string} [capability] - required when action is 'capability' or 'tool'
 * @property {string} [task]
 * @property {object} [input]
 * @property {string} [reason] - debuggable, human-readable ("why this action")
 * @property {string[]} [context] - context sources this decision draws on, e.g. ['hindsight']
 * @property {'none'|'light'|'deep'} [reasoning] - how much reasoning this turn needed
 * @property {string[]} [capabilities] - specialist capability id(s) this decision needs
 * @property {string|null} [capability_candidate] - what capability MIGHT be useful (routing hint)
 * @property {boolean} [capability_execute] - whether the capability is ACTUALLY authorized to run
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
  if (decision.context !== undefined) {
    if (!Array.isArray(decision.context) || decision.context.some((c) => typeof c !== 'string')) {
      return 'decision.context must be an array of strings when present';
    }
  }
  if (decision.reasoning !== undefined && !REASONING_LEVELS.includes(decision.reasoning)) {
    return `decision.reasoning must be one of: ${REASONING_LEVELS.join(', ')}`;
  }
  if (decision.capabilities !== undefined) {
    if (!Array.isArray(decision.capabilities) || decision.capabilities.some((c) => typeof c !== 'string')) {
      return 'decision.capabilities must be an array of strings when present';
    }
  }
  if (decision.capability_execute !== undefined && typeof decision.capability_execute !== 'boolean') {
    return 'decision.capability_execute must be a boolean when present';
  }
  return null;
}

module.exports = { ACTIONS, REASONING_LEVELS, validateDecision };
