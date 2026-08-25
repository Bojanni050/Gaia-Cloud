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
 *
 * Pattern Awareness 0.1: recalled patterns (context.patterns, retrieved by
 * turn.js through Hindsight before this engine runs) are judged here via
 * reasoning/patternAwareness.js's pure policy and expressed as an additive
 * `patternUsage` plan field (see decisionSchema.js). This engine is the
 * ONLY owner of pattern usage: patterns never reach the Orchestrator's
 * execution path or become user-facing without this engine explicitly
 * selecting mode 'mention_as_observation'. No pattern LLM, no new actions.
 */

const { validateDecision, MAX_PLAN_STEPS } = require('./decisionSchema');
const { evaluatePatternUsage } = require('../reasoning/patternAwareness');

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
 * Conversation Search routing policy (v0.1 — deliberately NARROW).
 *
 * Gaia routes a turn to the conversation_search capability only when
 * IntentIQ resolved it as an ASSISTANT-ANCHORED FOLLOW-UP: the user is
 * following up on something GAIA introduced in her own previous response
 * ("...context rond juni..." → "wat was er in juni ook alweer?"). For such
 * turns the literal wording lives in the transcript, not necessarily in
 * Hindsight — so searching what was actually said beats answering from
 * selected memories alone. Everything else (memory.inspect, plain
 * recallable questions, etc.) keeps its existing routing; widening this
 * policy is a future, explicit decision.
 *
 * Scope choice rides with the anchor's semantics: an assistant-originated
 * referent comes from THIS conversation, so the Decision pins scope:
 * 'current' rather than leaving the capability to guess (spec §23).
 */
const CONVERSATION_SEARCH_REASONS = Object.freeze([
  'assistant_anchored_follow_up_inherited',
  'assistant_anchored_follow_up_unresolved_intent',
]);

function shouldUseConversationSearch(intent) {
  return Boolean(
    intent
    && intent.meta
    && CONVERSATION_SEARCH_REASONS.includes(intent.meta.reason)
  );
}

// --- Decision Engine 3.0: planning & composition -----------------------------
//
// Gaia (the Decision Engine itself — NOT a planner agent) may answer a turn
// with a small, bounded, sequential PLAN instead of a single action: e.g.
// [conversation_search → hindsight → hermes → native]. The planning lives in
// this same deterministic cascade, consumes only signals this engine already
// had, and adds no LLM call. MAX_PLAN_STEPS bounds every plan; the schema
// validator rejects anything malformed before the Orchestrator ever sees it.

/** Planning signal vocabulary — routing-level cues, kept small and legible. */
const PLANNING_SIGNALS = Object.freeze({
  /** The user asks for what was LITERALLY said in past conversations. */
  exactHistoryRequest: [
    /\b(letterlijk|exact|precies)\b.{0,40}\b(zei|gezegd|gesproken|vertelde|stond)\b/i,
    /\bzei ik\b/i,
    /\bwat zei (je|ik|wij|we)\b/i,
    /\bwhat did i say\b/i,
  ],
  /**
   * The user points at a PAST CONVERSATION moment without quoting it yet —
   * a lookup-shaped need ("wat we vorige maand over X besloten").
   */
  pastConversationLookup: [
    /\bzo(eek|cht|ek)\b[\s\S]{0,60}\bwat we\b/i,
    /\bwat we (vorige|laatste|eerder)\b/i,
    /\b(besloten|afgesproken|gezegd|gebruikt)\b[\s\S]{0,40}\b(vorige|laatste)\b/i,
    /\bvorige (maand|week)\b[\s\S]{0,50}\b(besloten|gezegd|afspraak|besproken)\b/i,
  ],
  /** The user wants remembered/selected knowledge (Hindsight-shaped). */
  rememberedKnowledgeRequest: [
    /\bwat weet je nog\b/i, /\bweet je nog\b/i, /\bwat ken je van mij\b/i,
    /\bwhat do you remember\b/i, /\bremember about me\b/i,
    /\bwat je (over|van)[\s\S]{0,40}\b(weet|kent)\b/i,
  ],
  /** The retrieved material must be ANALYSED, not just shown. */
  analysisRequest: [
    /\b(analyseer|beoordeel|vergelijk|evaluer)\w*\b/i,
    /\banaly[sz]e\b/i, /\bassess\b/i, /\bcompare\b/i,
    /\bcombineer\b/i, // merge retrieved knowledge with new input, then reason
  ],
});

