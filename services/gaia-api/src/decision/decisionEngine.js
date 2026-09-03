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
const { decideGenerationMode } = require('./generationPolicy');
const { routingSkills } = require('../capabilityRegistry');

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

// --- Capability Registry 1.0: skill-aware planning ---------------------------
//
// A Hermes reasoning step MAY carry a skill when the TASK TYPE clearly
// matches a registry routing skill. Deliberately narrow, deliberately NOT a
// name→skill keyword router: the frames below describe failure-investigation
// / test-strategy / code-review TASK SHAPES (multi-word semantic frames), a
// skill's own NAME appearing in the prompt never selects it, and a turn
// with no matching task shape simply gets Hermes without a skill (spec §13).

const SKILL_TASK_SIGNALS = Object.freeze([
  {
    skill: 'systematic-debugging',
    frames: Object.freeze([/\bwaarom\b[\s\S]{0,60}\b(faalt|falen|crasht|crash|fout gaat|misgaat|vastloopt|lekt|niet werkt)\b/i, /\bzoek uit\b[\s\S]{0,50}\b(waarom|oorzaak|root cause)\b/i, /\broot cause\b/i, /\bwaardoor\b[\s\S]{0,60}\b(fout|faalt|crash|probleem|breekt)\b/i, /\bfout opsporen\b/i, /\bdebug\b[\s\S]{0,40}\b(waarom|oorzaak)\b/i]),
    reason: 'task requires structured debugging workflow',
  },
  {
    skill: 'test-driven-development',
    frames: Object.freeze([/\btest(strategie|strategieën|plan|suite|dekking|coverage)\b/i, /\bstrategie\b[\s\S]{0,40}\btests?\b/i, /\btdd\b/i]),
    reason: 'task requires a test-first development strategy',
  },
  {
    skill: 'requesting-code-review',
    frames: Object.freeze([/\bcode review\b/i, /\b(beoordeel|review|nakijken)\b[\s\S]{0,40}\b(mijn code|deze code|mijn wijzigingen|de wijzigingen|pull request|mijn pr)\b/i, /\b(mijn code|deze code|mijn wijzigingen|de wijzigingen)\b[\s\S]{0,40}\b(reviewen|review|beoordelen|nakijken)\b/i]),
    reason: 'task requires a structured code review workflow',
  },
]);

/**
 * Returns the registry routing skill whose TASK SHAPE this turn matches, or
 * null. Only skills the registry flags routing:true for hermes can match.
 * @param {string} userInput
 * @returns {string|null}
 */
function matchSkillTask(userInput) {
  const text = String(userInput || '');
  const hermesRoutingSkills = new Set(routingSkills('hermes').map((s) => s.id));
  for (const entry of SKILL_TASK_SIGNALS) {
    if (hermesRoutingSkills.has(entry.skill) && entry.frames.some((frame) => frame.test(text))) return entry.skill;
  }
  return null;
}

function matchRequiredSkills({ task = '', intent = null, reasoning = null, availableCapabilities = [] } = {}) {
  void intent;
  void reasoning;
  const skill = matchSkillTask(task);
  if (!skill) return { requiredSkills: [], matches: [], confidence: 'none', reason: null };
  const available = new Set((availableCapabilities || []).map((c) => c && c.id));
  const policy = SKILL_TASK_SIGNALS.find((entry) => entry.skill === skill);
  const matches = available.has('hermes')
    ? [{ skill, capability: 'hermes', confidence: 1, reason: policy.reason }]
    : [];
  return { requiredSkills: [skill], matches, confidence: 'strong', reason: policy.reason };
}

