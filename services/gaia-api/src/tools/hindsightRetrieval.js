'use strict';

/**
 * hindsight — a RETRIEVAL capability adapter over Gaia's existing Hindsight
 * client (Decision Engine 3.0 planning).
 *
 * Lets a PLAN use Hindsight as an explicit step:
 *
 *   { id:'s2', type:'retrieval', capability:'hindsight',
 *     input:{ query:'...' }, sources:['s1'] }
 *
 * Boundary: read-only retrieval + compact presentation, exactly like the
 * conversation_search capability. It NEVER writes to Hindsight
 * (Memoryworthiness owns ingestion), never interprets or reasons, never
 * decides whether it should run — the Decision Engine does that — and it
 * reuses the EXISTING hindsightClient instance injected by server.js; there
 * is no second memory engine here.
 */

function createHindsightRetrievalCapability({ hindsight } = {}) {
  if (!hindsight || typeof hindsight.recall !== 'function') {
    throw new Error('createHindsightRetrievalCapability requires a hindsight client');
  }

  /**
   * @param {Array} _messages unused — retrieval is query-driven
   * @param {{ input?: { query?: string, limit?: number } }} [options]
   * @returns {Promise<{ results: Array<{ text: string, relevance: number|null }>, total: number }>}
   */
  async function invoke(_messages, options = {}) {
    const input = options.input || {};
    const query = String(input.query || '').trim();
    const limit = Math.max(1, Math.min(10, Number(input.limit) || 6));
    if (!query) return { results: [], total: 0 };

    const recalled = await hindsight.recall(query); // existing client seam; throws on failure like every capability
    const results = (recalled || [])
      .slice(0, limit)
      .filter((r) => r && r.text)
      .map((r) => ({
        text: String(r.text).replace(/\s+/g, ' ').trim().slice(0, 280),
        relevance: r && r.scores && typeof r.scores.final === 'number' ? r.scores.final : null,
      }));
    return { results, total: results.length };
  }

  return { invoke };
}

/** Compact presentation used when this step's output feeds reasoning/generation steps. */
function formatHindsightOutcome(outcome) {
  if (!outcome || !Array.isArray(outcome.results) || outcome.results.length === 0) {
    return 'Geen relevante herinneringen gevonden.';
  }
  const lines = ['Herinneringen:', ''];
  for (const r of outcome.results) {
    lines.push(`- ${r.text}${typeof r.relevance === 'number' ? ` (relevance: ${r.relevance})` : ''}`);
  }
  return lines.join('\n');
}

module.exports = { createHindsightRetrievalCapability, formatHindsightOutcome };
