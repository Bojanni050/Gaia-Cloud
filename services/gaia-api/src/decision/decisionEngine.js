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
 * Routing (v2.2 — capability gate + PATCH 7 priority):
 *
 *   PATCH 7: Before executing an external capability, evaluate in this order:
 *   1. Is the user referring to Gaia's previous behavior?
 *   2. Is the user asking why Gaia chose or used something?
 *   3. Is the user correcting Gaia's interpretation?
 *   4. Is the required information already present in the conversation?
 *   5. Can Gaia answer using native model capabilities?
 *   6. Does an external capability genuinely need to run?
 *
 *   0. Meta-intent (meta.question/correction/capability_question)  -> native
 *      (Gaia answers about her own behavior; no capability needed)
 *   1. IntentIQ flagged the turn as needing clarification          -> clarify
 *   2. sourceOfTruth "tool" (act.perform) + a tool capability     -> tool
 *   3. sourceOfTruth "external_knowledge" + a web capability      -> tool: web
 *   4. simple/conversational/personal-memory turn + native        -> native
 *   5. everything else needing a generated response               -> capability: hermes
 *   6. no capability at all can answer                            -> clarify
 *
 * PATCH 8: Model-native vs external capabilities
 * - Vision/multimodal understanding is model-native, not external
 * - Don't convert model-native capabilities into external tool invocations
 *
 * v2.2 spec §8-9: capability_candidate is what MIGHT be useful;
 * capability_execute is what is ACTUALLY authorized. The Response Engine
 * may override a capability_candidate when conversational context makes
 * direct Gaia response more appropriate.
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
  'meta.question',
  'meta.correction',
  'meta.capability_question',
  'greet',
  'farewell',
  'acknowledge',
]);

/**
 * Meta-intent types that ALWAYS get native response — no capability should
 * be invoked for these, regardless of what keyword scoring might suggest.
 * v2.2 spec §2: meta-conversational intents have priority over general
 * capability intents.
 */
const META_INTENT_TYPES = new Set([
  'meta.question',
  'meta.correction',
  'meta.capability_question',
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

  // PATCH 7: Correct priority order
  // 1. Is the user referring to Gaia's previous behavior? -> native (meta-intent)
  // 2. Is the user asking why Gaia chose or used something? -> native (meta-intent)
  // 3. Is the user correcting Gaia's interpretation? -> native (meta-intent)
  // 4. Is the required information already present in the conversation? -> native
  // 5. Can Gaia answer using native model capabilities? -> native
  // 6. Does an external capability genuinely need to run? -> capability/tool

  // Priority 1-3: Meta-intents have highest priority
  // When the user is asking about Gaia's own behavior, previous response,
  // or capability choice, Gaia answers directly — no capability should be invoked.
  if (intent && META_INTENT_TYPES.has(intent.intent)) {
    decision = {
      action: 'native',
      capability_candidate: null,
      capability_execute: false,
      reason: `meta-intent (${intent.intent}) — Gaia answers about her own behavior`,
    };
  } else if (intent && intent.needsClarification) {
    decision = {
      action: 'clarify',
      capability_candidate: null,
      capability_execute: false,
      reason: intent.status === 'ambiguous'
        ? 'multiple interpretations of this turn are plausible and were not resolved'
        : 'this turn needs clarification before Gaia can act on it',
    };
  } else if (intent && intent.sourceOfTruth === 'tool' && findCapability(capabilities, 'tool')) {
    // Priority 6: External capability genuinely needed for tool actions
    decision = {
      action: 'tool',
      capability: 'tool',
      capability_candidate: 'tool',
      capability_execute: true,
      task: intent.intent || 'act',
      input: { userInput, entities: intent.entities || [] },
      reason: `intent "${intent.intent}" requires acting on an external system`,
    };
  } else if (intent && intent.sourceOfTruth === 'external_knowledge' && findCapability(capabilities, 'web')) {
    // PATCH 8: Only invoke web if genuinely needed for external knowledge
    // Don't use websearch as substitute for missing vision or native capabilities
    decision = {
      action: 'tool',
      capability: 'web',
      capability_candidate: 'web',
      capability_execute: true,
      task: intent.intent || 'lookup',
      input: { userInput },
      reason: 'this turn needs current external information Gaia does not already have',
    };
  } else if (isNativeTurn(intent, reasoning) && findCapability(capabilities, 'native')) {
    // Priority 4-5: Native model capabilities (including vision)
    // PATCH 8: Vision is model-native, not external
    decision = {
      action: 'native',
      capability_candidate: null,
      capability_execute: false,
      reason: intent && intent.intent
        ? `conversational turn (${intent.intent}) handled by Gaia's native voice`
        : "simple conversational turn handled by Gaia's native voice",
    };
  } else if (findCapability(capabilities, 'hermes')) {
    decision = {
      action: 'capability',
      capability: 'hermes',
      capability_candidate: 'hermes',
      capability_execute: true,
      task: (intent && intent.intent) || 'respond',
      input: { userInput, context: context || null, reasoning: reasoning || null },
      reason: reasoning && reasoning.reasoningDepth === 'deep'
        ? 'complex reasoning required for this turn'
        : 'this turn requires a generated conversational response',
    };
  } else {
    decision = {
      action: 'clarify',
      capability_candidate: null,
      capability_execute: false,
      reason: 'no capability is available to answer this turn',
    };
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

module.exports = { decide, isNativeTurn, mapReasoningLevel, usedContextSources, NATIVE_INTENTS, META_INTENT_TYPES };
