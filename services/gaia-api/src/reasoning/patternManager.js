'use strict';

/**
 * Pattern Manager — ReasonIQ 0.4's conservative pattern-formation layer.
 *
 * A pattern is a HIGHER-ORDER INTERPRETATION connecting two or more DURABLE
 * hypotheses that may be parts of a recurring pattern. It is not a new kind
 * of memory, not a mental model, and never a proven fact — the concept stays
 * explicitly probabilistic (brief §1/§2/§13).
 *
 *   Evidence → Hypotheses → Pattern candidate
 *
 * Boundary: maintains pattern state only. Never requires/calls Hindsight,
 * ReasonIQ, Hermes, web/MCP capabilities or the Decision Engine; persistence
 * goes through an INJECTED sink ({ save, update }) exactly like
 * hypothesisManager.js. Formation is gated (§9) and conservative: false-
 * positive patterns are worse than missed ones (§20).
 *
 * Lifecycle (deliberately small, deliberately NOT "confirmed"):
 *
 *   candidate → supported → established
 *        ↑          ↓            ↓
 *        └──────────┴────────────┘   (strong counter-evidence demotes back
 *                                      toward candidate; never a terminal
 *                                      "confirmed" semantics)
 *
 * Confidence is DERIVED, explainable policy — no ML (§3):
 *   base        = mean confidence of non-rejected member hypotheses
 *   independence= uniqueEvidenceRefs / totalEvidenceMentions across members
 *                 (three hypotheses from one observation are NOT three
 *                 independent proofs — §4)
 *   penalty     = −0.15 per rejected (contradicting) member
 *   bonus       = +0.05 per independent supporting member beyond the first
 *                 two (capped at +0.10)
 * then clamped to [0, 0.95] (soul.md: never claim certainty).
 *
 * Status policy: supported needs ≥ minIndependentSupportForSupported
 * independent supporting members AND confidence ≥ supportedConfidence AND no
 * rejected members; established needs ≥ established thresholds likewise.
 * Anything failing its current tier's requirements falls back toward
 * candidate through the validated transition map below.
 */

const PATTERN_STATUSES = Object.freeze(['candidate', 'supported', 'established']);
const INITIAL_PATTERN_STATUS = 'candidate';

/**
 * Validated lifecycle edges. Downgrades to candidate are the designed
 * response to strong counter-evidence (§2); nothing here ever reaches a
 * hypothetical "confirmed".
 */
const PATTERN_TRANSITIONS = Object.freeze({
  candidate: Object.freeze(['supported']),
  supported: Object.freeze(['established', 'candidate']),
  established: Object.freeze(['candidate']),
});

/** Patterns are long-term constructs by definition (§15) — durable only. */
const PATTERN_PERSISTENCE = 'durable';

const DEFAULT_PATTERN_POLICY = Object.freeze({
  /** Minimum durable hypotheses for any pattern to form. */
  minMembers: 2,
  /**
   * Independent supporting members required for `supported`. Deliberately
   * ABOVE the formation minimum: a freshly registered pattern stays
   * `candidate` (explicitly uncertain) until MORE independent evidence has
   * accumulated — false-positive patterns are worse than missed ones (§20).
   */
  minIndependentSupportForSupported: 3,
  /** Independent supporting members required for `established`. */
  minIndependentSupportForEstablished: 4,
  /** Confidence floor for `supported`. */
  supportedConfidence: 0.6,
  /** Confidence floor for `established`. */
  establishedConfidence: 0.78,
  /** Penalty per rejected (contradicting) member hypothesis. */
  contradictionPenalty: 0.15,
  /** Bonus per independent supporting member beyond the first two, capped. */
  extraSupportBonus: 0.05,
  extraSupportBonusCap: 0.10,
});

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(0.95, Math.max(0, n)) * 10000) / 10000;
}

function normalizeStatement(statement) {
  return String(statement || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP_TOKENS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'bo', 'vaak', 'waarschijnlijk', 'patroon', 'pattern', 'hypotheses', 'durable']);

function contentTokens(statement) {
  return normalizeStatement(statement).split(' ').filter((w) => w.length > 3 && !STOP_TOKENS.has(w));
}

/** Member independence from shared evidence provenance (§4). */
function independenceFrom(sharedCount) {
  if (sharedCount <= 0) return 'high';
  if (sharedCount === 1) return 'medium';
  return 'low';
}

