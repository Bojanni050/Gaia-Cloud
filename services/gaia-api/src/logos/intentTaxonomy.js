'use strict';

/**
 * Intent Taxonomy v0.1 — the fixed vocabulary IntentIQ classifies against.
 *
 * This is a direct, unexpanded implementation of the "Intent Taxonomy v0.1"
 * design report (Gaia design research, approved before this module was
 * written). It defines WHAT the categories are and WHY each exists; it does
 * not decide HOW a turn is scored against them (that's intentIQ.js).
 *
 * `memory.manage` is a taxonomy *grouping*, not a classifiable value — only
 * its two leaf sub-intents (`memory.inspect`, `memory.correct`) are ever
 * returned as `intent`, because the report's separability test found the
 * read/write distinction (safe vs. state-mutating) is exactly the kind of
 * difference that changes what Gaia does next; the parent label alone
 * would erase that.
 *
 * Do not add, remove, or rename intents here without re-running the
 * separability test from the design report. If the taxonomy turns out to
 * be wrong during implementation, document the contradiction — do not
 * silently patch around it by inventing a new intent inline elsewhere.
 */

const TAXONOMY_VERSION = '0.1.0';

/**
 * @typedef {Object} IntentDefinition
 * @property {string} id
 * @property {string} label
 * @property {string} definition
 * @property {string} notThis - what this intent explicitly excludes
 */

/** @type {IntentDefinition[]} */
const INTENTS = [
  {
    id: 'converse',
    label: 'Converse',
    definition: 'The user wants to talk, think out loud, or be heard — presence, not a deliverable.',
    notThis: 'A request for information (inform.explain) or a decision framework (decide.support) dressed as conversation.',
  },
  {
    id: 'inform.explain',
    label: 'Inform / Explain',
    definition: 'The user is missing knowledge and wants it conveyed — a fact, a mechanism, a "why".',
    notThis: 'Diagnosing-in-order-to-fix (create.transform) or asking Gaia to weigh a choice (decide.support).',
  },
  {
    id: 'create.generate',
    label: 'Create — Generate',
    definition: 'The user wants new material produced from a description, with no existing artifact as input.',
    notThis: 'Changing something that already exists — that is create.transform even when phrased with "write".',
  },
  {
    id: 'create.transform',
    label: 'Create — Transform',
    definition: 'The user wants existing material changed, improved, shortened, or repurposed.',
    notThis: 'Producing something from nothing (create.generate); acting on the result (act.perform is separate).',
  },
  {
    id: 'decide.support',
    label: 'Decide — Support',
    definition: 'The user is weighing a choice and wants help thinking it through, not just facts or presence.',
    notThis: 'Wanting information to decide with alone (inform.explain), or only wanting to be heard (converse).',
  },
  {
    id: 'memory.inspect',
    label: 'Memory — Inspect',
    definition: 'The user is asking to see what Gaia has come to understand about them — read-only, always safe.',
    notThis: 'A user recalling something themselves mid-conversation (that stays whatever the surrounding intent is).',
  },
  {
    id: 'memory.correct',
    label: 'Memory — Correct',
    definition: 'The user wants stored understanding changed or removed — mutates state the user trusts Gaia with.',
    notThis: 'Inspecting without changing anything (memory.inspect).',
  },
  {
    id: 'act.perform',
    label: 'Act — Perform',
    definition: 'The user wants something to actually happen outside the conversation.',
    notThis: 'Producing content that could later be sent, without asking for it to be sent (create.generate/transform alone).',
  },
  {
    id: 'meta.relational',
    label: 'Meta — Relational',
    definition: "The user is addressing Gaia herself — who she is, how she's behaving, or the relationship.",
    notThis: 'A factual, technical question about Gaia\'s architecture in passing (inform.explain, technical register).',
  },
  {
    id: 'meta.question',
    label: 'Meta — Question',
    definition: 'The user is asking about Gaia\'s own behavior, previous response, reasoning, or interpretation — not a new standalone information request.',
    notThis: 'A new information request that merely mentions Gaia (inform.explain). The target is Gaia\'s own action, not external knowledge.',
  },
  {
    id: 'meta.correction',
    label: 'Meta — Correction',
    definition: 'The user indicates Gaia misunderstood something, interpreted incorrectly, or gave a wrong response — a correction to the conversational state.',
    notThis: 'A new information request that happens to follow a wrong answer (inform.explain). The signal is "you got this wrong", not "tell me about X".',
  },
  {
    id: 'meta.capability_question',
    label: 'Meta — Capability Question',
    definition: 'The user asks why Gaia used a specific capability, tool, or routing choice — not requesting the capability again.',
    notThis: 'A request to use that capability again (act.perform, inform.explain). The target is Gaia\'s decision, not the capability\'s output.',
  },
];

const INTENT_IDS = INTENTS.map((i) => i.id);
const INTENT_SET = new Set(INTENT_IDS);

function isKnownIntent(id) {
  return INTENT_SET.has(id);
}

const SOURCE_OF_TRUTH_VALUES = Object.freeze([
  'conversation',
  'memory',
  'upload',
  'external_knowledge',
  'tool',
  'unknown',
]);

module.exports = {
  TAXONOMY_VERSION,
  INTENTS,
  INTENT_IDS,
  isKnownIntent,
  SOURCE_OF_TRUTH_VALUES,
};
