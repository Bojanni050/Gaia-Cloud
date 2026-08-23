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
 * Routing:
 *
 *   1. IntentIQ flagged the turn as needing clarification  -> clarify
 *   2. IntentIQ resolved the turn's source of truth to "tool"
 *      and a matching tool capability is available          -> tool
 *   3. conversational/simple turn AND native is available   -> native
 *   4. complex/deep reasoning OR no native available        -> capability: hermes
 *   5. no capability at all can answer                      -> clarify
 *
 * NOTE on `refuse`: a real, valid action — the Orchestrator and
 * Response Engine both handle it — but nothing upstream (IntentIQ,
 * ReasonIQ) yet produces a safety/policy signal for this Decision Engine to
 * act on, so it is never selected yet. A future policy signal is the
 * extension point, not a heuristic invented here to fill the gap.
 */

const { validateDecision } = require('./decisionSchema');

function findCapability(availableCapabilities, id) {
  return (availableCapabilities || []).find((c) => c && c.id === id) || null;
}

/**
 * Intents whose source of truth is conversational and that do not require
 * deep generation — these are the turns Gaia can answer natively, without
 * Hermes. Kept deliberately conservative: only intents that are clearly
 * conversational in nature. Anything not in this set falls through to
 * Hermes (the safe default).
 */
const NATIVE_INTENTS = new Set([
  'converse',
  'meta.relational',
  'greet',
  'farewell',
  'acknowledge',
]);

/**
 * Returns true when the turn is simple/conversational enough for native
 * generation. Conservative by design — unknown intents fall through to
 * Hermes.
 */
function isNativeTurn(intent, reasoning) {
  // Deep reasoning always needs Hermes — native is for simple turns.
  if (reasoning && reasoning.reasoningDepth === 'deep') return false;

  // No intent at all: null intent means no IntentIQ ran at all (e.g.
  // the performTurn Desktop path). When native is available, a simple
  // greeting without intent is a good native candidate.
  if (!intent) return true;

  // IntentIQ returned an object but couldn't classify a strong intent —
  // status: 'unknown' with null intent. This is a typical simple
  // greeting or chat turn — suitable for native.
  if (!intent.intent && intent.status === 'unknown') return true;

  // Explicit conversational intents.
  if (NATIVE_INTENTS.has(intent.intent)) return true;

  // Conversational source of truth with a non-complex intent.
  if (intent.sourceOfTruth === 'conversation' && !intent.needsClarification) return true;

  return false;
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
  } else if (isNativeTurn(intent, reasoning) && findCapability(capabilities, 'native')) {
    decision = {
      action: 'native',
      reason: intent && intent.intent
        ? `conversational turn (${intent.intent}) handled by Gaia's native voice`
        : "simple conversational turn handled by Gaia's native voice",
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

module.exports = { decide, isNativeTurn, NATIVE_INTENTS };
