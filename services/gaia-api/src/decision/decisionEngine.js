'use strict';

/**
 * Gaia's Decision Engine — the one place that decides what Gaia does with a
 * turn.
 *
 * Boundary: this module decides; it does not execute (orchestration.js does
 * that) and it does not interpret or reason (IntentIQ/ReasonIQ already did
 * that upstream — see logos/intentIQ.js, logos/reasonIQ.js). It consumes
 * their output plus the set of capabilities actually available and returns
 * exactly one Decision (decisionSchema.js). Hermes is never special-cased
 * here beyond being one entry in `availableCapabilities` — this module has
 * no `useHermes`-shaped flag anywhere, and must stay capability-agnostic so
 * a future capability (a tool, a second model, a native generator) slots in
 * without changing this file's shape.
 *
 * Current routing (v0.1 — see the module-level NOTE on `native` below):
 *
 *   1. IntentIQ flagged the turn as needing clarification  -> clarify
 *   2. IntentIQ resolved the turn's source of truth to "tool"
 *      and a matching tool capability is available          -> tool
 *   3. otherwise, if a "hermes" capability is available      -> capability: hermes
 *   4. no capability at all can answer                       -> clarify
 *
 * NOTE on `native`: this codebase has no text-generation capability other
 * than Hermes today — Response Engine only formats/streams what a
 * capability hands it (responseEngine.js), it does not generate text
 * itself. Choosing `native` for a turn that needs generated content would
 * therefore produce nothing to say. So `native` is a real, valid, tested
 * action in the schema and the Orchestrator (ready for a future Gaia-native
 * generator), but this Decision Engine deliberately never selects it yet —
 * doing so today would just be Hermes hidden behind a different label,
 * which is exactly the outcome this architecture exists to prevent.
 *
 * NOTE on `refuse`: also a real, valid action — the Orchestrator and
 * Response Engine both handle it — but nothing upstream (IntentIQ,
 * ReasonIQ) yet produces a safety/policy signal for this Decision Engine to
 * act on, so it is never selected in v0.1 either. A future policy signal is
 * the extension point, not a heuristic invented here to fill the gap.
 */

const { validateDecision } = require('./decisionSchema');

function findCapability(availableCapabilities, id) {
  return (availableCapabilities || []).find((c) => c && c.id === id) || null;
}

/**
 * @param {{
 *   userInput: string,
 *   intent: object|null,
 *   context?: object,
 *   reasoning?: object|null,
 *   availableCapabilities?: Array<{ id: string, type?: string }>,
 * }} input
 * @returns {import('./decisionSchema').Decision}
 */
function decide({ userInput, intent, context, reasoning, availableCapabilities } = {}) {
  const capabilities = availableCapabilities || [];

  let decision;

  if (intent && intent.needsClarification) {
    decision = {
      action: 'clarify',
      reason: intent.status === 'ambiguous'
        ? 'multiple interpretations of this turn are plausible and were not resolved'
        : 'this turn needs clarification before Gaia can act on it',
    };
  } else if (intent && intent.sourceOfTruth === 'tool' && findCapability(capabilities, 'tool')) {
    decision = {
      action: 'tool',
      capability: 'tool',
      task: intent.intent || 'act',
      input: { userInput, entities: intent.entities || [] },
      reason: `intent "${intent.intent}" requires acting on an external system`,
    };
  } else if (findCapability(capabilities, 'hermes')) {
    decision = {
      action: 'capability',
      capability: 'hermes',
      task: (intent && intent.intent) || 'respond',
      input: { userInput, context: context || null, reasoning: reasoning || null },
      reason: reasoning && reasoning.reasoningDepth === 'deep'
        ? 'complex reasoning required for this turn'
        : 'this turn requires a generated conversational response',
    };
  } else {
    decision = { action: 'clarify', reason: 'no capability is available to answer this turn' };
  }

  const problem = validateDecision(decision);
  if (problem) {
    // Should be unreachable given the branches above — a defensive guard,
    // not a silent fallback: an invalid Decision must never reach the
    // Orchestrator.
    throw new Error(`Decision Engine produced an invalid decision: ${problem}`);
  }
  return decision;
}

module.exports = { decide };
