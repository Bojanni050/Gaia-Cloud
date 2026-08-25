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
  const ids = (Array.isArray(availableCapabilities) ? availableCapabilities : [])
    .map((c) => c && c.id)
    .filter(Boolean);

  const lines = [];
  for (const id of ids) {
    const profile = getCapabilityProfile(id);
    if (!profile) continue; // unknown to the registry: never claimed
    lines.push(`- ${profile.id}: ${profile.description}`);
    if (profile.skills.length > 0) {
      lines.push(`  skills: ${profile.skills.map((s) => s.id).join(', ')}`);
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
