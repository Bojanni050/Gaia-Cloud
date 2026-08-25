'use strict';

/**
 * Generation Policy 0.1 — pure, deterministic policy seam for choosing
 * between Gaia's native generator and Hermes.
 *
 * Core rule: Gaia speaks natively by default. Hermes is a specialized
 * capability that Gaia explicitly chooses when specialized reasoning, a
 * verified skill, or multi-source synthesis requires it.
 *
 * Boundary: this module decides generation mode; it does not execute
 * (orchestrator.js does that) and it does not route actions
 * (decisionEngine.js does that). It consumes signals from IntentIQ,
 * ReasonIQ, and the Capability Registry to determine which generation
 * path is appropriate.
 *
 * Hermes availability ≠ Hermes necessity. A turn being capable of Hermes
 * does not mean it should use Hermes.
 */

const { routingSkills } = require('../capabilityRegistry');

/**
 * Intents whose source of truth is conversational and that do not require
 * deep generation — these are the turns Gaia can answer natively.
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
 * Determines the generation mode for a turn. Pure function — same inputs
 * always produce the same output. No LLM calls, no I/O.
 *
 * Precedence:
 *   1. Plan already selected → mode: 'plan'
 *   2. Deep reasoning (reasoningDepth === 'deep') → mode: 'hermes'
 *   3. Selected Hermes skill → mode: 'hermes'
 *   4. Native eligible → mode: 'native'
 *   5. Default → mode: 'native' (Gaia speaks natively by default)
 *
 * @param {{
 *   intent?: object|null,
 *   reasoning?: object|null,
 *   selectedSkill?: string|null,
 *   hasPlan?: boolean,
 * }} input
 * @returns {{ mode: 'native'|'hermes'|'plan', reason: string }}
 */
function decideGenerationMode({
  intent = null,
  reasoning = null,
  selectedSkill = null,
  hasPlan = false,
} = {}) {
  // 1. Plan already selected — the plan owns generation composition.
  if (hasPlan) {
    return { mode: 'plan', reason: 'multi-step plan selected — plan owns generation' };
  }

  // 2. Deep reasoning requires Hermes. ReasonIQ already decided this
  //    is a turn that needs deeper analysis — native is for simple turns.
  if (reasoning && reasoning.reasoningDepth === 'deep') {
    return { mode: 'hermes', reason: 'deep reasoning required' };
  }

  // 3. A selected Hermes skill requires Hermes. The Decision Engine
  //    matched a task shape to a verified routing skill in the Capability
  //    Registry — that skill is delivered through Hermes.
  if (selectedSkill) {
    return { mode: 'hermes', reason: `Hermes skill "${selectedSkill}" selected` };
  }

  // 4. Native eligibility — check all conditions.
  if (isNativeEligible(intent, reasoning)) {
    return { mode: 'native', reason: 'conversational turn — Gaia speaks natively' };
  }

  // 5. Default to native. Gaia speaks natively unless there is an
  //    EXPLICIT reason to use Hermes. This is the key semantic of
  //    Generation Policy 0.1: native is the default, not Hermes.
  return { mode: 'native', reason: 'default — no specialized reasoning required' };
}

/**
 * Determines whether a turn is eligible for native generation.
 *
 * Native is eligible when ALL of:
 *   - intent is conversational (or absent)
 *   - reasoning is not deep
 *   - no specialized skill is selected
 *   - no multi-source synthesis is needed
 *   - no external capability is required
 *
 * @param {object|null} intent - IntentIQ's IntentDecision, or null
 * @param {object|null} reasoning - ReasonIQ's ReasoningResult, or null
 * @returns {boolean}
 */
function isNativeEligible(intent, reasoning) {
  // Deep reasoning always needs Hermes — native is for simple turns.
  if (reasoning && reasoning.reasoningDepth === 'deep') return false;

  // No intent at all: null intent means no IntentIQ ran at all. When
  // native is available, a simple greeting without intent is native.
  if (!intent) return true;

  // IntentIQ returned an object but couldn't classify a strong intent —
  // status: 'unknown' with null intent. Typical simple greeting or chat.
  if (!intent.intent && intent.status === 'unknown') return true;

  // Explicit conversational intents.
  if (NATIVE_INTENTS.has(intent.intent)) return true;

  // Conversational or personal-memory source of truth with a non-complex
  // intent — Hindsight supplies context, never the answer. Once that
  // context exists, a personal-memory question is exactly the kind of
  // turn Gaia can answer herself.
  if ((intent.sourceOfTruth === 'conversation' || intent.sourceOfTruth === 'memory')
      && !intent.needsClarification) {
    return true;
  }

  return false;
}

module.exports = {
  decideGenerationMode,
  isNativeEligible,
  NATIVE_INTENTS,
};
