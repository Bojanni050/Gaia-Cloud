'use strict';

/**
 * Hindsight Hypothesis Adapter — Gaia Hypothesis Persistence 0.1.
 *
 * The thin mapping layer between HypothesisManager's injectable persistence
 * sink and Hindsight's native REST API. Per the audit conclusion, a Gaia
 * hypothesis persists as a RETAINED WORLD FACT:
 *
 *   type        = world            (Hindsight's extraction of an objective claim)
 *   tag         = gaia:hypothesis  (+ optional topic tags later)
 *   context     = "gaia hypothesis"
 *   document_id = gaia-hyp-{hypId}-v{N}      (one document per VERSION)
 *   metadata    = the gaia_hypothesis_* state (string→string; arrays JSON)
 *
 * Lifecycle mapping (the MANAGER decides every transition; this layer only
 * translates):
 *   create/update/testing   → retain a NEW version document; the previous
 *                             active fact is natively invalidated
 *                             ("superseded by …") so exactly one active
 *                             version per hypothesis remains recallable.
 *   rejected                → PATCH the active fact state="invalidated" with
 *                             the rejection reason — Hindsight's native
 *                             reversible invalidation IS the rejected state
 *                             (recall-excluded, auditable).
 *   re-open                 → a fresh active version is retained; the old
 *                             invalidated rows stay behind as history.
 *   confirmed               → manager policy approves, then sink.promote()
 *                             registers the settled statement as durable
 *                             knowledge: its own retained fact
 *                             (document gaia-hyp-{id}-promoted), whose
 *                             adopted native fact id becomes
 *                             promotedFactId.
 *
 * Boundary: pure mapping. No reasoning, no confidence judgment, no dedup,
 * no transition policy, no evidence weighing. Confidence NEVER comes from
 * Hindsight's relevance scores (those rank within one query; they are not
 * calibrated belief) — only from the persisted gaia_hypothesis_confidence
 * metadata. Observations and mental models are never used as the owner of a
 * hypothesis; they can only ever show up as EVIDENCE (by native id).
 */

const HYPOTHESIS_TAG = 'gaia:hypothesis';
const KNOWLEDGE_TAG = 'gaia:knowledge';
const HYPOTHESIS_CONTEXT = 'gaia hypothesis';
const KNOWLEDGE_CONTEXT = 'gaia knowledge';
const UPDATED_BY = 'gaia-reasoniq';

/**
 * Adopts the native fact id(s) Hindsight assigned to a just-retained
 * document. Sync retain completes extraction before responding, so the
 * units are queryable immediately; the tiny retry covers scheduling jitter.
 */
