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
 *
 * Provenance note (0.3.x): several concepts here are adopted from
 * github.com/alash3al/stash — the four-way evidence verdicts were already
 * borrowed in logos/reasonModels.js; this pass adds its hypothesis-shape
 * ideas: a `method` field (asserted|derived|tested), an explicit
 * `rejectionReason`, tested/confirmed/rejected timestamps, and knowledge
 * promotion on confirm. Two DELIBERATE divergences, both required by our
 * own briefs: (1) Stash treats confirmed/rejected as terminal states — we
 * allow re-opening (confirmed→testing, rejected→testing) because new
 * evidence must be able to put pressure on a settled belief (brief §7);
 * (2) Stash promotes a confirmed hypothesis into its internal facts table
 * itself — we have no store access here, so promotion is emitted through
 * the INJECTED sink (`promote`), keeping this module store-agnostic. The
 * passive auto-confirm scan stage Stash also has was deliberately NOT
 * adopted: transitions happen only through explicit, policy-gated calls.
 */

const { EVIDENCE_VERDICTS } = require('../logos/reasonModels');

/** How a hypothesis came to be / was settled (Stash's `method`, adopted). */
const HYPOTHESIS_METHODS = Object.freeze(['asserted', 'derived', 'tested']);

/**
 * Expected LIFETIME of a hypothesis (Gaia Persistence 0.1) — deliberately a
 * separate axis from status (lifecycle) and confidence (epistemic strength):
 *
 *   ephemeral → relevant to the current task/analysis only; must not leak
 *               into every future turn's context.
 *   durable   → meant to survive many turns and accumulate evidence over
 *               time; candidate for long-term recall. DURABLE MEANS
 *               LONGER-LIVED, NEVER "MORE TRUE".
 *
 * Default is ephemeral whenever nothing explicit says otherwise; switching
 * goes exclusively through setPersistence() (explicit, audited, idempotent).
 */
const HYPOTHESIS_PERSISTENCE = Object.freeze(['ephemeral', 'durable']);
const DEFAULT_PERSISTENCE = 'ephemeral';

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

function isValidMethod(m) {
  return HYPOTHESIS_METHODS.includes(m);
}

function isValidPersistence(p) {
  return HYPOTHESIS_PERSISTENCE.includes(p);
}

function persistenceOf(value) {
  return isValidPersistence(value) ? value : DEFAULT_PERSISTENCE;
}

/**
 * Maintains the timeline/method side-effects of a status change — the
 * Stash-style tested/confirmed/rejected stamps plus method promotion to
 * 'tested' once a hypothesis has actually been settled. Centralized so
 * every transition path (evaluateTransition, applyUpdate's demotion,
 * first-evidence promotion) stays consistent.
 */
