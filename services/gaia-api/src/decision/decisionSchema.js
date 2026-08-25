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
 *
 * Pattern Awareness 0.1 — `patternUsage`:
 *
 *   Patterns recalled from Hindsight (via context.patterns) are judged by
 *   the Decision Engine itself (reasoning/patternAwareness.js's pure policy)
 *   and the outcome rides on the plan as `patternUsage` — like
 *   `context`/`reasoning`/`capabilities`, it is observability + Response
 *   Engine guidance, NEVER read by the Orchestrator, which still executes
 *   only `action`. Three usage modes exist, deliberately few:
 *
 *     ignore                  — pattern was seen but Gaia uses nothing of it
 *     use_as_context          — pattern informs the reply implicitly, never
 *                               attributed to the user as fact
 *     mention_as_observation  — Gaia may voice the pattern ONCE, phrased as
 *                               a tentative impression ("Ik krijg de indruk
 *                               dat je…"), never as fact
 *
 *   Shape: { mode, patterns, contextPatternIds?, mentions?, decisions? }
 *   where `patterns` mirrors the strongest usage (§15), mentions entries
 *   carry { patternId, phrasing: 'tentative' } — phrasing GUIDANCE for the
 *   Response Engine, which stays the owner of actual formulation — and
 *   decisions is the per-candidate audit trail (patternId/action/reason)
 *   for observability. Absent patternUsage means patterns played no part
 *   in the turn at all.
 */

const ACTIONS = Object.freeze(['native', 'capability', 'tool', 'clarify', 'refuse', 'plan']);
const REASONING_LEVELS = Object.freeze(['none', 'light', 'deep']);
const PATTERN_USAGE_MODES = Object.freeze(['ignore', 'use_as_context', 'mention_as_observation']);

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
 * @property {string[]} [requiredSkills] - task skills selected by the Decision Engine
 * @property {string[]} [requiredCapabilities] - capabilities required by a plan
 * @property {string|null} [capability_candidate] - what capability MIGHT be useful (routing hint)
 * @property {boolean} [capability_execute] - whether the capability is ACTUALLY authorized to run
 * @property {{ mode: 'ignore'|'use_as_context'|'mention_as_observation',
 *              patterns: string[], contextPatternIds?: string[],
 *              mentions?: Array<{ patternId: string, phrasing: string }>,
 *              decisions?: Array<{ patternId: string, action: string, reason: string }> }} [patternUsage]
 *
 * Decision Engine 3.0 — `action: 'plan'` (additive; the five original
 * actions and every simple path are unchanged):
 *
 *   { action:'plan', steps:[...], reason }
 *
 * A plan is a SMALL, BOUNDED, SEQUENTIAL list of steps Gaia decided this
 * turn needs — retrieval sources composed with reasoning/generation, e.g.
 * [conversation_search → hermes → native]. The Orchestrator executes the
 * steps in order and resolves references; it never chooses or inserts
 * steps of its own.
 *
 * Step shape:
 *   { id, type, capability?, mode?, input?, optional?, sources? }
 *   - type: 'retrieval' | 'reasoning' | 'generation' | 'capability'
 *   - capability: required for retrieval/reasoning/capability steps; must
 *     be one the caller listed as available
 *   - generation uses { mode: 'native'|'capability', capability? } instead
 *   - sources: ids of EARLIER steps whose results this step consumes.
 *     Backward-only references make circular plans unrepresentable AND are
 *     validated explicitly (unique ids, existing refs, max step count).
 *
 * Future-proofing (NOT implemented): conditional/parallel steps,
 * replanning, result transformation — the shape stays compatible.
 */

/** Plan step vocabulary + bounds (Decision Engine 3.0). */
const STEP_TYPES = Object.freeze(['retrieval', 'reasoning', 'generation', 'capability']);
const GENERATION_MODES = Object.freeze(['native', 'capability']);
const MAX_PLAN_STEPS = 4;

/** Generation Policy 0.1 — mode vocabulary (observability field on Decision). */
const GENERATION_POLICY_MODES = Object.freeze(['native', 'hermes', 'plan']);

// Capability Registry 1.0: skill existence on plan steps is validated
// against THE registry (single source of truth) so an invalid
// capability/skill combination is rejected BEFORE execution ever starts.
const { validateCapabilitySkill } = require('../capabilityRegistry');

/**
 * Validates one plan step. Returns a problem string or null.
 * @param {object} step
 * @param {Set<string>} seenIds step ids that appear BEFORE this step
 */
function validatePlanStep(step, seenIds) {
  if (!step || typeof step !== 'object') return 'each plan step must be an object';
  if (typeof step.id !== 'string' || step.id.length === 0) {
    return 'each plan step requires a non-empty string id';
  }
  if (!STEP_TYPES.includes(step.type)) {
    return `plan step "${step.id}" has an invalid type (expected ${STEP_TYPES.join(', ')})`;
  }
  if (seenIds.has(step.id)) {
    return `duplicate plan step id: ${step.id}`;
  }

  const needsCapability = step.type === 'retrieval' || step.type === 'reasoning' || step.type === 'capability';
  if (needsCapability && (typeof step.capability !== 'string' || step.capability.length === 0)) {
    return `plan step "${step.id}" (${step.type}) requires a non-empty capability`;
  }
  if (step.type === 'generation') {
    if (!GENERATION_MODES.includes(step.mode)) {
      return `generation step "${step.id}" requires mode ${GENERATION_MODES.join(' | ')}`;
    }
    if (step.mode === 'capability' && (typeof step.capability !== 'string' || step.capability.length === 0)) {
      return `generation step "${step.id}" with mode "capability" requires a non-empty capability`;
    }
    if (step.mode === 'native' && typeof step.capability === 'string') {
      return `generation step "${step.id}" with mode "native" must not name a capability`;
    }
  }

  if (step.optional !== undefined && typeof step.optional !== 'boolean') {
    return `plan step "${step.id}": optional must be a boolean when present`;
  }

  // Capability Registry 1.0 — optional skill metadata on a step. The step
  // must name a capability, and THAT capability must expose the skill
  // (registry-validated; unknown combos are rejected before execution).
  if (step.skill !== undefined) {
    if (typeof step.skill !== 'string' || step.skill.length === 0) {
      return `plan step "${step.id}": skill must be a non-empty string when present`;
    }
    if (typeof step.capability !== 'string' || step.capability.length === 0) {
      return `plan step "${step.id}": skill requires a capability on the same step`;
    }
    const skillProblem = validateCapabilitySkill(step.capability, step.skill);
    if (skillProblem) {
      return `plan step "${step.id}": ${skillProblem}`;
    }
  }

  if (step.sources !== undefined) {
    if (!Array.isArray(step.sources) || step.sources.some((s) => typeof s !== 'string')) {
      return `plan step "${step.id}": sources must be an array of earlier step-id strings`;
    }
    for (const ref of step.sources) {
      // Sequential execution ⇒ references may only point BACKWARD. This is
      // also what makes circular plans structurally impossible: any cycle
      // would require at least one forward reference, rejected here before
      // execution ever starts (spec §21).
      if (ref === step.id) {
        return `plan step "${step.id}" references itself`;
      }
      if (!seenIds.has(ref)) {
        return `plan step "${step.id}" references unknown or later step: ${ref}`;
      }
    }
  }

  if (step.input !== undefined && (typeof step.input !== 'object' || step.input === null || Array.isArray(step.input))) {
    return `plan step "${step.id}": input must be an object when present`;
  }
  return null;
}

/**
 * Validates the plan portion of a decision. Returns a problem string or null.
 * @param {Array<object>} steps
 */
function validatePlanSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return 'decision.action "plan" requires a non-empty steps array';
  }
  if (steps.length > MAX_PLAN_STEPS) {
    return `plan exceeds MAX_PLAN_STEPS (${MAX_PLAN_STEPS}); got ${steps.length}`;
  }
  const seenIds = new Set();
  for (const step of steps) {
    const problem = validatePlanStep(step, seenIds);
    if (problem) return problem;
    seenIds.add(step.id);
  }
  return null;
}

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
  if (decision.action === 'plan') {
    const planProblem = validatePlanSteps(decision.steps);
    if (planProblem) return planProblem;
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
  for (const field of ['requiredSkills', 'requiredCapabilities']) {
    if (decision[field] !== undefined
      && (!Array.isArray(decision[field]) || decision[field].some((value) => typeof value !== 'string' || value.length === 0))) {
      return `decision.${field} must be an array of non-empty strings when present`;
    }
  }
  if (decision.capability_execute !== undefined && typeof decision.capability_execute !== 'boolean') {
    return 'decision.capability_execute must be a boolean when present';
  }
  if (decision.generationMode !== undefined && !GENERATION_POLICY_MODES.includes(decision.generationMode)) {
    return `decision.generationMode must be one of: ${GENERATION_POLICY_MODES.join(', ')}`;
  }
  if (decision.patternUsage !== undefined) {
    const u = decision.patternUsage;
    if (!u || typeof u !== 'object' || Array.isArray(u)) {
      return 'decision.patternUsage must be an object when present';
    }
    if (!PATTERN_USAGE_MODES.includes(u.mode)) {
      return `decision.patternUsage.mode must be one of: ${PATTERN_USAGE_MODES.join(', ')}`;
    }
    if (!Array.isArray(u.patterns) || u.patterns.some((p) => typeof p !== 'string')) {
      return 'decision.patternUsage.patterns must be an array of pattern-id strings when present';
    }
    if (u.contextPatternIds !== undefined
      && (!Array.isArray(u.contextPatternIds) || u.contextPatternIds.some((p) => typeof p !== 'string'))) {
      return 'decision.patternUsage.contextPatternIds must be an array of pattern-id strings when present';
    }
    if (u.mentions !== undefined) {
      if (!Array.isArray(u.mentions)) {
        return 'decision.patternUsage.mentions must be an array when present';
      }
      for (const m of u.mentions) {
        if (!m || typeof m !== 'object'
          || typeof m.patternId !== 'string' || m.patternId.length === 0
          || typeof m.phrasing !== 'string' || m.phrasing.length === 0) {
          return 'each decision.patternUsage.mentions entry requires non-empty patternId and phrasing strings';
        }
      }
    }
    if (u.decisions !== undefined) {
      if (!Array.isArray(u.decisions)) {
        return 'decision.patternUsage.decisions must be an array when present';
      }
      for (const d of u.decisions) {
        if (!d || typeof d !== 'object'
          || typeof d.patternId !== 'string' || d.patternId.length === 0
          || typeof d.action !== 'string' || d.action.length === 0
          || typeof d.reason !== 'string') {
          return 'each decision.patternUsage.decisions entry requires a patternId, an action and a reason string';
        }
      }
    }
  }
  return null;
}

module.exports = {
  ACTIONS,
  REASONING_LEVELS,
  PATTERN_USAGE_MODES,
  STEP_TYPES,
  GENERATION_MODES,
  GENERATION_POLICY_MODES,
  MAX_PLAN_STEPS,
  validatePlanSteps,
  validateDecision,
};