async function adoptDocumentFacts(client, documentId, attempts = 3) {
  let last = [];
  for (let i = 0; i < attempts; i += 1) {
    last = await client.listMemories({ documentId, type: 'world' });
    if (last.length > 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return last;
}

function metadataFor(hyp, version) {
  return {
    gaia_hypothesis_id: String(hyp.id),
    gaia_hypothesis_version: String(version),
    gaia_hypothesis_status: String(hyp.status || ''),
    gaia_hypothesis_confidence: String(hyp.confidence != null ? hyp.confidence : ''),
    // string→string API: structured values ride as JSON.
    gaia_hypothesis_evidence_for: JSON.stringify(Array.isArray(hyp.evidenceFor) ? hyp.evidenceFor : []),
    gaia_hypothesis_evidence_against: JSON.stringify(Array.isArray(hyp.evidenceAgainst) ? hyp.evidenceAgainst : []),
    gaia_hypothesis_updated_by: UPDATED_BY,
    // Extra Gaia-state that reconstruction needs (same gaia_ namespace).
    gaia_hypothesis_method: String(hyp.method || ''),
    gaia_hypothesis_rejection_reason: hyp.rejectionReason != null ? String(hyp.rejectionReason) : '',
  };
}

function intMetadata(unit, key) {
  const raw = unit && unit.metadata ? unit.metadata[key] : null;
  return raw == null ? null : String(raw);
}

function jsonMetadata(unit, key) {
  const raw = intMetadata(unit, key);
  if (raw == null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return []; // a corrupt value must never fabricate evidence
  }
}

/** Hindsight memory/recall unit → Gaia hypothesis state (metadata = truth). */
function reconstructFromUnit(unit) {
  if (!unit || !unit.metadata || !unit.metadata.gaia_hypothesis_id) return null;
  const status = intMetadata(unit, 'gaia_hypothesis_status') || null;
  const confRaw = parseFloat(intMetadata(unit, 'gaia_hypothesis_confidence'));
  return {
    id: intMetadata(unit, 'gaia_hypothesis_id'),
    statement: unit.text || '',
    status,
    confidence: Number.isFinite(confRaw) ? confRaw : null,
    version: parseInt(intMetadata(unit, 'gaia_hypothesis_version') || '', 10) || null,
    evidenceFor: jsonMetadata(unit, 'gaia_hypothesis_evidence_for'),
    evidenceAgainst: jsonMetadata(unit, 'gaia_hypothesis_evidence_against'),
    sourceRef: unit.id != null ? String(unit.id) : null, // native Hindsight fact id
    updatedAt: unit.mentionedAt || null,
    method: intMetadata(unit, 'gaia_hypothesis_method') || 'asserted',
    rejectionReason: intMetadata(unit, 'gaia_hypothesis_rejection_reason') || null,
    testedAt: null,
    confirmedAt: null,
    rejectedAt: null,
    // Promotion markers live outside the fact metadata (they describe a
    // separate promoted document); boot-loaded hypotheses re-register their
    // own promotion state through the manager/sink round-trip.
    promotedFactId: null,
    promotionPending: false,
  };
}

/**
 * @param {{ client: ReturnType<import('../hindsightClient').createHindsightClient>, now?: () => Date }} options
 */
function createHindsightHypothesisAdapter(options = {}) {
  const client = options.client;
  if (!client) throw new Error('hindsightHypothesisAdapter requires a hindsight client');
  const now = options.now || (() => new Date());

  // hypId → { version, activeFactId|null, activeFactIsValid }
  const tracked = new Map();
  // hypId → promoted native fact id (mirror of what promote() returned).
  const promoted = new Map();
  // hypId → Promise — serializes storage operations per hypothesis. The
  // manager mutates synchronously while this adapter persists in the
  // background; without ordering, an update could race past its own save
  // and fork versions.
  const queues = new Map();

  function enqueue(hypId, op) {
    const prev = queues.get(hypId) || Promise.resolve();
    const run = prev.then(op);
    // The stored tail never rejects (failures surface to the caller of THIS
    // op via run; the queue itself must stay usable).
    queues.set(hypId, run.catch(() => {}));
    return run;
  }

  function trackFor(hypId) {
    let t = tracked.get(hypId);
    if (!t) {
      t = { version: 0, activeFactId: null, activeFactIsValid: false };
      tracked.set(hypId, t);
    }
    return t;
  }

  async function retainVersion(hyp, version) {
    const documentId = `gaia-hyp-${hyp.id}-v${version}`;
    await client.retainSync({
      content: hyp.statement,
      context: HYPOTHESIS_CONTEXT,
      tags: [HYPOTHESIS_TAG],
      metadata: metadataFor(hyp, version),
      documentId,
    });
    const units = await adoptDocumentFacts(client, documentId);
    const factId = units[0] && units[0].id != null ? String(units[0].id) : null;
    return { documentId, factId };
  }

  async function saveImpl(next) {
    const t = trackFor(next.id);
    if (t.version && !t.needsFirstPersist) {
      // A queued update already created storage for this hypothesis before
      // its save ran — persist the latest state as a new version instead of
      // forking a second v1.
      const { documentId: docId, factId } = await retainVersion(next, t.version + 1);
      if (t.activeFactId && t.activeFactIsValid) {
        await client.patchMemoryState(t.activeFactId, 'invalidated', `superseded by ${docId}`);
      }
      t.version += 1;
      t.activeFactId = factId;
      t.activeFactIsValid = true;
      return;
    }
    const { factId } = await retainVersion(next, 1);
    t.version = 1;
    t.activeFactId = factId;
    t.activeFactIsValid = true;
    t.needsFirstPersist = false;
  }

  async function updateImpl(next, prev) {
    let t = trackFor(next.id);
    if (!t.version || t.needsFirstPersist) {
      // First touch for a hypothesis unknown to storage (externally seeded):
      // materialize its CURRENT state as v1 — a rejection is stored and
      // immediately invalidated so recall never sees it, keeping the audit.
      await saveImpl({ ...next, status: next.status });
      t = trackFor(next.id);
      if (next.status === 'rejected' && t.activeFactId) {
        await client.patchMemoryState(t.activeFactId, 'invalidated', next.rejectionReason || 'rejected by Gaia hypothesis policy');
        t.activeFactIsValid = false;
      }
      return;
    }

    if (next.status === 'rejected' && prev && prev.status !== 'rejected') {
      if (t.activeFactId && t.activeFactIsValid) {
        await client.patchMemoryState(t.activeFactId, 'invalidated', next.rejectionReason || 'rejected by Gaia hypothesis policy');
      }
      t.activeFactIsValid = false;
      return;
    }

    const changedEvidence = JSON.stringify((prev && prev.evidenceFor) || []) !== JSON.stringify(next.evidenceFor || [])
      || JSON.stringify((prev && prev.evidenceAgainst) || []) !== JSON.stringify(next.evidenceAgainst || []);
    const meaningful = next.status !== (prev && prev.status)
      || next.confidence !== (prev && prev.confidence)
      || next.statement !== (prev && prev.statement)
      || changedEvidence;
    if (!meaningful) return;

    const version = t.version + 1;
    const { documentId, factId } = await retainVersion(next, version);
    if (t.activeFactId && t.activeFactIsValid) {
      await client.patchMemoryState(t.activeFactId, 'invalidated', `superseded by ${documentId}`);
    }
    t.version = version;
    t.activeFactId = factId;
    t.activeFactIsValid = true;
  }

  async function promoteImpl(p) {
    const existing = promoted.get(p.hypothesisId);
    if (existing) return { factId: existing };
    const documentId = `gaia-hyp-${p.hypothesisId}-promoted`;
    await client.retainSync({
      content: p.statement,
      context: KNOWLEDGE_CONTEXT,
      tags: [HYPOTHESIS_TAG, KNOWLEDGE_TAG],
        metadata: {
          gaia_hypothesis_id: String(p.hypothesisId),
          // Not a versioned state row — this document IS the promotion.
          gaia_hypothesis_version: 'promoted',
          gaia_hypothesis_status: 'confirmed',
          gaia_hypothesis_confidence: String(p.confidence != null ? p.confidence : ''),
          gaia_hypothesis_updated_by: UPDATED_BY,
          gaia_promotion_rationale: p.rationale != null ? String(p.rationale) : '',
        },
      documentId,
    });
    const units = await adoptDocumentFacts(client, documentId);
    const factId = units[0] && units[0].id != null ? String(units[0].id) : null;
    if (factId) promoted.set(p.hypothesisId, factId);
    return { factId };
  }

  const sink = {
    /** New hypothesis → first persisted version. */
    save: (next) => enqueue(next.id, () => saveImpl(next)),

    /**
     * State change → either native invalidation (rejected) or a fresh
     * active version superseding the previous one (everything else).
     */
    update: (id, next, prev) => enqueue(next.id, () => updateImpl(next, prev)),

    /**
     * Confirmed → register the settled statement as durable Gaia knowledge
     * (its own retained fact) and hand the native id back to the manager.
     * Called once per hypothesis by the manager's idempotence guard.
     */
    promote: (p) => enqueue(p.hypothesisId, () => promoteImpl(p)),
  };

  /**
   * Boot/state-sync: reconstructs the CURRENT active Gaia hypotheses from
   * Hindsight. Uses memories/list full-text over our constant context label
   * (the list endpoint has no tag filter — a documented API constraint;
   * tag-scoped semantic retrieval goes through recallHypotheses below).
   * Invalidated units are skipped server-side via state=valid, which is
   * exactly "not rejected / not superseded".
   */
  async function loadActiveHypotheses() {
    const units = await client.listMemories({ q: HYPOTHESIS_CONTEXT, type: 'world', limit: 200, state: 'valid' });
    const byId = new Map();
    for (const u of units) {
      if (!u.metadata || !u.metadata.gaia_hypothesis_id) continue;
      if (!(u.tags || []).includes(HYPOTHESIS_TAG)) continue;
      const id = u.metadata.gaia_hypothesis_id;
      const version = parseInt(u.metadata.gaia_hypothesis_version || '0', 10) || 0;
      const current = byId.get(id);
      if (!current || version > current._v) byId.set(id, { _v: version, unit: u });
    }
    const out = [];
    for (const { _v, unit } of byId.values()) {
      const h = reconstructFromUnit(unit);
      if (!h) continue;
      // Register storage state so later updates keep versioning correctly.
      const t = trackFor(h.id);
      if (_v > t.version) {
        t.version = _v;
        t.activeFactId = h.sourceRef;
        t.activeFactIsValid = true;
      }
      t.needsFirstPersist = false; // this hypothesis already lives in storage
      out.push(h);
    }
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  /**
   * Per-turn contextual retrieval: native recall scoped to Gaia hypotheses.
   * Returns reconstructed hypotheses; Hindsight's ranking scores are
   * deliberately dropped — they are relevance, never Gaia confidence (§13).
   */
  async function recallHypotheses(query) {
    const results = await client.recall(query, {
      types: ['world'],
      tags: [HYPOTHESIS_TAG],
      tagsMatch: 'all_strict',
    });
    const seen = new Set();
    const out = [];
    for (const r of results) {
      const h = reconstructFromUnit(r);
      if (!h || seen.has(h.id)) continue;
      seen.add(h.id);
      out.push(h);
    }
    return out;
  }

  return {
    sink,
    loadActiveHypotheses,
    recallHypotheses,
    HYPOTHESIS_TAG,
  };
}

module.exports = {
  createHindsightHypothesisAdapter,
  HYPOTHESIS_TAG,
  HYPOTHESIS_CONTEXT,
};
