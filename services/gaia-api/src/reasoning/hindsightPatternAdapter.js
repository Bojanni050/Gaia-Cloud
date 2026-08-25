'use strict';

/**
 * Hindsight Pattern Adapter — persistence for ReasonIQ 0.4 patterns, using
 * exactly the same principles as the hypothesis adapter (Hypothesis
 * Persistence 0.1): a pattern persists as a RETAINED WORLD FACT tagged
 * `gaia:pattern`, versioned via document_id, with gaia_pattern_* metadata.
 *
 *   tag         = gaia:pattern
 *   context     = "gaia pattern"
 *   document_id = gaia-ptn-{id}-v{N}
 *   metadata    = gaia_pattern_{id,version,status,confidence,hypotheses,
 *                              updated_by,persistence:'durable'}
 *
 * Patterns are durable-only by definition (§15). Every state change becomes
 * a new superseding version; there is no invalidation semantics here because
 * patterns have no rejected state — downgrades are just newer versions with
 * lower confidence/status.
 *
 * Boundary: pure mapping — no reasoning, no status judgment, no dedup at
 * rest, no relevance policy. The PatternManager owns all of that; this file
 * only speaks to Hindsight via the injected client's existing primitives.
 * `recallPatterns` (Pattern Awareness 0.1) is the one retrieval-shaped
 * exception, mirroring recallHypotheses: Hindsight ranks, this reconstructs,
 * and every consumption decision stays downstream (Decision Engine).
 */

const PATTERN_TAG = 'gaia:pattern';
const PATTERN_CONTEXT = 'gaia pattern';
const UPDATED_BY = 'gaia-reasoniq';
// Patterns are long-term constructs by definition (0.4 brief §15).
const PATTERN_PERSISTENCE = 'durable';

