'use strict';

/**
 * Cognition sink — the persistence seam for the Logos reasoning managers
 * (HypothesisManager / PatternManager) now that Cognition owns the store and
 * the lifecycle (Phase 4 cutover).
 *
 * Where the retired `hindsightHypothesisAdapter` / `hindsightPatternAdapter`
 * wrote straight into Hindsight, these sinks persist to services/cognition and
 * mirror each stored record into Hindsight through cognitionSync. The
 * managers keep their in-memory reasoning state; Cognition is the store of
 * record, and Hindsight stays the derived store the read adapters recall from.
 *
 * Status is never set directly:
 *   save   → propose/create.
 *   update → diff against prev and send operations (evidence verdicts,
 *            confidence/statement/persistence patches, and the matching
 *            lifecycle verb). `confirmed` is deliberately never mirrored —
 *            only the human GaiaChat confirm reaches it (Absolute Override).
 *            `corroborated` (the manager's micro soft-promotion) steps the
 *            store through `testing` first, because that is the store's only
 *            path to the machine tier.
 *
 * Pure mapping. No reasoning.
 */

function createCognitionSink({ cognition, sync } = {}) {
  if (!cognition) throw new Error('cognitionSink requires a cognition client');

  const hypIdMap = new Map();     // manager hyp id -> cognition id
  const patternIdMap = new Map(); // manager pattern id -> cognition id

  async function mirrorHypothesis(record) {
    if (!sync || !record) return;
    try { await sync.syncHypothesis(record); } catch (_) { /* mirroring never breaks a turn */ }
  }
  async function mirrorPattern(record) {
    if (!sync || !record) return;
    try { await sync.syncPattern(record); } catch (_) { /* same posture */ }
  }

  // --- hypotheses ---------------------------------------------------------

  async function saveHypothesis(next) {
    const record = await cognition.proposeHypothesis({
      statement: next.statement,
      confidence: next.confidence,
      evidence_for: next.evidenceFor || [],
      evidence_against: next.evidenceAgainst || [],
      persistence: next.persistence,
      method: next.method,
      kind: next.kind || 'hypothesis',
      sources: next.sources || [],
      counter_hypothesis: next.counterHypothesis || null,
      scope: next.scope || undefined,
    });
    hypIdMap.set(String(next.id), String(record.id));
    await mirrorHypothesis(record);
    return record;
  }

  async function updateHypothesis(id, next, prev) {
    const cid = hypIdMap.get(String(id)) || String(id);
    const before = prev || {};
    let record = null;

    const patch = {};
    if (next.statement !== before.statement) patch.statement = next.statement;
    if (next.confidence !== before.confidence) patch.confidence = next.confidence;
    if (next.persistence !== before.persistence) patch.persistence = next.persistence;
    if (next.method !== before.method) patch.method = next.method;
    // V3: a hypothesis may gain its counter-hypothesis on a later turn; scope
    // is set at proposal and not changed implicitly.
    if ((next.counterHypothesis || null) !== (before.counterHypothesis || null)) {
      patch.counter_hypothesis = next.counterHypothesis || null;
    }
    if (next.scope && next.scope !== before.scope) patch.scope = next.scope;
    if (Object.keys(patch).length > 0) record = await cognition.updateHypothesis(cid, patch);

    const prevFor = new Set(before.evidenceFor || []);
    const prevAgainst = new Set(before.evidenceAgainst || []);
    for (const evidenceId of next.evidenceFor || []) {
      if (prevFor.has(evidenceId)) continue;
      record = await cognition.applyEvidence(cid, { relation: 'supports', evidenceId, confidenceDelta: 0 });
    }
    for (const evidenceId of next.evidenceAgainst || []) {
      if (prevAgainst.has(evidenceId)) continue;
      record = await cognition.applyEvidence(cid, { relation: 'contradicts', evidenceId, confidenceDelta: 0 });
    }

    if (before.status !== next.status) {
      if (next.status === 'testing' && before.status === 'rejected') {
        // A reopen is the one human-initiated exit from the quarantine; its
        // reason rides on the manager's history entry. markTesting would be
        // refused by the store (rejected is terminal), so route it explicitly.
        const last = Array.isArray(next.history) ? next.history[next.history.length - 1] : null;
        const reason = (last && last.rationale) || 'reopened by human';
        record = await cognition.reopenHypothesis(cid, { reason });
      } else if (next.status === 'testing') record = await cognition.markTesting(cid);
      else if (next.status === 'corroborated') {
        // The store's machine tier is reached from `testing` only. The manager
        // can legitimately hold `testing` while the store record is still
        // `proposed` (a fresh proposal is created as proposed; its first
        // evidence is applied in memory), so ask the store where it actually is
        // and walk it through testing instead of trusting the local snapshot.
        const current = await cognition.getHypothesis(cid).catch(() => null);
        const at = current && current.status;
        if (at === 'corroborated' || at === 'confirmed' || at === 'rejected') {
          // Already at or past the machine tier — the periodic scan, or the
          // person, got there first. Cognition is the record of truth: mirror
          // it as it is instead of pushing a verb the store would refuse.
          record = current;
        } else {
          if (!current || at === 'proposed') record = await cognition.markTesting(cid);
          record = await cognition.markCorroborated(cid);
        }
      } else if (next.status === 'rejected') record = await cognition.rejectHypothesis(cid, { reason: next.rejectionReason });
      // 'confirmed' is intentionally not mirrored here.
    }

    if (!record) record = await cognition.getHypothesis(cid).catch(() => null);
    await mirrorHypothesis(record);
    return record;
  }

  // --- patterns -----------------------------------------------------------

  async function savePattern(next) {
    const record = await cognition.createPattern({
      content: next.statement,
      confidence: next.confidence,
      status: next.status,
      hypothesis_ids: next.hypothesisIds || [],
      sources: next.sources || [],
    });
    patternIdMap.set(String(next.id), String(record.id));
    await mirrorPattern(record);
    return record;
  }

  async function updatePattern(id, next) {
    const cid = patternIdMap.get(String(id)) || String(id);
    const record = await cognition.updatePattern(cid, {
      content: next.statement,
      confidence: next.confidence,
      status: next.status,
      hypothesis_ids: next.hypothesisIds || [],
    });
    await mirrorPattern(record);
    return record;
  }

  return {
    hypothesis: { save: saveHypothesis, update: updateHypothesis },
    pattern: { save: savePattern, update: updatePattern },
    hypIdMap,
    patternIdMap,
  };
}

module.exports = { createCognitionSink };