function hasPlanningSignal(text, group) {
  return PLANNING_SIGNALS[group].some((p) => p.test(String(text || '')));
}

/**
 * Deterministic planner. Returns a plan decision or null to let the
 * existing single-action cascade run unchanged.
 *
 * Trigger matrix (conservative; minimum-sufficient principle §30):
 *   - TWO distinct retrieval needs (conversation search + hindsight)
 *        → both retrievals (+ hermes when analysis requested) → native
 *   - ONE retrieval need + analysis cue → retrieval(s) → hermes → native
 *   - exact-history phrasing NOT already served by the narrow anchored
 *     single-search route → conversation_search → native
 *   - external-knowledge + remembered-knowledge/analysis
 *        → web + retrievals → hermes → native
 * Everything else never becomes a plan: runTurnCore already recalls
 * Hindsight before decide() for ordinary turns, so an extra hindsight step
 * there would be duplicate retrieval (§17), not extra quality.
 *
 * @param {{ userInput?: string, intent?: object|null }} args
 * @returns {object|null} a full plan decision, or null
 */
function buildPlan({ userInput = '', intent = null } = {}) {
  const wantsExactHistory = hasPlanningSignal(userInput, 'exactHistoryRequest');
  const wantsPastLookup = hasPlanningSignal(userInput, 'pastConversationLookup');
  const wantsRemembered = hasPlanningSignal(userInput, 'rememberedKnowledgeRequest')
    || Boolean(intent && intent.intent === 'memory.inspect');
  const wantsAnalysis = hasPlanningSignal(userInput, 'analysisRequest');
  const wantsExternal = Boolean(intent && intent.sourceOfTruth === 'external_knowledge');
  const isAnchoredFollowUp = shouldUseConversationSearch(intent);

  // Distinct retrieval needs (§17: never the same source twice). An anchored
  // follow-up's memory-source signal IS its search need — never counted as a
  // separate Hindsight need on top of it.
  const distinctRetrievals = [];
  if (isAnchoredFollowUp || wantsExactHistory || wantsPastLookup) distinctRetrievals.push('conversation_search');
  if (wantsRemembered) distinctRetrievals.push('hindsight');
  const dedupedRetrievals = [...new Set(distinctRetrievals)];

  const multiSource = dedupedRetrievals.length >= 2;
  const retrievalPlusReasoning = dedupedRetrievals.length >= 1 && wantsAnalysis;
  // A standalone exact-history ask that the narrow anchored-single-search
  // route does not already serve earns its own minimal [cs → native] plan.
  const exactHistoryStandalone = wantsExactHistory && !isAnchoredFollowUp;
  const externalCombo = wantsExternal && (wantsRemembered || wantsAnalysis);

  if (!multiSource && !retrievalPlusReasoning && !externalCombo && !exactHistoryStandalone) return null;

  const steps = [];
  let n = 0;
  const nextId = () => `step-${++n}`;

  if (wantsExternal) {
    steps.push({
      id: nextId(),
      type: 'capability',
      capability: 'web',
      input: { query: userInput },
      optional: true, // a web outage must not kill an otherwise-answerable turn
    });
  }
  if (dedupedRetrievals.includes('conversation_search')) {
    steps.push({
      id: nextId(),
      type: 'retrieval',
      capability: 'conversation_search',
      input: { query: userInput, scope: 'all', limit: 8 },
    });
  }
  if (dedupedRetrievals.includes('hindsight')) {
    steps.push({
      id: nextId(),
      type: 'retrieval',
      capability: 'hindsight',
      input: { query: userInput, limit: 6 },
    });
  }

  const retrievalStepIds = steps.map((s) => s.id);
  if (wantsAnalysis || wantsExternal) {
    steps.push({
      id: nextId(),
      type: 'reasoning',
      capability: 'hermes',
      input: {},
      sources: [...retrievalStepIds],
    });
  }
  steps.push({
    id: nextId(),
    type: 'generation',
    mode: 'native',
    sources: [...retrievalStepIds],
  });

  // Budget guard: an over-budget need means the POLICY is wrong, not that we
  // should trim silently — fall back to the existing cascade.
  if (steps.length > MAX_PLAN_STEPS) return null;

  const sourceSummary = [
    dedupedRetrievals.join(' + ') || null,
    wantsExternal ? 'web' : null,
    (wantsAnalysis || wantsExternal) ? 'hermes' : null,
    'native',
  ].filter(Boolean).join(' → ');

  return {
    action: 'plan',
    steps,
    capability_candidate: null,
    capability_execute: false,
    reason: `multi-step turn planned (${sourceSummary})`,
  };
}

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
 * already produced something relevant. Recalled patterns count as
 * Hindsight context too (they ARE Hindsight content), but only when the
 * Decision Engine actually chose to use them (mode != 'ignore') — seeing a
 * pattern and setting it aside is not drawing on it.
 * @param {{ reflections?: Array, mentalModels?: Array }|null|undefined} context
 * @param {{ mode?: string, patterns?: string[] }|null|undefined} patternUsage - the Decision Engine's own pattern judgment
 * @returns {string[]}
 */
