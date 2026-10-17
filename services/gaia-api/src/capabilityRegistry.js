'use strict';

/**
 * Capability Registry 1.0 — THE single Gaia-side source of truth for:
 *
 *   which capabilities exist,
 *   what they are for,
 *   which skills they expose,
 *   which of those skills are selection-relevant routing targets.
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
 * Routing skills are read by src/researchReach.js — the only place Gaia
 * reaches for a Hermes skill — and by the IntentIQ task shapes in
 * src/logos/intentSignals.js that trigger the reach.
 *
 * Boundary: pure frozen data + pure lookup helpers. Zero requires, zero I/O,
 * zero decisions — this module only records metadata.
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
        routing: true,
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

  research: Object.freeze({
    id: 'research',
    type: 'capability',
    description: 'handing a question to a deep, sourced investigation that keeps running in the background and comes back with material for you to answer from',
    skills: Object.freeze([]),
  }),

  web_search: Object.freeze({
    id: 'web_search',
    type: 'retrieval',
    description: 'looking something up on the live web for current external information — a shallow, single-step search you do inside the turn',
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

  memory: Object.freeze({
    id: 'memory',
    type: 'capability',
    description: 'keeping something in memory when the person asks you to remember it',
    skills: Object.freeze([]),
  }),

  memory_retraction: Object.freeze({
    id: 'memory_retraction',
    type: 'capability',
    description: 'taking a memory back when the person says it is not true — the memory is withdrawn and the statement it came from is retired',
    skills: Object.freeze([]),
  }),

  own_memory: Object.freeze({
    id: 'own_memory',
    type: 'capability',
    description: 'your own memory, yours alone — things you notice, prefer, or that matter to you, kept quietly for you',
    skills: Object.freeze([]),
  }),

  // Foundation — Bo's epistemische geheugen (Bojanni050/Foundation): what is
  // RECORDED there, as opposed to what Gaia remembers (hindsight). Results
  // arrive status-labelled ([bevestigd feit] / [hypothese · open] / …) —
  // the archive counterpart of hindsight, never a second reflective memory.
  foundation: Object.freeze({
    id: 'foundation',
    type: 'retrieval',
    description: "Foundation: Bo's epistemische geheugen — wat ER IS VASTGELEGD (observaties, hypothesen, bevestigde feiten), altijd mét status per resultaat",
    skills: Object.freeze([
      Object.freeze({ id: 'foundation-memory-search', category: 'retrieval', routing: false, description: 'semantische zoekopdracht in Foundation geheugen' }),
    ]),
  }),

  // Desktop — hands on the person's OWN machine (Desktop Commander, run by
  // Gaia-Desktop locally; Gaia-Cloud never executes anything itself). Only a
  // capability when a desktop executor is connected THIS turn. Reads may run
  // freely; writes and commands need the person's confirmation in the client.
  // Skills are non-routing metadata: nothing here auto-selects them.
  desktop: Object.freeze({
    id: 'desktop',
    type: 'capability',
    description: "working on the person's own computer when a turn asks for it — reading, searching and (with their confirmation) changing files or running commands",
    skills: Object.freeze([
      Object.freeze({ id: 'file-read', category: 'files', routing: false, description: 'read and list files on the connected computer (no confirmation needed)' }),
      Object.freeze({ id: 'file-search', category: 'files', routing: false, description: 'search file names and contents on the connected computer (no confirmation needed)' }),
      Object.freeze({ id: 'file-write', category: 'files', routing: false, description: 'create or edit files on the connected computer; the person confirms first' }),
      Object.freeze({ id: 'run-command', category: 'system', routing: false, description: 'run a terminal command on the connected computer; the person confirms first' }),
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
 * Validation helper: a plan step may only carry a skill its capability
 * actually exposes. Returns null when valid, else a human-readable problem.
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
  // Note: the routing flag governs SELECTION (selection attaches only
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
