'use strict';

/**
 * Dual Recall — the terugweg.
 *
 * Recall returns Hindsight's derived items (hypotheses, patterns, Kairos
 * episodes) together with the `gaia_*_sources` metadata
 * (cognitionSync.js) that carries the `foundation:<uuid>` references each item
 * was built from. On its own that metadata is inert: `memory.js` renders only
 * the item's text, so Gaia reasons over her own summaries and never sees the
 * raw observations behind them (context rot / epistemische blindheid).
 *
 * This module owns the return path: it selects the recalled items worth
 * spending a second, dependent hop on, resolves their source refs through the
 * shared `foundationRef` seam, fetches the literal Foundation records, and maps
 * them back to the item that cited them — so the prompt can lay evidence beside
 * interpretation.
 *
 * The gate has three layers, cheapest first:
 *   1. Nul-kosten-voorpad — an item with no source refs yields no ids, so a
 *      turn whose recall carries no provenance makes NO network call at all.
 *      This is the common case (plain bank memories carry no sources).
 *   2. Relevantie-gate — only items at or above EVIDENCE_MIN_SCORE qualify; a
 *      weak match does not get evidence laid under a line we label uncertain.
 *   3. pastReference-bypass — when the turn explicitly asks about the past, the
 *      score threshold is dropped (the person is asking for it).
 *
 * Everything here fails soft: no source, an unreachable Foundation, or an
 * unreadable record all resolve to "no evidence", never to a broken turn.
 */

const { ingestObjectId } = require('../foundationRef');

/**
 * Where a recalled item's provenance lives inside Hindsight's metadata. One
 * key per derived kind — mirrors cognitionSync.js's metadata builders.
 */
const SOURCE_METADATA_KEYS = Object.freeze([
  'gaia_hypothesis_sources',
  'gaia_pattern_sources',
  'gaia_kairos_episode_sources',
]);

// Below this recall confidence an item does not earn a second round-trip. Set
// above memory.js's uncertain label (0.55) so evidence never sits under a line
// we are simultaneously calling uncertain.
const EVIDENCE_MIN_SCORE = 0.65;
// Bound on Foundation fetches per turn — the evidence is context, not the reply.
const MAX_EVIDENCE_REFS = 3;
// Same compact-passages budget the Foundation search block uses.
const MAX_EVIDENCE_TEXT_LENGTH = 280;

/**
 * A source list arrives as a JSON string (how cognitionSync writes it), but
 * tolerate an array or a malformed value without throwing.
 * @param {unknown} value
 * @returns {Array<unknown>}
 */
function parseSourceList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

/**
 * The bare Foundation ingest_object ids a recalled item cites, deduped and
 * order-preserving. Only recognised Foundation references survive (canonical
 * `foundation:<uuid>` and the legacy `chronicle:` shapes), via the shared seam.
 * @param {object|null|undefined} reflection
 * @returns {string[]}
 */
