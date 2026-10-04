'use strict';

/**
 * Cognition → Hindsight sync writer (the job moved out of Foundation).
 *
 * Cognition is the source of truth for DERIVED knowledge (hypotheses,
 * patterns, candidate models). Hindsight is the derived knowledge store:
 * every derived record is mirrored here so Gaia's recall can surface it,
 * tagged in one canonical `gaia:*` namespace:
 *
 *   gaia:hypothesis      a derived statement (any status)
 *   gaia:pattern         a pattern
 *   gaia:confirmed_fact  a hypothesis the human confirmed (Absolute Override)
 *
 * Each state change becomes a new superseding version (document_id
 * `gaia-hyp-{id}-v{N}` / `gaia-ptn-{id}-v{N}`); the previous active unit is
 * invalidated ("superseded by …") so exactly one active version remains,
 * while the audit trail stays behind. `reconcile()` re-pushes every current
 * Cognition record and is the basis of the one-time tag reconciliation.
 *
 * Boundary: pure mapping, no reasoning, no status judgment. The manager/Logos
 * owns state; this file only speaks to Hindsight via the injected client.
 */

const HYPOTHESIS_TAG = 'gaia:hypothesis';
const CONFIRMED_TAG = 'gaia:confirmed_fact';
const PATTERN_TAG = 'gaia:pattern';
const HYPOTHESIS_CONTEXT = 'gaia hypothesis';
const PATTERN_CONTEXT = 'gaia pattern';
const LEGACY_FACT_TAG = 'foundation:fact';
const UPDATED_BY = 'gaia-logos';

