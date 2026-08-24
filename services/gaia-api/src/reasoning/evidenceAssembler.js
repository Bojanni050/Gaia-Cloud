'use strict';

/**
 * Evidence Assembly — the seam that turns what Gaia's context layer already
 * gathered into the normalized evidence list ReasonIQ reasons over.
 *
 * Boundary (ReasonIQ 0.2 brief §3): this module ORGANIZES evidence, it
 * never reasons. It collects what is already in hand (Hindsight recall
 * results fetched by turn.js, standing mental models, user-provided
 * uploads), normalizes every item into one shape with a stable ID and
 * relevance metadata, drops duplicates, bounds the total size, and stops.
 * It never calls Hindsight, never fetches anything, never scores meaning,
 * and never decides anything — retrieval stays Hindsight's job (§4), and
 * weighing evidence stays ReasonIQ's.
 *
 * Context versus evidence (§10): conversation state, identity, task, and
 * IntentIQ's interpretation are CONTEXT and flow to ReasonIQ separately
 * (the prompt's recentContext/intent fields). Only material a conclusion
 * could stand ON is assembled here. Tool results are an anticipated source
 * (accepted via `toolResults`) but nothing produces them pre-decision yet;
 * the shape is here so they slot in without touching ReasonIQ again.
 *
 * Pure function: same inputs, same outputs, no I/O anywhere.
 */

/** Bounds — deliberately modest; ReasonIQ weighs evidence, not archives. */
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_CONTENT_CHARS = 480;

const EVIDENCE_SOURCES = Object.freeze(['hindsight', 'conversation', 'upload', 'tool']);
const EVIDENCE_TYPES = Object.freeze(['memory', 'mental_model', 'conversation', 'document', 'tool_result']);

function clampRelevance(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function normalizeContent(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncateContent(text) {
  const str = String(text || '');
  return str.length > MAX_EVIDENCE_CONTENT_CHARS ? `${str.slice(0, MAX_EVIDENCE_CONTENT_CHARS)}…` : str;
}

/**
 * @param {{ reflections?: Array, mentalModels?: Array, attachments?: Array, conversationTurns?: Array, toolResults?: Array }} gathered
 *   everything the caller ALREADY has in hand — nothing is fetched here
 * @returns {Array<{id: string, source: string, sourceRef: string|null, type: string, content: string, relevance: number}>}
 */
function assembleEvidence(gathered) {
  const g = gathered || {};
  const items = [];

  // Per-turn Hindsight recall — the primary memory evidence. Relevance is
  // Hindsight's own final score, passed through untouched. `sourceRef`
  // carries the NATIVE Hindsight fact/observation id (Hypothesis
  // Persistence 0.1): persisted hypotheses reference evidence by these real
  // ids, so provenance resolves inside Hindsight itself instead of a second
  // store. The local sequential `id` stays for existing consumers.
  let n = 0;
  for (const r of Array.isArray(g.reflections) ? g.reflections : []) {
    const content = normalizeContent(r && (r.text ?? r.content));
    if (!content) continue;
    n += 1;
    items.push({
      id: `hindsight-${n}`,
      source: 'hindsight',
      sourceRef: r && r.id != null ? String(r.id) : null,
      type: 'memory',
      content: truncateContent(content),
      relevance: clampRelevance(r && r.scores && r.scores.final),
    });
  }

  // Standing mental models — background synthesis, not per-turn recall, so
  // they rank below fresh recall when the cap bites.
  n = 0;
  for (const m of Array.isArray(g.mentalModels) ? gathered.mentalModels : []) {
    const content = normalizeContent(m && (m.summary ?? m.text ?? m.content));
    if (!content) continue;
    n += 1;
    items.push({
      // Mental models are standing summaries, not fact/observation units —
      // their id does not resolve through memories/{id}, so sourceRef stays
      // null (strictly reserved for Hindsight fact/observation ids).
      sourceRef: null,
      id: `model-${n}`,
      source: 'hindsight',
      type: 'mental_model',
      content: truncateContent(content),
      relevance: clampRelevance(m && m.confidence, 0.6),
    });
  }

  // User-provided uploads — present in THIS turn, highest standing
  // relevance: the user deliberately put them in front of Gaia.
  n = 0;
  for (const a of Array.isArray(g.attachments) ? gathered.attachments : []) {
    if (!a || a.imageBytes) continue; // images are model-native input, not text evidence
    const content = normalizeContent(a.content);
    if (!content) continue;
    n += 1;
    items.push({
      sourceRef: null,
      id: `upload-${n}`,
      source: 'upload',
      type: 'document',
      content: truncateContent(content),
      relevance: 0.95,
    });
  }

  // Conversation turns, only when the caller explicitly offers them AS
  // evidence (they are otherwise context, per §10).
  n = 0;
  for (const t of Array.isArray(g.conversationTurns) ? gathered.conversationTurns : []) {
    const content = normalizeContent(t && t.content);
    if (!content) continue;
    n += 1;
    items.push({
      sourceRef: null,
      id: `turn-${n}`,
      source: 'conversation',
      type: 'conversation',
      content: truncateContent(content),
      relevance: clampRelevance(t && t.relevance, 0.7),
    });
  }

  // Future source: results from tools that ran before reasoning.
  n = 0;
  for (const t of Array.isArray(g.toolResults) ? gathered.toolResults : []) {
    const content = normalizeContent(t && (t.content ?? t.result));
    if (!content) continue;
    n += 1;
    items.push({
      sourceRef: null,
      id: `tool-${n}`,
      source: 'tool',
      type: 'tool_result',
      content: truncateContent(content),
      relevance: clampRelevance(t && t.relevance, 0.8),
    });
  }

  // Deduplicate near-identical content (same normalized text), keeping the
  // first (highest-priority source) occurrence.
  const seen = new Set();
  const deduped = items.filter((item) => {
    const key = item.content.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Most relevant first; Array.prototype.sort is stable, so equal-relevance
  // items keep their source-priority order above.
  deduped.sort((a, b) => b.relevance - a.relevance);

  return deduped.slice(0, MAX_EVIDENCE_ITEMS);
}

module.exports = {
  assembleEvidence,
  EVIDENCE_SOURCES,
  EVIDENCE_TYPES,
  MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_CONTENT_CHARS,
};
