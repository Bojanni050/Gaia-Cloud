'use strict';

/**
 * Hypothesis Manager — ReasonIQ 0.3's controlled hypothesis lifecycle.
 *
 * Boundary: this module MAINTAINS hypothesis state; it never reasons. It
 * consumes already-structured reasoning output (ReasonIQ 0.3's
 * hypothesisUpdates / evidence-linked hypotheses) and turns it into
 * explicit, validated state transitions. It never calls Hindsight, Hermes,
 * any web/MCP capability, or the Decision Engine; persistence goes through
 * an INJECTED sink ({ save, update }) so Hindsight stays the only place
 * anything ever durably lives (brief §15) — and since hindsightClient has
 * no hypothesis API yet, the default sink is an honest no-op and the
 * manager keeps state in memory for the turn that owns it.
 *
 * Lifecycle (the frozen transitions below mirror the shape documented in
 * logos/reasonModels.js — services/cognition is a separate deployable not
 * present in this repo, so THIS map is this codebase's single source of
 * truth until that service exists):
 *
 *   proposed → testing → confirmed
 *                      ↘ rejected
 *   confirmed → testing   (new contradicting pressure — §9: a confirmed
 *                          hypothesis never silently survives a contradiction)
 *   rejected  → testing   (strong new evidence re-opens it — explicit only)
 *
 * Confirming/rejecting is deliberately HARD (§8): an LLM saying "likely"
 * is never enough. Transitions to confirmed/rejected go through
 * evaluateTransition(), which checks the evidence policy below — every
 * threshold is named and documented here, none are magic.
 */

const { EVIDENCE_VERDICTS } = require('../logos/reasonModels');

/**
 * The allowed status transitions. Anything not listed here is refused,
 * e.g. proposed → confirmed (a proposal must at least pass through
 * testing) and unknown → anything.
 */
const HYPOTHESIS_TRANSITIONS = Object.freeze({
  proposed: Object.freeze(['testing', 'rejected']),
  testing: Object.freeze(['confirmed', 'rejected']),
  confirmed: Object.freeze(['testing']),
  rejected: Object.freeze(['testing']),
});

/**
 * Evidence policy (§8) — every value explicit and overridable via
 * createHypothesisManager({ policy }). These gate confirm/reject so no
 * single model call can settle a hypothesis.
 */
const DEFAULT_POLICY = Object.freeze({
  /** Distinct supporting evidence items required before confirm is even possible. */
  minSupportEvidence: 2,
  /** Confidence a hypothesis must have reached before confirm is possible. */
  confirmConfidence: 0.75,
  /** A hypothesis with active contradicting evidence can never be confirmed. */
  confirmRequiresNoContradictions: true,
  /** Distinct opposing items required before reject is possible. */
  minOpposeEvidence: 2,
  /** Confidence at-or-below which reject is possible (with enough oppose evidence). */
  rejectConfidence: 0.35,
});

/** Statuses always start here when a new hypothesis is proposed. */
const INITIAL_STATUS = 'proposed';

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Rounded to 4 decimals: confidence arithmetic must not accumulate
  // 0.68000000001-style float noise across turns.
  return Math.round(Math.min(0.95, Math.max(0, n)) * 10000) / 10000; // soul.md: never claim certainty
}

