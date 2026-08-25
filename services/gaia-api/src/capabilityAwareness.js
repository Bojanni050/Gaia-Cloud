'use strict';

/**
 * Capability awareness — renders the small system-prompt block that tells
 * Gaia which capabilities she GENUINELY has this turn, derived from the
 * caller-provided registry (single source of truth).
 *
 * Why this exists: Gaia's factual self-knowledge otherwise lives only in
 * the foundation documents, which lag behind the capability registry — so
 * she would honestly-but-wrongly deny abilities she actually has ("ik kan
 * niet in je chats zoeken"). The registry is the truth; this block carries
 * it into her voice.
 *
 * Boundary: pure rendering. No I/O, no decisions — WHAT she can use is
 * whatever the caller listed; THIS module only phrases it.
 */

/** One-line human descriptions per capability id (registry keys). */
const CAPABILITY_DESCRIPTIONS = Object.freeze({
  hermes: 'deeper reasoning and longer composition when a turn needs it',
  native: 'your own voice — direct conversational answers',
  web: 'searching the live web for current external information',
  conversation_search: 'searching the literal text of current and past conversations — what was actually said, by either of you',
  hindsight: 'your long-term memory: selected memories, observations and patterns about the user',
  tool: 'acting on external systems when a turn requires it',
});

/**
 * Renders the awareness block, or null when there is nothing meaningful to
 * say (no registered capabilities at all).
 * @param {Array<{ id: string }>|null|undefined} availableCapabilities
 * @returns {string|null}
 */
function renderCapabilityAwareness(availableCapabilities) {
  const ids = (Array.isArray(availableCapabilities) ? availableCapabilities : [])
    .map((c) => c && c.id)
    .filter(Boolean);
  if (ids.length === 0) return null;

  const lines = [];
  for (const id of ids) {
    const description = CAPABILITY_DESCRIPTIONS[id];
    if (description) lines.push(`- ${id}: ${description}`);
  }
  if (lines.length === 0) return null;

  return [
    'Capabilities you genuinely have THIS turn (from your live registry):',
    ...lines,
    '',
    'These are real. Never deny them, and never claim capabilities that are',
    'not listed here. Bring one up only when it genuinely serves the moment —',
    'offering help is welcome; advertising is not.',
  ].join('\n');
}

module.exports = { renderCapabilityAwareness, CAPABILITY_DESCRIPTIONS };