async function adoptDocumentFacts(client, documentId, attempts = 3) {
  let last = [];
  for (let i = 0; i < attempts; i += 1) {
    last = await client.listMemories({ documentId, type: 'world' });
    if (last.length > 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return last;
}

function hypothesisMetadata(record, version) {
  return {
    gaia_hypothesis_id: String(record.id),
    gaia_hypothesis_version: String(version),
    gaia_hypothesis_status: String(record.status || ''),
    gaia_hypothesis_confidence: String(record.confidence != null ? record.confidence : ''),
    gaia_hypothesis_kind: String(record.kind || 'hypothesis'),
    gaia_hypothesis_sources: JSON.stringify(Array.isArray(record.sources) ? record.sources : []),
    gaia_hypothesis_verwerp_bron: record.verwerp_bron != null ? String(record.verwerp_bron) : '',
    gaia_hypothesis_updated_by: UPDATED_BY,
  };
}

function patternMetadata(record, version) {
  return {
    gaia_pattern_id: String(record.id),
    gaia_pattern_version: String(version),
    gaia_pattern_status: String(record.status || ''),
    gaia_pattern_confidence: String(record.confidence != null ? record.confidence : ''),
    gaia_pattern_sources: JSON.stringify(Array.isArray(record.sources) ? record.sources : []),
    gaia_pattern_updated_by: UPDATED_BY,
  };
}

function tagsForHypothesis(record) {
  return record.status === 'confirmed' ? [HYPOTHESIS_TAG, CONFIRMED_TAG] : [HYPOTHESIS_TAG];
}

/**
 * @param {{ hindsight: object, cognition?: object, now?: () => Date }} options
 */
function createCognitionSync({ hindsight, cognition, now = () => new Date() } = {}) {
  if (!hindsight) throw new Error('cognitionSync requires a hindsight client');

  const activeHyps = new Map(); // id -> { version, factId, status }
  const activePatterns = new Map();

  async function retainAndSupersede({ tracked, id, documentId, content, context, tags, metadata }) {
    await hindsight.retainSync({ content, context, tags, metadata, documentId });
    const units = await adoptDocumentFacts(hindsight, documentId);
    const factId = units[0] && units[0].id != null ? String(units[0].id) : null;
    const previous = tracked.get(id);
    if (previous && previous.factId) {
      try {
        await hindsight.patchMemoryState(previous.factId, 'invalidated', `superseded by ${documentId}`);
      } catch (_) { /* superseding an already-gone unit is harmless */ }
    }
    return factId;
  }

  /** Mirror one derived statement. Increments its version on every change. */
  async function syncHypothesis(record) {
    if (!record || record.id == null) return null;
    const t = activeHyps.get(String(record.id)) || { version: 0, factId: null, status: null };
    const version = t.version + 1;
    const documentId = `gaia-hyp-${record.id}-v${version}`;
    const factId = await retainAndSupersede({
      tracked: activeHyps,
      id: String(record.id),
      documentId,
      content: String(record.statement || ''),
      context: HYPOTHESIS_CONTEXT,
      tags: tagsForHypothesis(record),
      metadata: hypothesisMetadata(record, version),
    });
    activeHyps.set(String(record.id), { version, factId, status: record.status || null });
    return { documentId, factId, version };
  }

  async function syncPattern(record) {
    if (!record || record.id == null) return null;
    const t = activePatterns.get(String(record.id)) || { version: 0, factId: null, status: null };
    const version = t.version + 1;
    const documentId = `gaia-ptn-${record.id}-v${version}`;
    const factId = await retainAndSupersede({
      tracked: activePatterns,
      id: String(record.id),
      documentId,
      content: String(record.content || record.statement || ''),
      context: PATTERN_CONTEXT,
      tags: [PATTERN_TAG],
      metadata: patternMetadata(record, version),
    });
    activePatterns.set(String(record.id), { version, factId, status: record.status || null });
    return { documentId, factId, version };
  }

  /** Seed version/status state from Hindsight's current valid units. */
  async function loadActive() {
    activeHyps.clear();
    activePatterns.clear();
    const units = await hindsight.listMemories({ q: HYPOTHESIS_CONTEXT, type: 'world', limit: 200, state: 'valid' });
    for (const u of Array.isArray(units) ? units : []) {
      const meta = u && u.metadata;
      if (!meta) continue;
      if (meta.gaia_hypothesis_id) {
        const id = String(meta.gaia_hypothesis_id);
        const version = parseInt(meta.gaia_hypothesis_version || '0', 10) || 0;
        const cur = activeHyps.get(id);
        if (!cur || version > cur.version) {
          activeHyps.set(id, { version, factId: u.id != null ? String(u.id) : null, status: meta.gaia_hypothesis_status || null });
        }
      } else if (meta.gaia_pattern_id) {
        const id = String(meta.gaia_pattern_id);
        const version = parseInt(meta.gaia_pattern_version || '0', 10) || 0;
        const cur = activePatterns.get(id);
        if (!cur || version > cur.version) {
          activePatterns.set(id, { version, factId: u.id != null ? String(u.id) : null, status: meta.gaia_pattern_status || null });
        }
      }
    }
  }

  /** Invalidate every currently-valid unit carrying any of `tags`. */
  async function invalidateByTags(tags, reason) {
    const units = await hindsight.listMemories({ q: 'gaia', type: 'world', limit: 200, state: 'valid' });
    let invalidated = 0;
    for (const u of Array.isArray(units) ? units : []) {
      const unitTags = (u && u.tags) || [];
      if (!tags.some((t) => unitTags.includes(t))) continue;
      try {
        await hindsight.patchMemoryState(u.id, 'invalidated', reason);
        invalidated += 1;
      } catch (_) { /* best-effort */ }
    }
    return invalidated;
  }

  /**
   * Re-push every current Cognition record, skipping those already reflected
   * with the same status. Basis of the one-time tag reconciliation.
   * @param {{ clear?: boolean }} [options] clear = invalidate all current
   *   gaia:* units first, then re-push each record as a fresh version.
   */
  async function reconcile({ clear = false } = {}) {
    if (!cognition) throw new Error('reconcile requires a cognition client');
    if (clear) await invalidateByTags([HYPOTHESIS_TAG, PATTERN_TAG], 'reconciliation');
    await loadActive();

    const result = { hypothesesPushed: 0, hypothesesSkipped: 0, patternsPushed: 0, patternsSkipped: 0 };
    for (const h of await cognition.listHypotheses()) {
      const cur = activeHyps.get(String(h.id));
      if (!clear && cur && cur.status === (h.status || null)) { result.hypothesesSkipped += 1; continue; }
      await syncHypothesis(h);
      result.hypothesesPushed += 1;
    }
    for (const p of await cognition.listPatterns()) {
      const cur = activePatterns.get(String(p.id));
      if (!clear && cur && cur.status === (p.status || null)) { result.patternsSkipped += 1; continue; }
      await syncPattern(p);
      result.patternsPushed += 1;
    }
    return result;
  }

  return {
    syncHypothesis, syncPattern, loadActive, invalidateByTags, reconcile,
    HYPOTHESIS_TAG, CONFIRMED_TAG, PATTERN_TAG, LEGACY_FACT_TAG,
  };
}

module.exports = {
  createCognitionSync,
  HYPOTHESIS_TAG,
  CONFIRMED_TAG,
  PATTERN_TAG,
  LEGACY_FACT_TAG,
  HYPOTHESIS_CONTEXT,
  PATTERN_CONTEXT,
};
