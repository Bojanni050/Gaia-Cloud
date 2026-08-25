'use strict';

/**
 * Capability Registry 1.0 — THE single Gaia-side source of truth for:
 *
 *   which capabilities exist,
 *   what they are for,
 *   which skills they expose,
 *   which of those skills are Decision-Engine routing targets.
 *
 * Hermes remains ONE capability; its skills are metadata about specialized
 * ways Hermes can operate. Skill IDs are the OFFICIAL Hermes Bundled Skills
 * Catalog names (hermes-agent.nousresearch.com/docs/reference/skills-catalog)
 * — Gaia never invents skill names and never loads skill contents; Hermes
 * loads and executes its own skills. Gaia only SAYS which skill is relevant.
 *
 * `routing: true` means: knowing this skill exists adds something to Gaia's
 * capability/skill selection for a turn. Skills with `routing: false` are
 * recorded as honest metadata but must not be used as routing targets.
 *
 * Boundary: pure frozen data + pure lookup helpers. Zero requires, zero I/O,
 * zero decisions — selection stays with the Decision Engine.
 */

const CAPABILITY_REGISTRY = Object.freeze({
  hermes: Object.freeze({
    id: 'hermes',
    type: 'generation',
    description: 'deeper reasoning and longer composition when a turn needs it',
    // Verified in the Hermes skill audit (test/decisionPlanning-era audit):
    // Hermes executes under Gaia's SOUL/foundation prompt on every call.
    baseline: Object.freeze({ id: 'identity_grounded_conversation', category: 'baseline', routing: false }),
    skills: Object.freeze([
      Object.freeze({
        id: 'systematic-debugging',
        category: 'development',
        routing: true,
        description: '4-phase root cause debugging: understand bugs before fixing',
      }),
      Object.freeze({
        id: 'test-driven-development',
        category: 'development',
        routing: true,
        description: 'TDD: enforce RED-GREEN-REFACTOR, tests before code',
      }),
      Object.freeze({
        id: 'requesting-code-review',
        category: 'development',
        routing: true,
        description: 'pre-commit review: security scan, quality gates, auto-fix',
      }),
      Object.freeze({
        id: 'grounded-citations',
        category: 'research',
        routing: false,
        description: 'ground answers and documents in cited, verifiable sources',
      }),
      Object.freeze({
        id: 'plan',
        category: 'planning',
        routing: false,
        description: 'write a markdown plan document; no execution (Gaia owns planning)',
      }),
    ]),
  }),

  native: Object.freeze({
    id: 'native',
    type: 'generation',
    description: 'your own voice — direct conversational answers',
    skills: Object.freeze([]),
  }),

  web: Object.freeze({
    id: 'web',
    type: 'retrieval',
    description: 'searching the live web for current external information',
    skills: Object.freeze([
      Object.freeze({ id: 'web-search', category: 'research', routing: false, description: 'live web search via the registered search provider' }),
    ]),
  }),

  conversation_search: Object.freeze({
    id: 'conversation_search',
    type: 'retrieval',
    description: 'searching the literal text of current and past conversations — what was actually said, by either of you',
    skills: Object.freeze([
      Object.freeze({ id: 'current-conversation-search', category: 'retrieval', routing: false, description: 'search the in-flight conversation transcript' }),
      Object.freeze({ id: 'saved-conversation-search', category: 'retrieval', routing: false, description: 'search persisted past conversations' }),
      Object.freeze({ id: 'all-sources-search', category: 'retrieval', routing: false, description: 'search current and saved conversations together' }),
    ]),
  }),

  hindsight: Object.freeze({
    id: 'hindsight',
    type: 'retrieval',
    description: 'your long-term memory: selected memories, observations and patterns about the user',
    skills: Object.freeze([
      Object.freeze({ id: 'memory-retrieval', category: 'retrieval', routing: false, description: 'recall selected memories relevant to the turn' }),
      Object.freeze({ id: 'hypothesis-retrieval', category: 'retrieval', routing: false, description: 'recall tracked hypotheses with confidence' }),
      Object.freeze({ id: 'pattern-retrieval', category: 'retrieval', routing: false, description: 'recall formed patterns with confidence and status' }),
    ]),
  }),

  tool: Object.freeze({
    id: 'tool',
    type: 'capability',
    description: 'acting on external systems when a turn requires it',
    skills: Object.freeze([]),
  }),
});

/** @returns {object|null} the capability profile, or null when unknown */
function getCapabilityProfile(capabilityId) {
  if (!capabilityId || typeof capabilityId !== 'string') return null;
  return CAPABILITY_REGISTRY[capabilityId] || null;
}

/** @returns {string[]} all registered capability ids */
function listCapabilityIds() {
  return Object.keys(CAPABILITY_REGISTRY);
}

/** @returns {boolean} does this capability expose this skill? */
function hasSkill(capabilityId, skillId) {
  const profile = getCapabilityProfile(capabilityId);
  if (!profile || !skillId) return false;
  return profile.skills.some((s) => s.id === skillId);
}

/** @returns {object|null} the skill entry, or null */
function getSkill(capabilityId, skillId) {
  const profile = getCapabilityProfile(capabilityId);
  if (!profile || !skillId) return null;
  return profile.skills.find((s) => s.id === skillId) || null;
}

/**
 * Validation used by the Decision schema and the Orchestrator BEFORE
 * execution: a plan step may only carry a skill its capability actually
 * exposes. Returns null when valid, else a human-readable problem.
 * @param {string} capabilityId
 * @param {string} skillId
 * @returns {string|null}
 */
function validateCapabilitySkill(capabilityId, skillId) {
  if (!skillId) return null; // no skill claimed — nothing to validate
  const profile = getCapabilityProfile(capabilityId);
  if (!profile) {
    return `capability "${capabilityId}" is not registered — cannot carry skill "${skillId}"`;
  }
  if (!hasSkill(capabilityId, skillId)) {
    return `capability "${capabilityId}" does not expose skill "${skillId}"`;
  }
  // Note: the routing flag governs SELECTION (Decision Engine attaches only
  // routing:true skills), not VALIDITY — a recorded non-routing skill stays
  // a real skill of the capability (spec §10 validates existence).
  return null;
}

/** @returns {Array<object>} skills flagged routing:true for a capability */
function routingSkills(capabilityId) {
  const profile = getCapabilityProfile(capabilityId);
  if (!profile) return [];
  return profile.skills.filter((s) => s.routing === true);
}

module.exports = {
  CAPABILITY_REGISTRY,
  getCapabilityProfile,
  listCapabilityIds,
  hasSkill,
  getSkill,
  validateCapabilitySkill,
  routingSkills,
};