/**
 * Deterministic planner. Returns a plan decision or null to let the
 * existing single-action cascade run unchanged.
 *
 * Trigger matrix (conservative; minimum-sufficient principle §30):
 *   - Any turn needing external knowledge (sourceOfTruth external_knowledge)
 *        → web + native (web is a retrieval step; native speaks for Gaia)
 *   - TWO distinct retrieval needs (conversation search + hindsight)
 *        → both retrievals (+ hermes when analysis requested) → native
 *   - ONE retrieval need + analysis cue → retrieval(s) → hermes → native
 *   - exact-history phrasing NOT already served by the narrow anchored
 *     single-search route → conversation_search → native
 *   - external-knowledge + remembered-knowledge/analysis
 *        → web + retrievals → hermes → native
 *   - clear skill task → hermes(skill) → native
 * Everything else never becomes a plan: runTurnCore already recalls
 * Hindsight before decide() for ordinary turns, so an extra hindsight step
 * there would be duplicate retrieval (§17), not extra quality.
 *
 * Minimum-sufficient hermes: Hermes is only added when explicit analysis
 * or a skill task requires it. Standalone web-retrieval plans use
 * web → native (Gaia's own generator formulates the answer from the found
 * sources). The single-action web branch survives only as a documented
 * fallback for configurations where the plan's named capabilities
 * (e.g. native) are not registered — in that case the formatted web
 * answer is returned directly (the best available output without a
 * generation path).
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
  // Capability Registry 1.0: a clear debugging/test-strategy/code-review
  // TASK SHAPE warrants a Hermes reasoning step carrying that skill — even
  // without any retrieval need (spec §14). Generic analysis never does.
  const skillMatch = matchRequiredSkills({ task: userInput, intent });
  const skillTask = skillMatch.requiredSkills[0] || null;

  // Distinct retrieval needs (§17: never the same source twice). An anchored
  // follow-up's memory-source signal IS its search need — never counted as a
  // separate Hindsight need on top of it.
  const distinctRetrievals = [];
  if (isAnchoredFollowUp || wantsExactHistory || wantsPastLookup) distinctRetrievals.push('conversation_search');
  if (wantsRemembered) distinctRetrievals.push('hindsight');
  const dedupedRetrievals = [...new Set(distinctRetrievals)];

  const multiSource = dedupedRetrievals.length >= 2;
  const retrievalPlusReasoning = dedupedRetrievals.length >= 1 && (wantsAnalysis || Boolean(skillTask));
  // A standalone exact-history ask that the narrow anchored-single-search
  // route does not already serve earns its own minimal [cs → native] plan.
  const exactHistoryStandalone = wantsExactHistory && !isAnchoredFollowUp;
  // Minimum-sufficient: Hermes only when explicit analysis or a skill task
  // requires it. Standalone web-retrieval plans use web → native — Gaia's
  // own generator formulates the answer from the found sources.
  const needsReasoning = wantsAnalysis || Boolean(skillTask);
  // A clear skill task (debugging / test strategy / code review) warrants
  // its own minimal [hermes(skill) → native] plan even without retrievals.
  const skillReasoning = Boolean(skillTask);

  if (!multiSource && !retrievalPlusReasoning && !wantsExternal && !exactHistoryStandalone && !skillReasoning && !isAnchoredFollowUp) return null;

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
    // Anchored follow-ups pin scope to 'current' — the anchor is from THIS
    // conversation, so searching saved conversations would be dishonest.
    // Exact-history and past-lookup requests search 'all' scope.
    const csScope = isAnchoredFollowUp ? 'current' : 'all';
    steps.push({
      id: nextId(),
      type: 'retrieval',
      capability: 'conversation_search',
      input: { query: userInput, scope: csScope, limit: 8 },
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
  if (needsReasoning) {
    steps.push({
      id: nextId(),
      type: 'reasoning',
      capability: 'hermes',
      // Capability Registry 1.0: attach the matched routing skill — only
      // when the task shape clearly asked for it (never a guessed skill).
      ...(skillTask ? { skill: skillTask } : {}),
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
    needsReasoning ? (skillTask ? `hermes:${skillTask}` : 'hermes') : null,
    'native',
  ].filter(Boolean).join(' → ');

  const requiredCapabilities = [...new Set(steps.map((step) => step.capability).filter(Boolean))];
  return {
    action: 'plan',
    ...(skillMatch.requiredSkills.length > 0 ? { requiredSkills: skillMatch.requiredSkills } : {}),
    requiredCapabilities,
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
  let planDecision = null;
  if (candidatePlan && candidatePlan.steps) {
    const namedCaps = candidatePlan.steps.map((s) => s.capability).filter(Boolean);
    const capsAvailable = namedCaps.every((c) => findCapability(capabilities, c));
    // Generation steps use mode:'native' (no capability field), but the
    // Orchestrator requires nativeGenerator to exist for mode 'native'.
    const hasNativeGenStep = candidatePlan.steps.some((s) => s.type === 'generation');
    const nativeAvailable = !hasNativeGenStep || findCapability(capabilities, 'native');
    if (capsAvailable && nativeAvailable) planDecision = candidatePlan;
  }

  // Generation Policy 0.1: determine the generation mode BEFORE the routing
  // cascade. This is a pure, deterministic signal — no LLM call — that
  // informs whether native or Hermes is the appropriate generation path.
  // The mode is added to the Decision for observability (logging, eval).
  const skillMatch = matchRequiredSkills({ task: userInput, intent, reasoning, availableCapabilities: capabilities });
  const selectedSkill = skillMatch.requiredSkills[0] || null;
  const genPolicy = decideGenerationMode({
    intent,
    reasoning,
    selectedSkill,
    hasPlan: Boolean(planDecision),
  });

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
      // P0: what this execution must achieve (evaluated by the Orchestrator).
      expected_outcome: {
        description: 'A conversation-search result covering the follow-up',
        minLength: 1,
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
      // P0: what this execution must achieve (evaluated by the Orchestrator).
      expected_outcome: {
        description: `A completed tool result for intent "${intent.intent}"`,
        minLength: 1,
      },
      reason: `intent "${intent.intent}" requires acting on an external system`,
    };
  } else if (intent && intent.sourceOfTruth === 'external_knowledge' && findCapability(capabilities, 'web')) {
    // DOCUMENTED FALLBACK — normally external-knowledge turns become a plan
    // [web → native] (buildPlan). This single-action branch fires only when
    // the plan was discarded — e.g. the plan named native but no native
    // generator is registered (web-only configurations). In that case the
    // web capability's formatted answer is returned directly as the best
    // available output without a generation path.
    decision = {
      action: 'tool',
      capability: 'web',
      capability_candidate: 'web',
      capability_execute: true,
      task: intent.intent || 'lookup',
      input: { userInput },
      // P0: what this execution must achieve (evaluated by the Orchestrator).
      expected_outcome: {
        description: 'A web lookup result covering the requested external information',
        minLength: 1,
      },
      reason: 'this turn needs current external information Gaia does not already have',
    };
  } else if (genPolicy.mode === 'hermes' && findCapability(capabilities, 'hermes')) {
    // Generation Policy 0.1: Hermes only when there is an EXPLICIT reason
    // (deep reasoning, selected skill, or plan-owned generation). This is
    // NOT the fallback — native is.
    decision = {
      action: 'capability',
      capability: 'hermes',
      capability_candidate: 'hermes',
      capability_execute: true,
      task: (intent && intent.intent) || 'respond',
      input: { userInput, context: context || null, reasoning: reasoning || null },
      // P0: what this execution must achieve (evaluated by the Orchestrator).
      expected_outcome: {
        description: 'A completed Hermes response addressing the turn',
        minLength: 1,
      },
      reason: genPolicy.reason,
    };
  } else if (genPolicy.mode === 'hermes') {
    // Generation Policy 0.1: hermes required but not available. Use the
    // existing fallback (clarify) — never silently degrade to native when
    // deep reasoning or a skill was actually needed.
    decision = {
      action: 'clarify',
      capability_candidate: null,
      capability_execute: false,
      reason: `Hermes required (${genPolicy.reason}) but not available`,
    };
  } else if (isNativeTurn(intent, reasoning) && findCapability(capabilities, 'native')) {
    // Generation Policy 0.1: native is the DEFAULT. Gaia speaks natively
    // unless there is an explicit reason to use Hermes. This branch handles
    // conversational turns that don't need deep reasoning or a skill.
    decision = {
      action: 'native',
      capability_candidate: null,
      capability_execute: false,
      reason: intent && intent.intent
        ? `conversational turn (${intent.intent}) handled by Gaia's native voice`
        : "simple conversational turn handled by Gaia's native voice",
    };
  } else if (findCapability(capabilities, 'native')) {
    // Generation Policy 0.1: when nothing else matches and native is
    // available, default to native. This is the explicit default — Hermes
    // is NOT the fallback.
    decision = {
      action: 'native',
      capability_candidate: null,
      capability_execute: false,
      reason: "default — Gaia speaks natively unless specialized reasoning is required",
    };
  } else if (findCapability(capabilities, 'hermes')) {
    // Fallback: when native is not available, Hermes can serve as the
    // generation path. This preserves existing behavior for configurations
    // where native is not registered.
    decision = {
      action: 'capability',
      capability: 'hermes',
      capability_candidate: 'hermes',
      capability_execute: true,
      task: (intent && intent.intent) || 'respond',
      input: { userInput, context: context || null, reasoning: reasoning || null },
      // P0: what this execution must achieve (evaluated by the Orchestrator).
      expected_outcome: {
        description: 'A completed Hermes response addressing the turn',
        minLength: 1,
      },
      reason: 'native generator not available — using Hermes as generation fallback',
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
  if (decision.action !== 'plan' && skillMatch.requiredSkills.length > 0) {
    decision.requiredSkills = skillMatch.requiredSkills;
  }
  decision.generationMode = genPolicy.mode;

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
  matchSkillTask,
  matchRequiredSkills,
  NATIVE_INTENTS,
  META_INTENT_TYPES,
  PLANNING_SIGNALS,
  SKILL_TASK_SIGNALS,
};
