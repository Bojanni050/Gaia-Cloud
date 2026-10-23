'use strict';

/**
 * Capability awareness — renders the small system-prompt block that tells
 * Gaia which capabilities she GENUINELY has this turn, plus the skills each
 * capability exposes. Everything shown is derived from the Capability
 * Registry (src/capabilityRegistry.js) — the single source of truth —
 * filtered to the capabilities the caller actually registered this turn.
 *
 * Why this exists: Gaia's factual self-knowledge otherwise lives only in
 * the foundation documents, which lag behind the capability registry — so
 * she would honestly-but-wrongly deny abilities she actually has. The
 * registry is the truth; this block carries it into her voice, including
 * skill awareness (which specialized ways a capability can operate).
 *
 * Boundary: pure rendering over the registry. No I/O, no decisions.
 */

const {
  getCapabilityProfile,
} = require('./capabilityRegistry');

/**
 * Renders the awareness block, or null when there is nothing meaningful to
 * say (no registered capabilities at all).
 * @param {Array<{ id: string }>|null|undefined} availableCapabilities
 * @returns {string|null}
 */
function renderCapabilityAwareness(availableCapabilities) {
  const lines = [];
  for (const capability of Array.isArray(availableCapabilities) ? availableCapabilities : []) {
    const id = capability && capability.id;
    if (!id) continue;
    const profile = getCapabilityProfile(id);
    if (!profile) continue; // unknown to the registry: never claimed
    lines.push(`- ${profile.id}: ${profile.description}`);
    // A capability may report the narrower set it really has this turn (the
    // desktop knows which skills the connected client can carry out). Falling
    // back to the registry is right for capabilities that are all-or-nothing.
    const skills = Array.isArray(capability.skills)
      ? capability.skills.filter((s) => profile.skills.some((known) => known.id === s))
      : profile.skills.map((s) => s.id);
    if (skills.length > 0) {
      lines.push(`  skills: ${skills.join(', ')}`);
    }
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

module.exports = { renderCapabilityAwareness };