function reflectionSourceIds(reflection) {
  const metadata = reflection && reflection.metadata;
  if (!metadata || typeof metadata !== 'object') return [];
  const ids = [];
  const seen = new Set();
  for (const key of SOURCE_METADATA_KEYS) {
    for (const raw of parseSourceList(metadata[key])) {
      const id = ingestObjectId(raw);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * @param {object|null|undefined} reflection
 * @param {{ pastReference?: boolean, minScore?: number }} [options]
 * @returns {boolean}
 */
function passesEvidenceGate(reflection, { pastReference = false, minScore = EVIDENCE_MIN_SCORE } = {}) {
  if (pastReference) return true;
  const score = reflection && reflection.scores && reflection.scores.final;
  return typeof score === 'number' && score >= minScore;
}

/**
 * The recalled items that carry provenance AND clear the gate.
 * @param {Array<object>} reflections
 * @param {{ pastReference?: boolean, minScore?: number }} [options]
 * @returns {Array<object>}
 */
function selectEvidenceReflections(reflections, options = {}) {
  return (Array.isArray(reflections) ? reflections : [])
    .filter((reflection) => reflection
      && reflectionSourceIds(reflection).length > 0
      && passesEvidenceGate(reflection, options));
}

/**
 * Gather the distinct Foundation ids to fetch and remember which recalled item
 * cited each — the map that lets the renderer put evidence under its item.
 * @param {Array<object>} reflections
 * @param {{ maxRefs?: number }} [options]
 * @returns {{ ids: string[], refByFactId: Map<string, string[]> }}
 */
function collectSourceRefs(reflections, { maxRefs = MAX_EVIDENCE_REFS } = {}) {
  const ids = [];
  const seen = new Set();
  const refByFactId = new Map();
  for (const reflection of Array.isArray(reflections) ? reflections : []) {
    if (!reflection) continue;
    const own = [];
    for (const id of reflectionSourceIds(reflection)) {
      if (!seen.has(id)) {
        if (ids.length >= maxRefs) continue;
        seen.add(id);
        ids.push(id);
      }
      own.push(id);
    }
    if (own.length > 0 && reflection.id != null) refByFactId.set(reflection.id, own);
  }
  return { ids, refByFactId };
}

/**
 * The full gate decision, without doing any I/O.
 * @param {Array<object>} reflections
 * @param {{ pastReference?: boolean, minScore?: number, maxRefs?: number }} [options]
 * @returns {{ reflections: Array<object>, ids: string[], refByFactId: Map<string, string[]> }}
 */
function planEvidenceRecall(reflections, options = {}) {
  const gated = selectEvidenceReflections(reflections, options);
  const { ids, refByFactId } = collectSourceRefs(gated, { maxRefs: options.maxRefs });
  return { reflections: gated, ids, refByFactId };
}

/**
 * The ingest object a Foundation record wraps, tolerating both shapes the read
 * seam returns (`{ object: {...}, episodes: [...] }` from /api/ingest-logs/:id,
 * and a bare object in tests/stubs).
 * @param {unknown} observation
 * @returns {object|null}
 */
function unwrapObservation(observation) {
  if (!observation || typeof observation !== 'object') return null;
  return observation.object && typeof observation.object === 'object'
    ? observation.object
    : observation;
}

/** @param {unknown} observation @returns {string|null} */
function observationId(observation) {
  const inner = unwrapObservation(observation);
  return inner && inner.id != null ? String(inner.id) : null;
}

/**
 * The literal text of a raw Foundation record, collapsed to one line and
 * bounded. Field names vary across ingest sources, so try the plausible ones.
 * @param {unknown} observation
 * @returns {string}
 */
function observationText(observation) {
  const inner = unwrapObservation(observation);
  if (!inner) return '';
  const raw = inner.content || inner.text || inner.title || inner.summary || '';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_EVIDENCE_TEXT_LENGTH);
}

/**
 * The terugweg itself. Plans the gate, fetches the sources through Foundation
 * (when the client is wired), and maps the literal records back to the item
 * that cited them. Resolves to null — meaning "no evidence, render plain memory"
 * — in every quiet case and on any failure.
 * @param {{ fetchIngestObjects?: Function }|null|undefined} foundation
 * @param {Array<object>} reflections
 * @param {{ pastReference?: boolean, minScore?: number, maxRefs?: number }} [options]
 * @returns {Promise<{ reflections: Array<object>, evidenceByFactId: Map<string, string[]> }|null>}
 */
async function fetchEvidenceForReflections(foundation, reflections, options = {}) {
  if (!foundation || typeof foundation.fetchIngestObjects !== 'function') return null;
  const plan = planEvidenceRecall(reflections, options);
  if (plan.ids.length === 0) return null;

  let observations;
  try {
    observations = await foundation.fetchIngestObjects(plan.ids);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(observations) || observations.length === 0) return null;

  const textById = new Map();
  for (const observation of observations) {
    const id = observationId(observation);
    const text = observationText(observation);
    if (id && text) textById.set(id, text);
  }

  const evidenceByFactId = new Map();
  for (const [factId, ownIds] of plan.refByFactId) {
    const texts = ownIds.map((id) => textById.get(id)).filter(Boolean);
    if (texts.length > 0) evidenceByFactId.set(factId, texts);
  }
  if (evidenceByFactId.size === 0) return null;

  return { reflections: plan.reflections, evidenceByFactId };
}

module.exports = {
  SOURCE_METADATA_KEYS,
  EVIDENCE_MIN_SCORE,
  MAX_EVIDENCE_REFS,
  MAX_EVIDENCE_TEXT_LENGTH,
  parseSourceList,
  reflectionSourceIds,
  passesEvidenceGate,
  selectEvidenceReflections,
  collectSourceRefs,
  planEvidenceRecall,
  observationId,
  observationText,
  fetchEvidenceForReflections,
};
