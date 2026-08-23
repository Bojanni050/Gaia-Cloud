'use strict';

/**
 * Gaia's Decision Engine — the one place that decides what Gaia does with a
 * turn.
 *
 * Boundary: this module decides; it does not execute (orchestration.js does
 * that) and it does not interpret or reason (IntentIQ/ReasonIQ already did
 * that upstream — see logos/intentIQ.js, logos/reasonIQ.js). It consumes
 * their output plus the set of capabilities actually available and returns
 * exactly one Decision (decisionSchema.js) — a small *plan*, not just an
 * action: `action` for what the Orchestrator executes, plus `context`/
 * `reasoning`/`capabilities` describing what this turn needed and why (see
 * decisionSchema.js's own header for why those three are additive/
 * observability-only and never read by the Orchestrator). Hermes is never
 * special-cased here beyond being one entry in `availableCapabilities` —
 * this module has no `useHermes`-shaped flag anywhere, and must stay
 * capability-agnostic so a future capability (a tool, a second model)
 * slots in without changing this file's shape.
 *
 * Routing:
 *
 *   1. IntentIQ flagged the turn as needing clarification       -> clarify
 *   2. sourceOfTruth "tool" (act.perform) + a tool capability    -> tool
 *   3. sourceOfTruth "external_knowledge" + a web capability     -> tool: web
 *   4. simple/conversational/personal-memory turn + native       -> native
 *   5. everything else needing a generated response              -> capability: hermes
 *   6. no capability at all can answer                           -> clarify
 *
 * Branch 4 is deliberately broad — see isNativeTurn's own comment — because
 * "complex = Hermes, everything else = Hermes too" is exactly the posture
 * this Decision Engine exists to move away from (per the module's own
 * design brief): the native generator is used whenever Gaia can genuinely
 * handle the turn herself, Hermes is reserved for turns that actually
 * warrant a specialist/deep-reasoning capability.
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
 * conversational in nature. Anything not covered here (directly or via
 * sourceOfTruth below) falls through to Hermes (the safe default).
 */
const NATIVE_INTENTS = new Set([
  'converse',
  'meta.relational',
  'greet',
  'farewell',
  'acknowledge',
]);

/**
 * Returns true when the turn is simple/conversational — or personal/
 * memory-grounded — enough for native generation. Conservative by design:
 * unknown intents fall through to Hermes.
 *
 * sourceOfTruth "memory" is included alongside "conversation" on purpose
 * (not just the intents list): a turn like "what do you still remember
 * about me and Luca?" resolves to sourceOfTruth "memory" in IntentIQ (see
 * intentIQ.js's SOURCE_SIGNALS), but recalling context and *answering
 * with* it are different jobs — Hindsight only ever supplies context (see
 * decisionSchema.js's own note on this), it never generates Gaia's reply.
 * Once that context exists (already fetched before decide() runs — see
 * turn.js), a personal-memory question is exactly the kind of turn Gaia
 * can answer herself; treating "needs memory" as "needs Hermes" would be
 * the same "Hermes for everything" failure mode this engine exists to
 * avoid, just triggered by sourceOfTruth instead of intent.
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

  // Conversational or personal-memory source of truth with a non-complex
  // intent — see this function's own comment for why "memory" belongs
  // here, not just "conversation".
  if ((intent.sourceOfTruth === 'conversation' || intent.sourceOfTruth === 'memory') && !intent.needsClarification) {
    return true;
  }

  return false;
}

/**
 * Maps ReasonIQ's own output to the Decision plan's coarse reasoning
 * level — interpretation, not re-classification. ReasonIQ already decided
 * reasoningDepth ('shallow'/'deep', reasonIQ.js's decideReasoningDepth);
 * this only relabels that judgment for the plan, plus distinguishing "no
 * ReasonIQ result at all" (Desktop's no-Logos path) as 'none' rather than
 * silently treating it the same as a shallow result.
 * @param {object|null|undefined} reasoning - ReasonIQ's ReasoningResult, or null/undefined
 * @returns {'none'|'light'|'deep'}
 */
function mapReasoningLevel(reasoning) {
  if (!reasoning) return 'none';
  return reasoning.reasoningDepth === 'deep' ? 'deep' : 'light';
}

/**
 * Reports which existing context sources this decision's answer draws on.
 * Purely descriptive: recall already happened before decide() was called
 * (turn.js) — this never triggers a fetch, it only reports whether one
 * already produced something relevant.
 * @param {{ reflections?: Array, mentalModels?: Array }|null|undefined} context
 * @returns {string[]}
 */
function usedContextSources(context) {
  if (!context) return [];
  const hasReflections = Array.isArray(context.reflections) && context.reflections.length > 0;
  const hasMentalModels = Array.isArray(context.mentalModels) && context.mentalModels.length > 0;
  return (hasReflections || hasMentalModels) ? ['hindsight'] : [];
}

/**
 * @param {{
 *   userInput: string,
 *   intent: object|null,
 *   context?: { reflections?: Array, mentalModels?: Array }|null,
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
  } else if (intent && intent.sourceOfTruth === 'external_knowledge' && findCapability(capabilities, 'web')) {
    decision = {
      action: 'tool',
      capability: 'web',
      task: intent.intent || 'lookup',
      input: { userInput },
      reason: 'this turn needs current external information Gaia does not already have',
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

  decision.context = usedContextSources(context);
  decision.reasoning = mapReasoningLevel(reasoning);
  decision.capabilities = decision.capability ? [decision.capability] : [];

  const problem = validateDecision(decision);
  if (problem) {
    // Should be unreachable given the branches above — a defensive guard,
    // not a silent fallback: an invalid Decision must never reach the
    // Orchestrator.
    throw new Error(`Decision Engine produced an invalid decision: ${problem}`);
  }
  return decision;
}

module.exports = { decide, isNativeTurn, mapReasoningLevel, usedContextSources, NATIVE_INTENTS };