async function adoptDocumentFacts(client, documentId, attempts = 3) {
  let last = [];
  for (let i = 0; i < attempts; i += 1) {
    last = await client.listMemories({ documentId, type: 'world' });
    if (last.length > 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return last;
}

function metadataFor(pattern, version) {
  return {
    gaia_pattern_id: String(pattern.id),
    gaia_pattern_version: String(version),
    gaia_pattern_status: String(pattern.status || ''),
    gaia_pattern_confidence: String(pattern.confidence != null ? pattern.confidence : ''),
    gaia_pattern_hypotheses: JSON.stringify(Array.isArray(pattern.hypothesisIds) ? pattern.hypothesisIds : []),
    gaia_pattern_persistence: PATTERN_PERSISTENCE,
    gaia_pattern_updated_by: UPDATED_BY,
  };
}

function reconstructFromUnit(unit) {
  if (!unit || !unit.metadata || !unit.metadata.gaia_pattern_id) return null;
  const confRaw = parseFloat(unit.metadata.gaia_pattern_confidence);
  let hypothesisIds = [];
  try {
    const parsed = JSON.parse(unit.metadata.gaia_pattern_hypotheses || '[]');
    hypothesisIds = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) { /* corrupt value → empty, never fabricated */ }
  const status = unit.metadata.gaia_pattern_status;
  return {
    id: String(unit.metadata.gaia_pattern_id),
    statement: unit.text || '',
    status: PATTERN_STATUSES_SAFE.includes(status) ? status : 'candidate',
    confidence: Number.isFinite(confRaw) ? confRaw : null,
    hypothesisIds,
    persistence: unit.metadata.gaia_pattern_persistence === 'durable' ? 'durable' : 'durable',
    sourceRef: unit.id != null ? String(unit.id) : null,
    updatedAt: unit.mentionedAt || null,
  };
}

// Kept beside the reconstruct fn without importing the manager (adapter must
// not depend on policy modules): statuses duplicated deliberately narrow.
const PATTERN_STATUSES_SAFE = ['candidate', 'supported', 'established'];

/**
 * @param {{ client: ReturnType<import('../hindsightClient').createHindsightClient>, now?: () => Date }} options
 */
function createHindsightPatternAdapter(options = {}) {
  const client = options.client;
  if (!client) throw new Error('hindsightPatternAdapter requires a hindsight client');

  const tracked = new Map(); // patternId → { version, activeFactId }
  const queues = new Map();
  function enqueue(id, op) {
    const prev = queues.get(id) || Promise.resolve();
    const run = prev.then(op);
    queues.set(id, run.catch(() => {}));
    return run;
  }

  async function retainVersion(pattern, version) {
    const documentId = `gaia-ptn-${pattern.id}-v${version}`;
    await client.retainSync({
      content: pattern.statement,
      context: PATTERN_CONTEXT,
      tags: [PATTERN_TAG],
      metadata: metadataFor(pattern, version),
      documentId,
    });
    const units = await adoptDocumentFacts(client, documentId);
    const factId = units[0] && units[0].id != null ? String(units[0].id) : null;
    return { documentId, factId };
  }

  async function saveImpl(next) {
    const t = tracked.get(next.id) || { version: 0, activeFactId: null };
    const version = t.version + 1;
    const { factId } = await retainVersion(next, version);
    tracked.set(next.id, { version, activeFactId: factId });
  }

  async function updateImpl(next) {
    let t = tracked.get(next.id);
    if (!t) t = tracked.get(next.id) = { version: 0, activeFactId: null };
    const version = t.version + 1;
    const { documentId, factId } = await retainVersion(next, version);
    if (t.activeFactId) {
      // Supersede, never delete — prior versions stay as audit history.
      try { await client.patchMemoryState(t.activeFactId, 'invalidated', `superseded by ${documentId}`); } catch (_) {}
    }
    tracked.set(next.id, { version, activeFactId: factId });
  }

  /**
   * Boot/state-sync: highest ACTIVE version per pattern id, reconstructed
   * from gaia_pattern_* metadata (never from relevance scores).
   */
  async function loadActivePatterns() {
    const units = await client.listMemories({ q: PATTERN_CONTEXT, type: 'world', limit: 200, state: 'valid' });
    const byId = new Map();
    for (const u of units) {
      if (!u.metadata || !u.metadata.gaia_pattern_id) continue;
      if (!(u.tags || []).includes(PATTERN_TAG)) continue;
      const id = u.metadata.gaia_pattern_id;
      const version = parseInt(u.metadata.gaia_pattern_version || '0', 10) || 0;
      const current = byId.get(id);
      if (!current || version > current._v) byId.set(id, { _v: version, unit: u });
    }
    const out = [];
    for (const { _v, unit } of byId.values()) {
      const p = reconstructFromUnit(unit);
      if (!p) continue;
      tracked.set(p.id, { version: _v, activeFactId: p.sourceRef });
      out.push(p);
    }
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  /**
   * Per-turn contextual retrieval (Pattern Awareness 0.1): native recall
   * scoped to gaia:pattern — the same tag-scoped recall shape as the
   * hypothesis adapter's recallHypotheses. No new search engine; Hindsight
   * ranks, this only reconstructs. Each result carries `relevance`, which is
   * Hindsight's RETRIEVAL score for THIS query and is never Gaia confidence
   * (the same §13 rule as hypotheses): confidence lives in the persisted
   * gaia_pattern_confidence metadata alone. Deduplicated per pattern id;
   * a missing/absent score degrades to 0 so an unscored pattern can never
   * pass a relevance floor by accident.
   */
  async function recallPatterns(query) {
    const results = await client.recall(query, {
      types: ['world'],
      tags: [PATTERN_TAG],
      tagsMatch: 'all_strict',
    });
    const seen = new Set();
    const out = [];
    for (const r of results) {
      const p = reconstructFromUnit(r);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      const scores = (r && r.scores) || {};
      const relevance = [scores.final, scores.reranker, scores.semantic].find((v) => Number.isFinite(v));
      out.push({ ...p, relevance: Number.isFinite(relevance) ? relevance : 0 });
    }
    return out;
  }

  return {
    sink: {
      save: (next) => enqueue(next.id, () => saveImpl(next)),
      update: (id, next) => enqueue(next.id, () => updateImpl(next)),
    },
    loadActivePatterns,
    recallPatterns,
    PATTERN_TAG,
  };
}

module.exports = {
  createHindsightPatternAdapter,
  PATTERN_TAG,
  PATTERN_CONTEXT,
};