function makeAudit(record) {
  return {
    patternId: record.patternId || null,
    from: record.from || null,
    to: record.to || null,
    relation: record.relation || null,
    accepted: record.accepted !== false,
    reason: record.reason || null,
    rationale: record.rationale || null,
    confidenceBefore: typeof record.confidenceBefore === 'number' ? record.confidenceBefore : null,
    confidenceAfter: typeof record.confidenceAfter === 'number' ? record.confidenceAfter : null,
  };
}

/**
 * @param {{
 *   patterns?: Array<object>, seed state (loaded from Hindsight by the caller)
 *   sink?: { save?: Function, update?: Function }, injectable persistence; default honest no-op
 *   policy?: Partial<typeof DEFAULT_PATTERN_POLICY>,
 *   now?: () => Date,
 * }} options
 */
function createPatternManager(options = {}) {
  const policy = { ...DEFAULT_PATTERN_POLICY, ...(options.policy || {}) };
  const sink = options.sink || {};
  const now = options.now || (() => new Date());
  const byId = new Map();
  const byNormalized = new Map();
  const byMemberKey = new Map();
  let counter = 0;
  const audits = [];

  function remember(p) {
    byId.set(p.id, p);
    byNormalized.set(normalizeStatement(p.statement), p);
    byMemberKey.set([...p.hypothesisIds].sort().join('|'), p);
    return p;
  }

  function settleSinkCall(result) {
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
  }
  function persistSave(p) {
    try {
      if (typeof sink.save === 'function') {
        if (process.env.DEBUG_PM_SAVE) console.error('[persistSave]', p.id, new Error().stack.split('\n').slice(2, 5).join(' | '));
        settleSinkCall(sink.save({ ...p }));
      }
    } catch (_) { /* persistence must never break reasoning-state upkeep */ }
  }
  function persistUpdate(prev, p) {
    try { if (typeof sink.update === 'function') settleSinkCall(sink.update(p.id, { ...p }, prev ? { ...prev } : null)); } catch (_) {}
  }

  function seedAll(list) {
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || typeof p.statement !== 'string' || !p.statement.trim() || !p.id) continue;
      if (byId.has(String(p.id))) continue;
      remember({
        id: String(p.id),
        statement: p.statement,
        status: PATTERN_STATUSES.includes(p.status) ? p.status : INITIAL_PATTERN_STATUS,
        confidence: clampConfidence(p.confidence) != null ? clampConfidence(p.confidence) : 0.5,
        hypothesisIds: Array.isArray(p.hypothesisIds) ? [...p.hypothesisIds] : [],
        supportingHypotheses: Array.isArray(p.supportingHypotheses) ? [...p.supportingHypotheses] : [],
        contradictingHypotheses: Array.isArray(p.contradictingHypotheses) ? [...p.contradictingHypotheses] : [],
        persistence: PATTERN_PERSISTENCE,
        history: Array.isArray(p.history) ? [...p.history] : [],
        createdAt: p.createdAt || now().toISOString(),
        updatedAt: p.updatedAt || now().toISOString(),
      });
    }
  }
  seedAll(options.patterns);

  /**
   * Derives strength + membership roles for a set of member hypotheses.
   * Pure policy math — see the module header for every coefficient.
   * @param {Array<{id:string, statement:string, status:string, confidence:number, evidenceFor?:string[]}>} members
   */
  function computeStrength(members) {
    const supporting = members.filter((m) => m.status !== 'rejected');
    const contradicting = members.filter((m) => m.status === 'rejected');

    // Evidence-independence: count each unique native evidence ref once,
    // across ALL members (§4 — shared provenance is one proof, not many).
    const refOwners = new Map(); // ref -> Set(hypId)
    let totalMentions = 0;
    for (const m of members) {
      for (const ref of m.evidenceFor || []) {
        totalMentions += 1;
        if (!refOwners.has(ref)) refOwners.set(ref, new Set());
        refOwners.get(ref).add(m.id);
      }
    }
    const uniqueRefs = refOwners.size;
    const independence = totalMentions > 0 ? uniqueRefs / totalMentions : 1;

    const base = supporting.length
      ? supporting.reduce((s, m) => s + (Number(m.confidence) || 0), 0) / supporting.length
      : 0;
    const bonus = Math.min(policy.extraSupportBonusCap, Math.max(0, supporting.length - 2) * policy.extraSupportBonus);
    const confidence = clampConfidence(Math.max(0, base * independence - policy.contradictionPenalty * contradicting.length + bonus));

    // Per-member independence labels from pairwise shared refs.
    const membersDetail = members.map((m) => {
      const mine = new Set(m.evidenceFor || []);
      const sharedWith = [];
      let sharedTotal = 0;
      for (const other of members) {
        if (other.id === m.id) continue;
        const shared = (other.evidenceFor || []).filter((r) => mine.has(r));
        if (shared.length > 0) { sharedWith.push(other.id); sharedTotal += shared.length; }
      }
      return {
        hypothesisId: m.id,
        role: m.status === 'rejected' ? 'contradicts' : 'supports',
        independence: independenceFrom(sharedTotal),
        sharedEvidenceWith: sharedWith,
      };
    });

    const independentSupporting = membersDetail.filter((d) => d.role === 'supports' && d.independence !== 'low').length;
    return { confidence, independence, membersDetail, supportingHypotheses: supporting.map((m) => m.id), contradictingHypotheses: contradicting.map((m) => m.id), independentSupporting };
  }

  function targetStatusFor(strength) {
    if (strength.membersDetail.filter((d) => d.role === 'contradicts').length === 0) {
      if (strength.independentSupporting >= policy.minIndependentSupportForEstablished && strength.confidence >= policy.establishedConfidence) return 'established';
      if (strength.independentSupporting >= policy.minIndependentSupportForSupported && strength.confidence >= policy.supportedConfidence) return 'supported';
    }
    return 'candidate'; // contradictions or weak support keep it explicitly uncertain (§11)
  }

  /**
   * Recomputes a tracked pattern against CURRENT hypothesis states and moves
   * it along the validated lifecycle when the policy demands it. Demotions
   * toward candidate happen automatically on strong counter-evidence (a
   * rejected member) or weakened confidence.
   */
  function refresh(patternId, hypothesesById) {
    const p = byId.get(patternId);
    if (!p) return null;
    const prev = { ...p };
    let members = p.hypothesisIds.map((id) => hypothesesById[id]).filter(Boolean);
    if (members.length < 2) return null;

    // Membership growth (conservative, same relatedness rule as discovery):
    // a DURABLE hypothesis joins when it shares ≥1 native evidence ref OR
    // ≥0.34 token-Jaccard with any current member. Ephemeral never joins.
    const memberIds = new Set(members.map((m) => m.id));
    const joined = [];
    for (const cand of Object.values(hypothesesById || {})) {
      if (!cand || cand.persistence !== 'durable' || memberIds.has(cand.id)) continue;
      const related = members.some((m) => {
        const sharedRefs = (cand.evidenceFor || []).filter((r) => (m.evidenceFor || []).includes(r));
        if (sharedRefs.length > 0) return true;
        const ta = new Set(contentTokens(cand.statement));
        const tb = new Set(contentTokens(m.statement));
        let inter = 0; for (const t of ta) if (tb.has(t)) inter += 1;
        const uni = ta.size + tb.size - inter;
        return uni > 0 && inter / uni >= 0.34;
      });
      if (related) { memberIds.add(cand.id); members.push(cand); joined.push(cand.id); }
    }
    if (joined.length > 0) {
      p.hypothesisIds = [...p.hypothesisIds, ...joined];
      p.history.push({ at: now().toISOString(), rationale: 'members joined via provenance/similarity', added: joined });
    }

    const strength = computeStrength(members);
    p.confidence = strength.confidence;
    p.supportingHypotheses = strength.supportingHypotheses;
    p.contradictingHypotheses = strength.contradictingHypotheses;
    p.membersDetail = strength.membersDetail;

    const wanted = targetStatusFor(strength);
    if (wanted !== p.status) {
      const allowed = PATTERN_TRANSITIONS[p.status] || [];
      if (allowed.includes(wanted)) {
        const iso = now().toISOString();
        const from = p.status;
        p.status = wanted;
        p.updatedAt = iso;
        p.history.push({ from, to: wanted, at: iso, rationale: 'policy recomputation', confidence: p.confidence });
        audits.push(makeAudit({
          patternId: p.id, relation: 'lifecycle', from, to: wanted,
          confidenceBefore: prev.confidence, confidenceAfter: p.confidence,
          rationale: `independentSupport=${strength.independentSupporting} confidence=${p.confidence}`,
        }));
      } else {
        audits.push(makeAudit({
          patternId: p.id, relation: 'lifecycle', from: p.status, to: wanted,
          accepted: false, reason: `invalid transition ${p.status} -> ${wanted}`,
        }));
      }
    }
    p.updatedAt = now().toISOString();
    persistUpdate(prev, p);
    return p;
  }

  function findDuplicate(statement, hypothesisIds) {
    const memberKey = [...hypothesisIds].sort().join('|');
    const byMembers = byMemberKey.get(memberKey);
    if (byMembers) return byMembers;
    const byStatement = byNormalized.get(normalizeStatement(statement));
    if (byStatement) return byStatement;
    for (const p of byId.values()) {
      if (normalizeStatement(p.statement) && normalizeStatement(p.statement) === normalizeStatement(statement)) return p;
    }
    return null;
  }

  /**
   * Registers a pattern candidate over existing Gaia hypotheses (stable ids
   * only — never copies of their content as source of truth, §5/§16).
   * Deduplicated by identical hypothesis-id set or normalized statement.
   */
  function register({ hypothesisIds = [], statement, rationale, hypothesesById } = {}) {
    const ids = [...new Set(hypothesisIds)].filter((id) => hypothesesById ? Boolean(hypothesesById[id]) : true);
    if (ids.length < policy.minMembers) {
      audits.push(makeAudit({ relation: 'register', accepted: false, reason: `needs at least ${policy.minMembers} known hypotheses (got ${ids.length}; lookup=${hypothesesById ? Object.keys(hypothesesById).length : 'none'})` }));
      return { ok: false, reason: `needs at least ${policy.minMembers} known hypotheses` };
    }
    const duplicate = findDuplicate(statement || '', ids);
    if (duplicate) {
      audits.push(makeAudit({ patternId: duplicate.id, relation: 'register', accepted: true, reason: 'duplicate; returning existing pattern' }));
      return { ok: true, pattern: duplicate, duplicateOf: duplicate.id };
    }

    const members = ids.map((id) => hypothesesById[id]).filter(Boolean);
    const strength = computeStrength(members);
    counter += 1;
    const id = `pattern-${counter}`;
    const p = remember({
      id,
      statement: String(statement || '').trim() || `Recurring relationship across ${ids.length} durable hypotheses.`,
      status: INITIAL_PATTERN_STATUS,
      confidence: strength.confidence,
      hypothesisIds: ids,
      supportingHypotheses: strength.supportingHypotheses,
      contradictingHypotheses: strength.contradictingHypotheses,
      membersDetail: strength.membersDetail,
      independence: strength.independence,
      persistence: PATTERN_PERSISTENCE,
      history: [],
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    persistSave(p);
    audits.push(makeAudit({
      patternId: id, relation: 'register', accepted: true,
      confidenceBefore: null, confidenceAfter: p.confidence,
      rationale: rationale || `formed from ${ids.length} durable hypotheses`,
    }));

    // Immediately evaluate whether the initial evidence already justifies
    // more than candidate — via the same validated lifecycle path.
    const refreshed = refresh(id, hypothesesById || {});
    return { ok: true, pattern: refreshed || p, duplicateOf: null };
  }

  /** Explicit lifecycle move (validated); used by tests and future seams. */
  function setStatus(patternId, target, { rationale } = {}) {
    const p = byId.get(patternId);
    if (!p) return { ok: false, reason: `unknown pattern: ${patternId}` };
    if (!PATTERN_STATUSES.includes(target)) return { ok: false, reason: `invalid pattern status: ${target}` };
    const allowed = PATTERN_TRANSITIONS[p.status] || [];
    if (!allowed.includes(target)) {
      audits.push(makeAudit({ patternId: p.id, from: p.status, to: target, accepted: false, reason: `invalid transition ${p.status} -> ${target}` }));
      return { ok: false, reason: `invalid transition ${p.status} -> ${target}` };
    }
    const prev = { ...p };
    const iso = now().toISOString();
    p.status = target;
    p.updatedAt = iso;
    p.history.push({ from: prev.status, to: target, at: iso, rationale: rationale || null });
    persistUpdate(prev, p);
    audits.push(makeAudit({ patternId: p.id, from: prev.status, to: target, rationale: rationale || null }));
    return { ok: true };
  }

  /**
   * Gated formation entry (§7/§9): clusters related DURABLE hypotheses into
   * pattern candidates. EPHEMERAL hypotheses are excluded outright (§8).
   * Returns { formed, updated } summaries; empty unless the gate opened.
   *
   * Clustering rule (deliberately simple, conservative): two durable
   * hypotheses relate when they share ≥1 native evidence ref (provenance
   * overlap) OR their statements overlap ≥ similarityThreshold Jaccard.
   * Clusters smaller than minMembers form nothing.
   */
  function maybeFormPatterns({ hypotheses = [], changedHypothesisIds = [] } = {}) {
    const durable = hypotheses.filter((h) => h && h.persistence === 'durable');
    const changedDurable = changedHypothesisIds.filter((id) => durable.some((h) => h.id === id));
    if (durable.length < policy.minMembers || changedDurable.length === 0) {
      return { formed: [], updated: [], gateOpen: false, reason: 'gate closed: need ≥2 durable hypotheses and ≥1 changed this turn' };
    }

    // Plain object (NOT a Map): downstream lookups use obj[id]/Object.values.
    const byIdMap = Object.fromEntries(durable.map((h) => [h.id, h]));
    // Union-find clustering over pairwise relatedness.
    const parent = new Map(durable.map((h) => [h.id, h.id]));
    const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };

    const norm = new Map(durable.map((h) => [h.id, new Set(contentTokens(h.statement))]));
    for (let i = 0; i < durable.length; i += 1) {
      for (let j = i + 1; j < durable.length; j += 1) {
        const a = durable[i]; const b = durable[j];
        const sharedRefs = (a.evidenceFor || []).filter((r) => (b.evidenceFor || []).includes(r));
        const ta = norm.get(a.id); const tb = norm.get(b.id);
        let inter = 0; for (const t of ta) if (tb.has(t)) inter += 1;
        const union0 = ta.size + tb.size - inter;
        const jaccard = union0 > 0 ? inter / union0 : 0;
        if (sharedRefs.length > 0 || jaccard >= 0.34) union(a.id, b.id);
      }
    }

    const clusters = new Map();
    for (const h of durable) {
      const root = find(h.id);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(h);
    }

    const formed = []; const updated = [];
    for (const cluster of clusters.values()) {
      if (cluster.length < policy.minMembers) continue;
      const ids = cluster.map((h) => h.id).sort();
      // Existing-pattern matching: exact member-set/statement first, then
      // OVERLAP — a grown cluster that shares ≥ minMembers hypotheses with
      // an existing pattern refreshes that pattern instead of forking a
      // near-duplicate one (§10).
      let best = null; let bestOverlap = 0;
      for (const p of byId.values()) {
        const ov = ids.filter((id) => p.hypothesisIds.includes(id)).length;
        if (ov > bestOverlap) { bestOverlap = ov; best = p; }
      }
      const existing = findDuplicate('', ids)
        || (bestOverlap >= policy.minMembers ? best : null);
      if (existing) {
        const before = { status: existing.status, confidence: existing.confidence };
        const r = refresh(existing.id, byIdMap);
        updated.push(r ? { id: existing.id, ...before, after: { status: r.status, confidence: r.confidence } } : null);
        continue;
      }
      // Neutral, honest auto-statement from the most frequent content tokens.
      const freq = new Map();
      for (const h of cluster) for (const t of contentTokens(h.statement)) freq.set(t, (freq.get(t) || 0) + 1);
      const topics = [...freq.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
      const res = register({
        hypothesisIds: ids,
        statement: topics.length
          ? `Recurring relationship around: ${topics.join(', ')}.`
          : `Recurring relationship across ${ids.length} durable hypotheses.`,
        rationale: `discovered from ${ids.length} related durable hypotheses`,
        hypothesesById: byIdMap,
      });
      if (res.ok && !res.duplicateOf) formed.push(res.pattern);
      else if (res.ok) updated.push({ id: res.duplicateOf, mergedIntoExisting: true });
    }
    return { formed, updated: updated.filter(Boolean), gateOpen: true };
  }

  return {
    register,
    refresh,
    maybeFormPatterns,
    setStatus,
    seed: seedAll,
    get: (id) => byId.get(id) || null,
    list: () => [...byId.values()],
    audits,
    policy,
    TRANSITIONS: PATTERN_TRANSITIONS,
  };
}

module.exports = {
  createPatternManager,
  PATTERN_STATUSES,
  PATTERN_TRANSITIONS,
  PATTERN_PERSISTENCE,
  DEFAULT_PATTERN_POLICY,
};
