'use strict';

/**
 * Policy-gated memory recall and reflection — a port of gaia-web's
 * state/memoryContext.js, calling hindsightClient.js instead of going
 * through a same-origin browser proxy (see that file's own comment).
 * Same rendering, same gating, same "never blocks or breaks the turn"
 * contract.
 */
const { shouldRecall, shouldReflect } = require('./memoryPolicy');

const MAX_MEMORY_LINES = 6;
const UNCERTAIN_CONFIDENCE_THRESHOLD = 0.55;

/**
 * The 7 standing mental models provisioned on Gaia's `gaia` bank (see
 * services/gaia-api/scripts/provision-mental-models.js) — each a living,
 * periodically-refreshed synthesis over Bo's memories, distinct from
 * per-turn recall above. IDs must match what was provisioned on Hindsight.
 */
const MENTAL_MODEL_IDS = [
  'identity-personal-context',
  'communication-style',
  'goals-priorities',
  'preferences',
  'relationships-context',
  'work-projects',
  'emotional-patterns',
];

// Mental models only change on a daily cron (or on-demand refresh) — an
// in-process cache keeps every turn from paying a Hindsight round-trip per
// model for content that is, in the common case, hours old.
const MENTAL_MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
let mentalModelCache = { fetchedAt: 0, models: [] };

function normalizeSummary(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Reads Hindsight's own field names directly (`text`, `scores.final`) —
 * hindsightClient.js no longer renames these to `summary`/`confidence` on
 * the way in, so this is the one place that derives a renderable line
 * from them. `type`/`entities`/`tags`/`occurred*` ride along on each
 * reflection for future use (e.g. filtering by type) without needing
 * another round-trip through hindsightClient.js to add them.
 */
function formatReflectionLine(reflection) {
  const summary = normalizeSummary(reflection?.text);
  if (!summary) return null;
  const confidence = reflection?.scores?.final;
  const isUncertain = typeof confidence === 'number' && confidence < UNCERTAIN_CONFIDENCE_THRESHOLD;
  return isUncertain ? `- ${summary} (uncertain)` : `- ${summary}`;
}

/** @param {Array<{text: string, scores: {final: number|null}}>} reflections */
function condenseMemoryContext(reflections) {
  if (!reflections || reflections.length === 0) return [];
  const seen = new Set();
  const lines = [];
  for (const reflection of reflections) {
    const line = formatReflectionLine(reflection);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= MAX_MEMORY_LINES) break;
  }
  return lines;
}

/** @param {Array<{text: string, scores: {final: number|null}}>} reflections */
function renderMemoryContext(reflections) {
  const lines = condenseMemoryContext(reflections);
  if (lines.length === 0) return null;
  return [
    'From your long-term memory (Hindsight), things you have come to understand',
    'that may be relevant to this conversation. Use only what genuinely applies;',
    'do not force it in, and do not announce that you are consulting memory.',
    'Items marked (uncertain) are not confirmed — hold them as a possibility,',
    'not a settled fact.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Best-effort recall, policy-gated. Never throws — a slow or unreachable
 * Hindsight, or a query the policy judges not worth a lookup, both
 * resolve to [] rather than failing or delaying the turn. The optional
 * `intentDecision` rides into the policy so an IntentIQ-resolved
 * memory-anchored follow-up (assistant-originated referents — see
 * memoryPolicy.shouldRecall) can open the gate even without a lexical
 * past-reference cue in the query text.
 * @param {ReturnType<import('./hindsightClient').createHindsightClient>} hindsight
 * @param {string} query
 * @param {{ intentDecision?: object|null }} [options]
 */
async function recallRelevantContext(hindsight, query, options = {}) {
  if (!query || !query.trim()) return [];
  if (!shouldRecall(query, { intentDecision: options.intentDecision })) return [];
  try {
    return await hindsight.recall(query);
  } catch (_) {
    return [];
  }
}

/**
 * Fire-and-forget reflection, policy-gated. Callers must not await this
 * for turn completion — matches gaia-web's reflectOnTurn contract exactly.
 *
 * Memoryworthiness 0.1: an optional `metadata` object (gaia_memory_* keys
 * describing the ingest decision, see memoryWorthiness.js) rides along on
 * the retained item — same gaia_ namespace as hypotheses/patterns, merged
 * additively over the existing provenance metadata. The retain/discard
 * GATE itself lives at the call site (turn.js); this function stays the
 * transport.
 * @param {ReturnType<import('./hindsightClient').createHindsightClient>} hindsight
 * @param {{ conversationId: string, userText: string, assistantText: string,
 *          assistantMessageId?: string, metadata?: Record<string,string> }} turn
 */
function reflectOnTurn(hindsight, { conversationId, userText, assistantText, assistantMessageId, metadata }) {
  if (!userText || !assistantText) return;
  if (!shouldReflect(userText, assistantText)) return;
  hindsight.reflect({
    domain: 'context',
    summary: `Bo: ${userText}\n\nGaia: ${assistantText}`,
    provenance: {
      conversation_id: conversationId,
      source_message_id: assistantMessageId,
      observed_at: new Date().toISOString(),
    },
    metadata,
  }).catch((err) => {
    console.warn(`reflection failed (non-fatal): ${err.message}`);
  });
}

/**
 * Renders the cached mental models into one system-message block. Framed as
 * standing understanding (not a per-query recall) so Gaia treats it as
 * background insight into who Bo is, not evidence to cite.
 * @param {Array<{ name: string, content: string }>} models
 * @returns {string|null}
 */
function renderMentalModelContext(models) {
  const sections = (models || [])
    .filter((m) => m && m.content && m.content.trim())
    .map((m) => `### ${m.name}\n${m.content.trim()}`);
  if (sections.length === 0) return null;
  return [
    "This is Gaia's standing understanding of Bo, synthesized over time from",
    'long-term memory (Hindsight mental models) and refreshed periodically —',
    'not a transcript of this conversation. Let it inform tone and judgment',
    'quietly; never quote it back or announce that you are drawing on it.',
    '',
    ...sections,
  ].join('\n');
}

/**
 * Best-effort fetch of all mental models, cached in-process
 * (MENTAL_MODEL_CACHE_TTL_MS). Never throws — same "must not affect the
 * turn" contract as recallRelevantContext. A model that fails to fetch
 * (not yet provisioned, Hindsight unreachable, no content generated yet)
 * is silently omitted rather than failing the whole batch.
 * @param {ReturnType<import('./hindsightClient').createHindsightClient>} hindsight
 * @param {{ now?: () => number }} [options] test seam for the cache clock
 */
async function fetchMentalModelContext(hindsight, { now = Date.now } = {}) {
  const nowMs = now();
  if (nowMs - mentalModelCache.fetchedAt < MENTAL_MODEL_CACHE_TTL_MS) {
    return mentalModelCache.models;
  }
  const results = await Promise.all(
    MENTAL_MODEL_IDS.map((id) =>
      hindsight.getMentalModel(id).catch(() => null)
    )
  );
  const models = results.filter(Boolean);
  mentalModelCache = { fetchedAt: nowMs, models };
  return models;
}

module.exports = {
  condenseMemoryContext,
  renderMemoryContext,
  recallRelevantContext,
  reflectOnTurn,
  MENTAL_MODEL_IDS,
  renderMentalModelContext,
  fetchMentalModelContext,
};