function normalizeStatement(statement) {
  return String(statement || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(statement) {
  const STOPWORDS = new Set([
    // Articles/copulas + the causal verbs every hypothesis statement leans on.
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'by', 'of', 'to', 'in', 'it', 'its', 'this', 'that', 'and', 'or',
    'causes', 'cause', 'caused', 'causing', 'comes', 'come', 'makes', 'make', 'leads', 'lead',
    // Prepositions/connectives that carry no hypothesis-specific meaning.
    'from', 'with', 'into', 'onto', 'over', 'under', 'about', 'after', 'before', 'between', 'during', 'without', 'within', 'when', 'then', 'than', 'also',
  ]);
  return new Set(normalizeStatement(statement).split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

/** Simple token-Jaccard similarity seam (§12) — deliberately NOT semantic dedup. */
function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

const DEDUP_SIMILARITY_THRESHOLD = 0.7;

function makeAudit(record) {
  return {
    hypothesisId: record.hypothesisId || null,
    from: record.from || null,
    to: record.to || null,
    relation: record.relation || null,
    evidenceId: record.evidenceId || null,
    confidenceBefore: typeof record.confidenceBefore === 'number' ? record.confidenceBefore : null,
    confidenceAfter: typeof record.confidenceAfter === 'number' ? record.confidenceAfter : null,
    rationale: record.rationale || null,
    accepted: record.accepted !== false,
    reason: record.reason || null,
  };
}

/**
 * @param {{
 *   hypotheses?: Array<object>, seed state (e.g. retrieved from Hindsight by the caller)
 *   sink?: { save?: Function, update?: Function }, injected persistence; default honest no-op
 *   policy?: Partial<typeof DEFAULT_POLICY>,
 *   now?: () => Date,
 * }} options
 */
function createHypothesisManager(options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy || {}) };
  const sink = options.sink || {};
  const now = options.now || (() => new Date());
  const byId = new Map();
  const byNormalized = new Map();
  let counter = 0;
  const audits = [];

  function remember(hyp) {
    byId.set(hyp.id, hyp);
    byNormalized.set(normalizeStatement(hyp.statement), hyp);
    return hyp;
  }

  function persistSave(hyp) {
    try {
      if (typeof sink.save === 'function') sink.save({ ...hyp });
    } catch (_) { /* persistence must never break reasoning-state upkeep */ }
  }

  function persistUpdate(prev, hyp) {
    try {
      if (typeof sink.update === 'function') sink.update(hyp.id, { ...hyp }, prev ? { ...prev } : null);
    } catch (_) { /* same posture */ }
  }

  // Seed from caller-supplied existing hypotheses (ids preserved verbatim).
  for (const h of Array.isArray(options.hypotheses) ? options.hypotheses : []) {
    if (!h || typeof h.statement !== 'string' || !h.statement.trim() || !h.id) continue;
    remember({
      id: String(h.id),
      statement: h.statement,
      status: ['proposed', 'testing', 'confirmed', 'rejected'].includes(h.status) ? h.status : 'testing',
      confidence: clampConfidence(h.confidence) != null ? clampConfidence(h.confidence) : 0.5,
      evidenceFor: Array.isArray(h.evidenceFor) ? [...h.evidenceFor] : [],
      evidenceAgainst: Array.isArray(h.evidenceAgainst) ? [...h.evidenceAgainst] : [],
      history: Array.isArray(h.history) ? [...h.history] : [],
      createdAt: h.createdAt || now().toISOString(),
      updatedAt: h.updatedAt || now().toISOString(),
    });
  }

  function findDuplicate(statement) {
    const exact = byNormalized.get(normalizeStatement(statement));
    if (exact) return exact;
    for (const hyp of byId.values()) {
      if (similarity(hyp.statement, statement) >= DEDUP_SIMILARITY_THRESHOLD) return hyp;
    }
    return null;
  }

  /**
   * Proposes a hypothesis — or recognizes an equivalent existing one (§4/§12).
   * @returns {{ hypothesis: object, duplicateOf: string|null }}
   */
  function propose({ statement, confidence = 0.5, evidenceFor = [], evidenceAgainst = [] } = {}) {
    if (!statement || !String(statement).trim()) throw new Error('hypothesis statement is required');
    const existing = findDuplicate(statement);
    if (existing) return { hypothesis: existing, duplicateOf: existing.id };

    counter += 1;
    const id = `hyp-${counter}`;
    const hyp = remember({
      id,
      statement: String(statement).trim(),
      status: INITIAL_STATUS,
      confidence: clampConfidence(confidence) != null ? clampConfidence(confidence) : 0.5,
      evidenceFor: [...new Set(evidenceFor)],
      evidenceAgainst: [...new Set(evidenceAgainst)],
      history: [],
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    persistSave(hyp);
    audits.push(makeAudit({ hypothesisId: id, relation: 'proposed', rationale: 'new hypothesis proposed' }));
    return { hypothesis: hyp, duplicateOf: null };
  }

  function canConfirm(h) {
    const hasActiveContradiction = policy.confirmRequiresNoContradictions && h.evidenceAgainst.length > 0;
    return h.evidenceFor.length >= policy.minSupportEvidence
      && h.confidence >= policy.confirmConfidence
      && !hasActiveContradiction;
  }

  function canReject(h) {
    return h.evidenceAgainst.length >= policy.minOpposeEvidence
      && h.confidence <= policy.rejectConfidence;
  }

  function transition(h, to, rationale) {
    const prev = { ...h };
    const allowed = HYPOTHESIS_TRANSITIONS[h.status] || [];
    if (!allowed.includes(to)) {
      audits.push(makeAudit({
        hypothesisId: h.id, from: h.status, to,
        accepted: false,
        reason: `invalid transition ${h.status} -> ${to}`,
      }));
      return { ok: false, reason: `invalid transition ${h.status} -> ${to}` };
    }
    h.status = to;
    h.updatedAt = now().toISOString();
    h.history.push({ from: prev.status, to, at: h.updatedAt, rationale: rationale || null });
    persistUpdate(prev, h);
    audits.push(makeAudit({
      hypothesisId: h.id, from: prev.status, to,
      confidenceBefore: prev.confidence, confidenceAfter: h.confidence,
      rationale: rationale || null,
    }));
    return { ok: true };
  }

  /**
   * Explicitly evaluates a target status against the lifecycle FIRST, then
   * the evidence policy (§7/§8). `confirmed`/`rejected` additionally
   * require a stated rationale — the human-readable "why now" that keeps
   * these transitions auditable.
   */
  function evaluateTransition(hypothesisId, target, { rationale } = {}) {
    const h = byId.get(hypothesisId);
    if (!h) return { ok: false, reason: `unknown hypothesis: ${hypothesisId}` };
    if (target !== 'confirmed' && target !== 'rejected' && target !== 'testing') {
      return { ok: false, reason: `evaluateTransition targets confirmed/rejected/testing, got ${target}` };
    }
    // Lifecycle legality precedes policy: an illegal edge is refused even
    // if the policy numbers would happen to allow it (e.g. proposed ->
    // confirmed can never skip testing, whatever the confidence says).
    const allowed = HYPOTHESIS_TRANSITIONS[h.status] || [];
    if (!allowed.includes(target)) {
      audits.push(makeAudit({ hypothesisId: h.id, from: h.status, to: target, accepted: false, reason: `invalid transition ${h.status} -> ${target}` }));
      return { ok: false, reason: `invalid transition ${h.status} -> ${target}` };
    }
    if (target === 'confirmed') {
      if (!canConfirm(h)) {
        audits.push(makeAudit({ hypothesisId: h.id, from: h.status, to: 'confirmed', accepted: false, reason: 'policy: insufficient support/confidence or active contradictions' }));
        return { ok: false, reason: 'policy: needs more distinct support, higher confidence, and no active contradictions' };
      }
    }
    if (target === 'rejected') {
      if (!canReject(h)) {
        audits.push(makeAudit({ hypothesisId: h.id, from: h.status, to: 'rejected', accepted: false, reason: 'policy: insufficient opposition or confidence still too high' }));
        return { ok: false, reason: 'policy: needs more distinct opposing evidence and lower confidence' };
      }
    }
    if ((target === 'confirmed' || target === 'rejected') && !rationale) {
      return { ok: false, reason: 'a rationale is required for confirm/reject transitions' };
    }
    if (target === 'testing' && h.status !== 'testing') {
      // Re-open paths (confirmed→testing, rejected→testing) demand a reason too.
      if (!rationale) return { ok: false, reason: 're-opening requires a rationale' };
    }
    return transition(h, target, rationale);
  }

  /**
   * Applies one explicit evidence update (§6). Relation must be one of the
   * four verdicts; irrelevant adjusts nothing but is recorded. A
   * contradiction on a confirmed hypothesis automatically demotes it to
   * testing (§9) — never silently left confirmed.
   */
  function applyUpdate(update = {}) {
    const h = update.hypothesisId ? byId.get(update.hypothesisId) : null;
    if (!h) return makeAudit({ accepted: false, reason: `unknown hypothesis: ${update.hypothesisId}` });
    const relation = update.relation;
    if (!EVIDENCE_VERDICTS.includes(relation)) {
      return makeAudit({ hypothesisId: h.id, accepted: false, reason: `invalid relation: ${relation}` });
    }
    const prev = { ...h };

    if (relation === 'supports') {
      // A nulled citation (provenance stripped an invented id upstream)
      // still carries the relation's confidence effect but must never
      // pollute the evidence lists with a non-id.
      if (update.evidenceId && !h.evidenceFor.includes(update.evidenceId)) h.evidenceFor.push(update.evidenceId);
      h.confidence = clampConfidence(h.confidence + (Number(update.confidenceDelta) || 0));
    } else if (relation === 'weakens') {
      if (update.evidenceId && !h.evidenceAgainst.includes(update.evidenceId)) h.evidenceAgainst.push(update.evidenceId);
      h.confidence = clampConfidence(h.confidence - Math.abs(Number(update.confidenceDelta) || 0));
    } else if (relation === 'contradicts') {
      if (update.evidenceId && !h.evidenceAgainst.includes(update.evidenceId)) h.evidenceAgainst.push(update.evidenceId);
      h.confidence = clampConfidence(h.confidence - Math.abs(Number(update.confidenceDelta) || 0.15));
    } else { // irrelevant
      h.updatedAt = now().toISOString();
      audits.push(makeAudit({
        hypothesisId: h.id, relation, evidenceId: update.evidenceId || null,
        confidenceBefore: h.confidence, confidenceAfter: h.confidence,
        rationale: update.rationale || null,
      }));
      return audits[audits.length - 1];
    }

    h.updatedAt = now().toISOString();

    // §9: contradicting pressure on a CONFIRMED hypothesis forces it back
    // to testing immediately and explicitly — recorded, never silent.
    if (relation === 'contradicts' && h.status === 'confirmed') {
      h.status = 'testing';
      h.history.push({ from: 'confirmed', to: 'testing', at: h.updatedAt, rationale: 'contradicting evidence arrived' });
      persistUpdate(prev, h);
      audits.push(makeAudit({
        hypothesisId: h.id, from: 'confirmed', to: 'testing',
        relation, evidenceId: update.evidenceId || null,
        confidenceBefore: prev.confidence, confidenceAfter: h.confidence,
        rationale: update.rationale || 'contradicting evidence',
      }));
      return audits[audits.length - 1];
    }

    // First real evidence moves a fresh proposal into testing.
    if (h.status === 'proposed' && (relation === 'supports' || relation === 'weakens')) {
      h.status = 'testing';
      h.history.push({ from: 'proposed', to: 'testing', at: h.updatedAt, rationale: 'first evidence applied' });
    }

    persistUpdate(prev, h);
    audits.push(makeAudit({
      hypothesisId: h.id, from: prev.status, to: h.status,
      relation, evidenceId: update.evidenceId || null,
      confidenceBefore: prev.confidence, confidenceAfter: h.confidence,
      rationale: update.rationale || null,
    }));
    return audits[audits.length - 1];
  }

  /**
   * Consumes ReasonIQ's structured output for one turn: proposes (with
   * dedup) each evidence-linked hypothesis and applies its explicit
   * updates. This is the ONLY way reasoning output enters state — there is
   * no path where the model mutates a hypothesis directly.
   * @param {object} reasoningResult a validated ReasoningResult (0.3 adds hypothesisUpdates)
   * @returns {{ applied: object[] }} audit records
   */
  function applyReasoningResult(reasoningResult) {
    const applied = [];
    const resultHyps = Array.isArray(reasoningResult && reasoningResult.hypotheses) ? reasoningResult.hypotheses : [];
    const idFor = new Map(); // result-hypothesis -> managed id

    for (const rh of resultHyps) {
      if (!rh || !rh.statement) continue;
      // An explicit match to an existing hypothesis wins over text dedup.
      let target = rh.existingId ? byId.get(rh.existingId) : null;
      let duplicateOf = null;
      if (target) {
        duplicateOf = target.id;
      } else {
        const res = propose({ statement: rh.statement, confidence: rh.confidence, evidenceFor: [], evidenceAgainst: [] });
        target = res.hypothesis;
        duplicateOf = res.duplicateOf;
      }
      idFor.set(rh, target);

      // Merge provenance-filtered links (no-op duplicates).
      for (const id of rh.evidenceFor || []) {
        if (!target.evidenceFor.includes(id)) target.evidenceFor.push(id);
      }
      for (const id of rh.evidenceAgainst || []) {
        if (!target.evidenceAgainst.includes(id)) target.evidenceAgainst.push(id);
      }
      const isFresh = rh.existingId == null;
      if (isFresh) {
        // Fresh proposal drifts toward the model's own assessment of confidence.
        const c = clampConfidence(rh.confidence);
        if (c != null) target.confidence = c;
        // First real evidence moves a fresh proposal into testing (§5:
        // a hypothesis backed by linked evidence IS under test).
        if (target.status === 'proposed' && (target.evidenceFor.length > 0 || target.evidenceAgainst.length > 0)) {
          target.status = 'testing';
          target.updatedAt = now().toISOString();
          target.history.push({ from: 'proposed', to: 'testing', at: target.updatedAt, rationale: 'first evidence linked' });
        }
      }
      void duplicateOf;
    }

    const updates = Array.isArray(reasoningResult && reasoningResult.hypothesisUpdates)
      ? reasoningResult.hypothesisUpdates
      : [];
    for (const u of updates) {
      const managedId = u.hypothesisId;
      applied.push(applyUpdate({ ...u, hypothesisId: managedId }));
    }
    return { applied };
  }

  return {
    propose,
    applyUpdate,
    applyReasoningResult,
    evaluateTransition,
    get: (id) => byId.get(id) || null,
    list: () => [...byId.values()],
    audits,
    policy,
    TRANSITIONS: HYPOTHESIS_TRANSITIONS,
  };
}

module.exports = {
  createHypothesisManager,
  HYPOTHESIS_TRANSITIONS,
  DEFAULT_POLICY,
  INITIAL_STATUS,
  DEDUP_SIMILARITY_THRESHOLD,
  similarity,
  normalizeStatement,
};