function stampStatus(h, from, to, iso) {
  if (to === 'testing') h.testedAt = iso;
  if (to === 'confirmed') { h.confirmedAt = iso; h.method = 'tested'; }
  if (to === 'rejected') h.rejectedAt = iso;
  // Re-opening a rejected hypothesis clears its standing rejection reason —
  // the reason itself survives in the history entry that recorded the reject.
  if (to === 'testing' && from === 'rejected') h.rejectionReason = null;
}

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
 *   sink?: {
 *     save?: Function,
 *     update?: Function,
 *     promote?: ({ hypothesisId, statement, confidence, rationale }) => { factId?: string }|void,
 *   }, injected persistence; default honest no-op. `promote` (Stash's
 *     ConfirmHypothesis→fact pattern) is called ONCE per hypothesis when it
 *     first settles into confirmed; a returned factId is kept as promotedFactId.
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

  // Sinks may be synchronous or asynchronous (the Hindsight adapter is
  // inherently async). Sync throws are swallowed here; async rejections are
  // caught via .catch — persistence must never break state upkeep either way.
  function settleSinkCall(result) {
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
    }
  }

  function persistSave(hyp) {
    try {
      if (typeof sink.save === 'function') settleSinkCall(sink.save({ ...hyp }));
    } catch (_) { /* persistence must never break reasoning-state upkeep */ }
  }

  function persistUpdate(prev, hyp) {
    try {
      if (typeof sink.update === 'function') settleSinkCall(sink.update(hyp.id, { ...hyp }, prev ? { ...prev } : null));
    } catch (_) { /* same posture */ }
  }

  /**
   * Seeds hypotheses into live state — used by the constructor below and,
   * post-construction, by the server wiring to inject boot-loaded Hindsight
   * state (Hypothesis Persistence 0.1). Same validation everywhere; seeds
   * never overwrite an id the manager already knows.
   */
  function seedAll(list) {
    for (const h of Array.isArray(list) ? list : []) {
      if (!h || typeof h.statement !== 'string' || !h.statement.trim() || !h.id) continue;
      if (byId.has(String(h.id))) continue;
      remember({
        id: String(h.id),
        statement: h.statement,
        status: ['proposed', 'testing', 'confirmed', 'rejected'].includes(h.status) ? h.status : 'testing',
        method: isValidMethod(h.method) ? h.method : 'asserted',
        persistence: persistenceOf(h.persistence),
        confidence: clampConfidence(h.confidence) != null ? clampConfidence(h.confidence) : 0.5,
        evidenceFor: Array.isArray(h.evidenceFor) ? [...h.evidenceFor] : [],
        evidenceAgainst: Array.isArray(h.evidenceAgainst) ? [...h.evidenceAgainst] : [],
        rejectionReason: typeof h.rejectionReason === 'string' ? h.rejectionReason : null,
        testedAt: h.testedAt || null,
        confirmedAt: h.confirmedAt || null,
        rejectedAt: h.rejectedAt || null,
        promoted: Boolean(h.promoted),
        promotedFactId: typeof h.promotedFactId === 'string' && h.promotedFactId ? h.promotedFactId : null,
        promotionPending: Boolean(h.promotionPending),
        history: Array.isArray(h.history) ? [...h.history] : [],
        createdAt: h.createdAt || now().toISOString(),
        updatedAt: h.updatedAt || now().toISOString(),
      });
    }
  }

  seedAll(options.hypotheses);

  function findDuplicate(statement) {    const exact = byNormalized.get(normalizeStatement(statement));
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
  function propose({ statement, confidence = 0.5, evidenceFor = [], evidenceAgainst = [], method = 'asserted', persistence, persist = true } = {}) {
    if (!statement || !String(statement).trim()) throw new Error('hypothesis statement is required');
    const existing = findDuplicate(statement);
    if (existing) return { hypothesis: existing, duplicateOf: existing.id };

    counter += 1;
    const id = `hyp-${counter}`;
    const hyp = remember({
      id,
      statement: String(statement).trim(),
      status: INITIAL_STATUS,
      method: isValidMethod(method) ? method : 'asserted',
      persistence: persistenceOf(persistence),
      confidence: clampConfidence(confidence) != null ? clampConfidence(confidence) : 0.5,
      evidenceFor: [...new Set(evidenceFor)],
      evidenceAgainst: [...new Set(evidenceAgainst)],
      rejectionReason: null,
      testedAt: null,
      confirmedAt: null,
      rejectedAt: null,
      promoted: false,
      promotedFactId: null,
      promotionPending: false,
      history: [],
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    // Callers that still need to merge evidence into the fresh proposal pass
    // persist:false and save AFTER the merge — the first persisted version
    // must already carry its evidence provenance, never empty arrays.
    if (persist) persistSave(hyp);
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
    const iso = now().toISOString();
    const fromStatus = h.status;
    stampStatus(h, fromStatus, to, iso);
    if (to === 'rejected') h.rejectionReason = rationale || null;
    h.status = to;
    h.updatedAt = iso;
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
   * Knowledge promotion at confirm (Stash's ConfirmHypothesis→fact pattern,
   * store-agnostic edition): the settled statement is offered to the
   * injected sink exactly once. No sink.promote → honest promotionPending
   * instead of a silent drop; a throwing sink never breaks the transition;
   * an already-promoted hypothesis is never promoted twice.
   */
  function promoteConfirmed(h, prev, rationale) {
    if (h.promoted || h.promotedFactId != null) {
      audits.push(makeAudit({
        hypothesisId: h.id, relation: 'promote', accepted: true,
        confidenceAfter: h.confidence,
        reason: 'already promoted', rationale: rationale || null,
      }));
      return;
    }
    if (typeof sink.promote !== 'function') {
      h.promotionPending = true;
      h.updatedAt = now().toISOString();
      persistUpdate(prev, h);
      audits.push(makeAudit({
        hypothesisId: h.id, relation: 'promote', accepted: true,
        confidenceAfter: h.confidence,
        reason: 'sink has no promote; marked promotionPending', rationale: rationale || null,
      }));
      return;
    }
    try {
      const res = sink.promote({
        hypothesisId: h.id,
        statement: h.statement,
        confidence: h.confidence,
        persistence: h.persistence,
        rationale: rationale || null,
      });

      // Async sinks (the Hindsight adapter) return a promise: the confirm
      // transition already succeeded and is never rolled back; the promotion
      // settles in the background — promoted+factId on resolve, honest
      // promotionPending on rejection (brief §4/§16). Sync results finalize
      // immediately, exactly as before.
      if (res && typeof res.then === 'function') {
        h.promotionPending = true;
        h.updatedAt = now().toISOString();
        audits.push(makeAudit({
          hypothesisId: h.id, relation: 'promote', accepted: true,
          confidenceAfter: h.confidence,
          reason: 'promotion in flight (async sink)', rationale: rationale || null,
        }));
        Promise.resolve(res)
          .then((settled) => {
            const after = { ...h };
            h.promoted = true;
            h.promotionPending = false;
            if (settled && typeof settled.factId === 'string' && settled.factId.trim()) h.promotedFactId = settled.factId.trim();
            h.updatedAt = now().toISOString();
            persistUpdate(after, h);
            audits.push(makeAudit({
              hypothesisId: h.id, relation: 'promote', accepted: true,
              evidenceId: h.promotedFactId,
              confidenceAfter: h.confidence,
              rationale: 'async promotion settled',
            }));
          })
          .catch(() => {
            h.promoted = false;
            h.promotionPending = true;
            h.updatedAt = now().toISOString();
            persistUpdate({ ...h }, h);
            audits.push(makeAudit({
              hypothesisId: h.id, relation: 'promote', accepted: true,
              confidenceAfter: h.confidence,
              reason: 'async promotion failed; marked promotionPending', rationale: rationale || null,
            }));
          });
        return;
      }

      const after = { ...h };
      h.promoted = true;
      h.promotionPending = false;
      if (res && typeof res.factId === 'string' && res.factId.trim()) h.promotedFactId = res.factId.trim();
      h.updatedAt = now().toISOString();
      persistUpdate(after, h);
      audits.push(makeAudit({
        hypothesisId: h.id, relation: 'promote', accepted: true,
        evidenceId: h.promotedFactId,
        confidenceAfter: h.confidence,
        rationale: rationale || 'promoted confirmed statement',
      }));
    } catch (_) {
      h.promotionPending = true;
      h.updatedAt = now().toISOString();
      persistUpdate(prev, h);
      audits.push(makeAudit({
        hypothesisId: h.id, relation: 'promote', accepted: true,
        confidenceAfter: h.confidence,
        reason: 'promotion failed; marked promotionPending', rationale: rationale || null,
      }));
    }
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
    const res = transition(h, target, rationale);
    if (res.ok && target === 'confirmed') {
      promoteConfirmed(h, { ...h }, rationale);
    }
    return res;
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
      stampStatus(h, 'confirmed', 'testing', h.updatedAt);
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
      stampStatus(h, 'proposed', 'testing', h.updatedAt);
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
      const prevSnapshot = target ? { ...target } : null;
      let duplicateOf = null;
      if (target) {
        duplicateOf = target.id;
      } else {
        // persist:false — the fresh proposal still needs its evidence merged
        // below; the first persisted version must already carry provenance.
        const res = propose({
          statement: rh.statement,
          confidence: rh.confidence,
          evidenceFor: [],
          evidenceAgainst: [],
          persistence: rh.persistence,
          persist: false,
        });
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
        // Stash's `method`: a proposal that arrived already carrying
        // evidence links was DERIVED from that evidence; a bare statement
        // was ASSERTED by the model.
        target.method = (target.evidenceFor.length > 0 || target.evidenceAgainst.length > 0) ? 'derived' : 'asserted';
        // First real evidence moves a fresh proposal into testing (§5:
        // a hypothesis backed by linked evidence IS under test).
        if (target.status === 'proposed' && (target.evidenceFor.length > 0 || target.evidenceAgainst.length > 0)) {
          const iso = now().toISOString();
          stampStatus(target, 'proposed', 'testing', iso);
          target.status = 'testing';
          target.updatedAt = iso;
          target.history.push({ from: 'proposed', to: 'testing', at: iso, rationale: 'first evidence linked' });
        }
        // Persist AFTER the merge — v1 carries its provenance and state.
        persistSave(target);
      } else if (prevSnapshot && (prevSnapshot.confidence !== target.confidence
        || JSON.stringify(prevSnapshot.evidenceFor) !== JSON.stringify(target.evidenceFor)
        || JSON.stringify(prevSnapshot.evidenceAgainst) !== JSON.stringify(target.evidenceAgainst))) {
        // An EXISTING hypothesis gained links/confidence without an explicit
        // update row — still a persisted-state change.
        persistUpdate(prevSnapshot, target);
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

  /**
   * Explicit persistence-dimension change (Gaia Persistence 0.1): the ONLY
   * way ephemeral↔durable ever flips. Independent of status; updates never
   * touch this field implicitly. Idempotent (same value → recorded no-op),
   * audited via the existing history/audit trail, and a reason is required
   * for an actual change so the flip stays reviewable.
   */
  function setPersistence(hypothesisId, persistence, { reason } = {}) {
    const h = byId.get(hypothesisId);
    if (!h) return { ok: false, reason: `unknown hypothesis: ${hypothesisId}` };
    if (!isValidPersistence(persistence)) {
      audits.push(makeAudit({ hypothesisId: h.id, relation: 'persistence', accepted: false, reason: `invalid persistence: ${persistence}` }));
      return { ok: false, reason: `invalid persistence: ${persistence} (use ephemeral|durable)` };
    }
    if (h.persistence === persistence) {
      audits.push(makeAudit({
        hypothesisId: h.id, relation: 'persistence', accepted: true,
        from: h.persistence, to: persistence, reason: 'unchanged', rationale: reason || null,
      }));
      return { ok: true, changed: false };
    }
    if (!reason || !String(reason).trim()) {
      return { ok: false, reason: 'a persistence change requires a stated reason' };
    }
    const prev = { ...h };
    const iso = now().toISOString();
    const from = h.persistence;
    h.persistence = persistence;
    h.updatedAt = iso;
    h.history.push({ from: prev.status, to: prev.status, at: iso, rationale: reason || null, persistenceFrom: from, persistenceTo: persistence });
    persistUpdate(prev, h);
    audits.push(makeAudit({
      hypothesisId: h.id, relation: 'persistence',
      from, to: persistence,
      confidenceBefore: prev.confidence, confidenceAfter: h.confidence,
      rationale: reason || null,
    }));
    return { ok: true, changed: true };
  }

  return {
    propose,
    applyUpdate,
    applyReasoningResult,
    evaluateTransition,
    setPersistence,
    seed: (list) => seedAll(list),
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
  HYPOTHESIS_METHODS,
  HYPOTHESIS_PERSISTENCE,
  DEFAULT_PERSISTENCE,
  DEFAULT_POLICY,
  INITIAL_STATUS,
  DEDUP_SIMILARITY_THRESHOLD,
  similarity,
  normalizeStatement,
};