function usedContextSources(context, patternUsage) {
  const hasReflections = context && Array.isArray(context.reflections) && context.reflections.length > 0;
  const hasMentalModels = context && Array.isArray(context.mentalModels) && context.mentalModels.length > 0;
  const hasUsedPatterns = patternUsage
    && patternUsage.mode !== 'ignore'
    && Array.isArray(patternUsage.patterns)
    && patternUsage.patterns.length > 0;
  return (hasReflections || hasMentalModels || hasUsedPatterns) ? ['hindsight'] : [];
}

/**
 * @param {{
 *   userInput: string,
 *   intent: object|null,
 *   context?: { reflections?: Array, mentalModels?: Array, patterns?: Array }|null,
 *   reasoning?: object|null,
 *   availableCapabilities?: Array<{ id: string, type?: string }>,
 * }} input
 * @returns {import('./decisionSchema').Decision}
 */
function decide({ userInput, intent, context, reasoning, availableCapabilities } = {}) {
  const capabilities = availableCapabilities || [];

  // Pattern Awareness 0.1: judge recalled patterns HERE — this engine is the
  // sole owner of whether a pattern matters now (never the Response Engine,
  // never the Orchestrator, never PatternManager, whose formation job is
  // untouched). evaluatePatternUsage is pure policy (reasoning/
  // patternAwareness.js); null means no usable candidates were offered and
  // no patternUsage rides on the Decision at all.
  const patternEvaluation = evaluatePatternUsage(context && context.patterns, { userInput });
  const patternUsage = patternEvaluation
    ? {
      mode: patternEvaluation.mode,
      patterns: patternEvaluation.patterns,
      contextPatternIds: patternEvaluation.contextPatternIds,
      mentions: patternEvaluation.mentions,
      decisions: patternEvaluation.decisions,
    }
    : undefined;

  let decision;

  // Decision Engine 3.0: try bounded multi-step composition BEFORE the
  // single-action cascade. A plan survives only when EVERY capability it
  // names is present in the caller-provided registry — otherwise it is
  // discarded and the existing branches run unchanged (never a partially
  // executable plan).
  const candidatePlan = buildPlan({ userInput, intent });
  const planDecision = candidatePlan && candidatePlan.steps
    .map((s) => s.capability)
    .filter(Boolean)
    .every((c) => findCapability(capabilities, c))
    ? candidatePlan
    : null;

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
  } else if (planDecision) {
    // Decision Engine 3.0: a bounded multi-step plan was warranted AND every
    // capability it names is available in the registry. The Orchestrator
    // will execute exactly these steps, in order. (A richer combined need —
    // e.g. search + analysis — outranks the single-search route below.)
    decision = planDecision;
  } else if (
    shouldUseConversationSearch(intent)
    && findCapability(capabilities, 'conversation_search')
  ) {
    // Assistant-anchored follow-up + capability available, with no wider
    // multi-step need: search what was actually said in THIS conversation.
    // The capability never decides for itself that a search is needed.
    decision = {
      action: 'capability',
      capability: 'conversation_search',
      capability_candidate: 'conversation_search',
      capability_execute: true,
      task: 'search.conversation',
      input: {
        query: userInput,
        scope: 'current',
        limit: 8,
      },
      reason: 'follow-up on Gaia\'s own previous response — searching the conversation transcript',
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

  decision.context = usedContextSources(context, patternUsage);
  if (patternUsage) decision.patternUsage = patternUsage;
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

module.exports = {
  decide,
  isNativeTurn,
  mapReasoningLevel,
  usedContextSources,
  shouldUseConversationSearch,
  buildPlan,
  hasPlanningSignal,
  NATIVE_INTENTS,
  META_INTENT_TYPES,
  PLANNING_SIGNALS,
};
