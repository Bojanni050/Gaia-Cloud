'use strict';

/**
 * Hypothesis Manager — ReasonIQ 0.3's controlled hypothesis lifecycle.
 *
 * Boundary: this module MAINTAINS hypothesis state; it never reasons. It
 * consumes already-structured reasoning output (ReasonIQ 0.3's
 * hypothesisUpdates / evidence-linked hypotheses) and turns it into
 * explicit, validated state transitions. It never calls Hindsight, Hermes,
 * any web/MCP capability, or a routing layer; persistence goes through
 * an INJECTED sink ({ save, update }) so Hindsight stays the only place
 * anything ever durably lives (brief §15) — and since hindsightClient has
 * no hypothesis API yet, the default sink is an honest no-op and the
 * manager keeps state in memory for the turn that owns it.
 *
 * Lifecycle (the frozen transitions below mirror the shape documented in
 * logos/logosSchema.js — THIS map is this codebase's single source of
 * truth):
 *
 *   proposed → testing → corroborated → confirmed   (corroborated: machine,
 *            │                                        micro only)
 *            ↘ rejected
 *   proposed    → confirmed   (a person may settle a proposal directly)
 *   corroborated → testing    (a contradiction arrived — same §9 rule as
 *                              confirmed below)
 *   confirmed   → testing     (new contradicting pressure — §9: a confirmed
 *                              hypothesis never silently survives a
 *                              contradiction)
 *   rejected    → testing     ONLY through reopen(), an explicit human action.
 *                              For every automatic process (applyUpdate,
 *                              applyReasoningResult, setPersistence, the
 *                              lifecycle verbs) `rejected` is a hard terminal
 *                              quarantine — no amount of new evidence revives it.
 *
 * Confirming/rejecting is deliberately HARD (§8): an LLM saying "likely"
 * is never enough. Transitions to confirmed/rejected go through
 * evaluateTransition(), which checks the evidence policy below — every
 * threshold is named and documented here, none are magic.
 *
 * `corroborated` is the ONE step a machine may take UP on its own (V3
 * epistemic entrenchment): a `micro` hypothesis — a low-impact preference,
 * style or routine — whose confidence has built past softPromoteConfidence
 * is promoted without a human click. It is not a settlement: the tier may
 * inform retrieval and behaviour but is never presented as settled, and it
 * still takes a person to reach `confirmed` (Absolute Override). `macro`
 * claims (the safe default) never take this road — they always wait for a
 * person. Cognition owns the same tier as `testing → corroborated`.
 *
 * Provenance note (0.3.x): several concepts here are adopted from
 * github.com/alash3al/stash — the four-way evidence verdicts were already
 * borrowed in logos/logosSchema.js; this pass adds its hypothesis-shape
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

const { EVIDENCE_VERDICTS, isValidHypothesisScope } = require('../logos/logosSchema');

/**
 * V3 epistemic entrenchment (micro/macro). `macro` is the safe default: an
 * unclassified hypothesis is one a human must look at, never one a machine
 * silently soft-promotes.
 */
const DEFAULT_SCOPE = 'macro';
function scopeOf(value) {
  return isValidHypothesisScope(value) ? value : DEFAULT_SCOPE;
}

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
 * testing) and unknown → anything. The `corroborated` edges mirror
 * Cognition's own table (services/cognition/src/hypotheses.js).
 */
const HYPOTHESIS_TRANSITIONS = Object.freeze({
  proposed: Object.freeze(['testing', 'rejected', 'expired']),
  testing: Object.freeze(['corroborated', 'confirmed', 'rejected']),
  corroborated: Object.freeze(['confirmed', 'rejected', 'testing']),
  confirmed: Object.freeze(['testing']),
  // Terminal for every automatic path. reopen() is the one deliberate,
  // human-initiated exception (mirrors the Cognition store's /reopen route).
  rejected: Object.freeze([]),
  // v1.3 — a lapse is not a judgement, and deliberately not a quarantine:
  // evidence that arrives later revives an expired statement, and a person may
  // still settle it. Only a `proposed` statement can lapse at all.
  expired: Object.freeze(['testing', 'confirmed', 'rejected']),
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
  /**
   * V3: a hypothesis without a counter-hypothesis can never be confirmed. The
   * anti-lexicographic counter-hypothesis must first exist (or be supplied by
   * a later turn) — absence is honest, and it blocks the human override rather
   * than being fabricated to satisfy it.
   */
  confirmRequiresCounterHypothesis: true,
  /** Distinct opposing items required before reject is possible. */
  minOpposeEvidence: 2,
  /** Confidence at-or-below which reject is possible (with enough oppose evidence). */
  rejectConfidence: 0.35,
  /**
   * V3 soft-promotion: a `micro` hypothesis whose confidence has reached this
   * threshold reaches `corroborated` on its own — the machine tier, never
   * `confirmed`. `macro` (the safe default) always waits for the person.
   */
  softPromoteConfidence: 0.8,
});

/** Statuses always start here when a new hypothesis is proposed. */
const INITIAL_STATUS = 'proposed';

/**
 * The V3 soft-promotion gate, as a pure predicate — the ONE place the rule
 * lives. The manager's `softPromote()` uses it for records it already holds,
 * and the periodic scan (softPromotionScan.js) uses it for records sitting in
 * the store that no turn has touched since (they would otherwise stay in
 * `testing` forever). Deliberately narrow, and every gate is named:
 *
 *   - `micro` scope only. A `macro` claim (the safe default) always waits for
 *     the person, whatever its confidence says.
 *   - `testing` only: the honest path, the same edge the store allows
 *     (`proposed → corroborated` would skip the machine's own work).
 *   - confidence at or above softPromoteConfidence.
 *   - no active contradictions: a claim we have argued against is not
 *     corroborated, whatever its confidence reads.
 *
 * Reaching `corroborated` never means settled, and never `confirmed` — a
 * person still owns the override.
 *
 * Accepts either spelling of the fields (the manager's camelCase records and
 * Cognition's snake_case rows both come through here), and coerces confidence
 * because a Postgres `numeric` arrives as a string.
 *
 * @param {object} h
 * @param {object} [policy] DEFAULT_POLICY by default
 * @returns {boolean}
 */
function isSoftPromotable(h, policy = DEFAULT_POLICY) {
  if (!h || h.scope !== 'micro') return false;
  if (h.status !== 'testing') return false;
  const confidence = Number(h.confidence);
  if (!Number.isFinite(confidence) || confidence < policy.softPromoteConfidence) return false;
  const against = h.evidenceAgainst || h.evidence_against || [];
  return !Array.isArray(against) || against.length === 0;
}

/** How long an evidence-less hypothesis may sit in `proposed` before it lapses. */
const DEFAULT_EXPIRY_DAYS = 14;

/**
 * v1.3 lapse rule — the ONE place that decides whether a statement has expired,
 * shared by the manager and the periodic expiry pass (the same split as
 * isSoftPromotable above): a hypothesis still sitting in `proposed`, with no
 * supporting evidence at all, that nothing has touched for the term lapses.
 *
 * Deliberately narrow. A statement WITH supporting evidence is never expired by
 * this rule — it is under test, which is the ordinary cycle — a low confidence
 * is never a reason on its own, and only hypotheses lapse: open questions and
 * relationships have their own lives and their own policy. Reads camelCase (the
 * manager) and snake_case (a Cognition row) alike.
 */
function isExpirable(h, { days = DEFAULT_EXPIRY_DAYS, now = Date.now() } = {}) {
  if (!h) return false;
  const kind = h.kind || 'hypothesis';
  if (kind !== 'hypothesis') return false;
  if (h.status !== 'proposed') return false;
  if (h.expiredAt || h.expired_at) return false;
  const evidenceFor = h.evidenceFor || h.evidence_for || [];
  if (Array.isArray(evidenceFor) ? evidenceFor.length > 0 : Boolean(evidenceFor)) return false;
  const termDays = Number(days);
  if (!Number.isFinite(termDays) || termDays <= 0) return false;
  const touched = Date.parse(h.updatedAt || h.updated_at || '');
  if (!Number.isFinite(touched)) return false;
  return now - touched >= termDays * 24 * 60 * 60 * 1000;
}

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
  // Per-turn formation: a statement born inside one recall slice. It is off
  // where the belief formation pass runs (server.js), because a claim should
  // rest on repeated ground rather than on one turn's slice. Evidence verdicts
  // on statements that already exist keep flowing either way.
  const formPerTurn = options.formPerTurn !== false;
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

  function persistSave(hyp, context) {
    try {
      if (typeof sink.save === 'function') settleSinkCall(sink.save({ ...hyp }, context));
    } catch (_) { /* persistence must never break reasoning-state upkeep */ }
  }

  function persistUpdate(prev, hyp, context) {
    try {
      if (typeof sink.update === 'function') settleSinkCall(sink.update(hyp.id, { ...hyp }, prev ? { ...prev } : null, context));
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
        status: ['proposed', 'testing', 'corroborated', 'confirmed', 'rejected', 'expired'].includes(h.status) ? h.status : 'testing',
        method: isValidMethod(h.method) ? h.method : 'asserted',
        persistence: persistenceOf(h.persistence),
        counterHypothesis: typeof h.counterHypothesis === 'string' && h.counterHypothesis.trim() ? h.counterHypothesis.trim() : null,
        scope: scopeOf(h.scope),
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
  function propose({ statement, confidence = 0.5, evidenceFor = [], evidenceAgainst = [], method = 'asserted', persistence, counterHypothesis = null, scope, persist = true } = {}) {
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
      counterHypothesis: typeof counterHypothesis === 'string' && counterHypothesis.trim() ? counterHypothesis.trim() : null,
      scope: scopeOf(scope),
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
    const missingCounterHypothesis = policy.confirmRequiresCounterHypothesis
      && !(typeof h.counterHypothesis === 'string' && h.counterHypothesis.trim());
    return h.evidenceFor.length >= policy.minSupportEvidence
      && h.confidence >= policy.confirmConfidence
      && !hasActiveContradiction
      && !missingCounterHypothesis;
  }

  function canReject(h) {
    return h.evidenceAgainst.length >= policy.minOpposeEvidence
      && h.confidence <= policy.rejectConfidence;
  }

  /**
   * V3 soft-promotion — the one automatic step that moves a hypothesis UP
   * without a person. The gate itself lives in isSoftPromotable() above so the
   * periodic scan (softPromotionScan.js) applies the exact same rule to the
   * same records; this is just the transition.
   */
  function softPromote(h) {
    if (!isSoftPromotable(h, policy)) return false;
    const res = transition(
      h,
      'corroborated',
      `soft-promotion: micro hypothesis reached confidence ${h.confidence} >= ${policy.softPromoteConfidence}`,
    );
    return res.ok;
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
        return { ok: false, reason: 'policy: needs more distinct support, higher confidence, no active contradictions, and a counter-hypothesis' };
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
      // The only demotion this reaches is confirmed→testing (§9), which
      // demands a reason. rejected→testing never gets here: the transition
      // table has rejected as terminal — that is reopen()'s human path.
      if (!rationale) return { ok: false, reason: 're-opening requires a rationale' };
    }
    const res = transition(h, target, rationale);
    if (res.ok && target === 'confirmed') {
      promoteConfirmed(h, { ...h }, rationale);
    }
    return res;
  }

  /**
   * The human reopen — the ONLY way out of the rejected quarantine. Every
   * automatic process treats `rejected` as terminal; only this explicit,
   * human-initiated call (the GaiaChat "Heroverwegen" action, mirroring
   * Cognition's POST /reopen) moves it back to testing, and it must state a
   * reason. It deliberately bypasses the transition table the same way
   * supersession does in the store — one named exception, never a general edge.
   */
  function reopen(hypothesisId, { reason } = {}) {
    const h = byId.get(hypothesisId);
    if (!h) return { ok: false, reason: `unknown hypothesis: ${hypothesisId}` };
    if (h.status !== 'rejected') {
      return { ok: false, reason: `only a rejected hypothesis can be reopened (status: ${h.status})` };
    }
    const stated = reason == null ? '' : String(reason).trim();
    if (!stated) return { ok: false, reason: 'reopening a rejected hypothesis requires a stated reason' };

    const prev = { ...h };
    const iso = now().toISOString();
    stampStatus(h, 'rejected', 'testing', iso); // clears rejectionReason, stamps testedAt
    h.status = 'testing';
    h.updatedAt = iso;
    h.history.push({ from: 'rejected', to: 'testing', at: iso, rationale: `reopened by human: ${stated}` });
    persistUpdate(prev, h);
    audits.push(makeAudit({ hypothesisId: h.id, from: 'rejected', to: 'testing', rationale: stated }));
    return { ok: true };
  }

  /**
   * Applies one explicit evidence update (§6). Relation must be one of the
   * four verdicts; irrelevant adjusts nothing but is recorded. A
   * contradiction on a confirmed hypothesis automatically demotes it to
   * testing (§9) — never silently left confirmed.
   */
  function applyUpdate(update = {}, context) {
    const h = update.hypothesisId ? byId.get(update.hypothesisId) : null;
    if (!h) return makeAudit({ accepted: false, reason: `unknown hypothesis: ${update.hypothesisId}` });
    const relation = update.relation;
    if (!EVIDENCE_VERDICTS.includes(relation)) {
      return makeAudit({ hypothesisId: h.id, accepted: false, reason: `invalid relation: ${relation}` });
    }
    // Quarantine: rejected is terminal for automatic evidence. Mirrors
    // Cognition's applyEvidence(), which refuses a rejected record outright —
    // only the human reopen() lifts the quarantine.
    if (h.status === 'rejected') {
      return makeAudit({ hypothesisId: h.id, accepted: false, reason: 'rejected is quarantined; only a human reopen can lift it' });
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

    // §9: contradicting pressure on a SETTLED claim forces it back to testing
    // immediately and explicitly — recorded, never silent. Both settled tiers
    // demote: `confirmed` (the human's) and `corroborated` (the machine's);
    // the store allows both edges.
    if (relation === 'contradicts' && (h.status === 'confirmed' || h.status === 'corroborated')) {
      const settled = h.status;
      stampStatus(h, settled, 'testing', h.updatedAt);
      h.status = 'testing';
      h.history.push({ from: settled, to: 'testing', at: h.updatedAt, rationale: 'contradicting evidence arrived' });
      persistUpdate(prev, h, context);
      audits.push(makeAudit({
        hypothesisId: h.id, from: settled, to: 'testing',
        relation, evidenceId: update.evidenceId || null,
        confidenceBefore: prev.confidence, confidenceAfter: h.confidence,
        rationale: update.rationale || 'contradicting evidence',
      }));
      return audits[audits.length - 1];
    }

    // First real evidence moves a fresh proposal into testing — and revives a
    // statement that had lapsed (v1.3: a lapse is not a judgement, so evidence
    // that arrives later puts it back under test instead of leaving it).
    if ((h.status === 'proposed' || h.status === 'expired') && (relation === 'supports' || relation === 'weakens')) {
      const from = h.status;
      stampStatus(h, from, 'testing', h.updatedAt);
      h.status = 'testing';
      h.history.push({ from, to: 'testing', at: h.updatedAt, rationale: from === 'expired' ? 'evidence arrived after the lapse' : 'first evidence applied' });
    }

    // V3 soft-promotion, after the first-evidence step above so a claim can
    // walk proposed → testing → corroborated within one update. It persists
    // through its own transition(); when it fired, the trailing persist below
    // would only repeat the same diff.
    const promoted = softPromote(h);
    if (!promoted) persistUpdate(prev, h, context);
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
   * @param {{ evidence?: Array<{id: string, source?: string, sourceRef?: string, content?: string}>, observedAt?: string }} [context]
   *   the turn's assembled evidence. Nothing else in the system still knows
   *   what an id like `hindsight-1` pointed at, so it is handed to the sink
   *   here, once, on its way to being stored beside the citation.
   * @returns {{ applied: object[] }} audit records
   */
  function applyReasoningResult(reasoningResult, context = {}) {
    const applied = [];
    const sinkContext = context;
    const allHyps = Array.isArray(reasoningResult && reasoningResult.hypotheses) ? reasoningResult.hypotheses : [];
    // With formation off, the model's proposals are not statements yet: they
    // were derived from this one turn's evidence, and the formation pass is
    // what turns repeated ground into something a person is asked about.
    const resultHyps = formPerTurn ? allHyps : [];
    // What is not made a statement is not thrown away: a one-turn claim with the
    // evidence it stood on IS an observation, and the formation pass decides
    // later whether repeated ground makes it a belief (see sink.observe).
    let observed = 0;
    if (!formPerTurn) {
      for (const rh of allHyps) {
        if (!rh || !rh.statement) continue;
        try {
          if (typeof sink.observe === 'function') settleSinkCall(sink.observe(rh, sinkContext));
          observed += 1;
        } catch (_) { /* persistence must never break reasoning-state upkeep */ }
      }
    }
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
          counterHypothesis: rh.counterHypothesis,
          scope: rh.scope,
          persist: false,
        });
        target = res.hypothesis;
        duplicateOf = res.duplicateOf;
      }
      idFor.set(rh, target);

      // Quarantine: a recognized/existing target that is rejected is never
      // revived by a later turn's reasoning — no evidence merge, no
      // confidence drift, no re-proposal. Only the human reopen() lifts it.
      if (target && target.status === 'rejected') {
        audits.push(makeAudit({
          hypothesisId: target.id, relation: 'rejected-quarantine', accepted: false,
          reason: 'rejected is quarantined; reasoning output cannot revive it',
        }));
        continue;
      }

      // Merge provenance-filtered links (no-op duplicates).
      for (const id of rh.evidenceFor || []) {
        if (!target.evidenceFor.includes(id)) target.evidenceFor.push(id);
      }
      for (const id of rh.evidenceAgainst || []) {
        if (!target.evidenceAgainst.includes(id)) target.evidenceAgainst.push(id);
      }
      const isFresh = rh.existingId == null;
      // V3: a later turn may supply the counter-hypothesis a recognized
      // hypothesis did not yet have. Adopt it, but never overwrite an
      // existing one (the history/audit trail owns that change).
      if (!isFresh && rh.counterHypothesis && !target.counterHypothesis) {
        target.counterHypothesis = rh.counterHypothesis;
      }
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
        if ((target.status === 'proposed' || target.status === 'expired')
          && (target.evidenceFor.length > 0 || target.evidenceAgainst.length > 0)) {
          const from = target.status;
          const iso = now().toISOString();
          stampStatus(target, from, 'testing', iso);
          target.status = 'testing';
          target.updatedAt = iso;
          target.history.push({ from, to: 'testing', at: iso, rationale: from === 'expired' ? 'evidence arrived after the lapse' : 'first evidence linked' });
        }
        // Persist AFTER the merge — v1 carries its provenance and state.
        persistSave(target, sinkContext);
        // V3 soft-promotion: a fresh micro claim that arrived at the
        // threshold with linked evidence may reach the machine tier in this
        // same turn (the sink walks the store testing → corroborated).
        softPromote(target);
      } else if (prevSnapshot && (prevSnapshot.confidence !== target.confidence
        || JSON.stringify(prevSnapshot.evidenceFor) !== JSON.stringify(target.evidenceFor)
        || JSON.stringify(prevSnapshot.evidenceAgainst) !== JSON.stringify(target.evidenceAgainst))) {
        // An EXISTING hypothesis gained links/confidence without an explicit
        // update row — still a persisted-state change.
        persistUpdate(prevSnapshot, target, sinkContext);
        // The same confidence may have crossed the micro threshold without an
        // explicit evidence verdict; the promotion is a state change of its own.
        softPromote(target);
      }
      void duplicateOf;
    }

    const updates = Array.isArray(reasoningResult && reasoningResult.hypothesisUpdates)
      ? reasoningResult.hypothesisUpdates
      : [];
    for (const u of updates) {
      const managedId = u.hypothesisId;
      applied.push(applyUpdate({ ...u, hypothesisId: managedId }, sinkContext));
    }
    return {
      applied,
      // Visible in the decision log without a second lookup: how many claims the
      // model offered that this deployment deliberately did not make, and how
      // many of those were kept as observations instead.
      skippedProposals: formPerTurn ? 0 : observed,
      observed,
    };
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
    // Quarantine: no automatic axis may be changed on a rejected hypothesis.
    if (h.status === 'rejected') {
      return { ok: false, reason: 'a rejected hypothesis is quarantined; reopen it first' };
    }
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
    reopen,
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
  isSoftPromotable,
  isExpirable,
  DEFAULT_EXPIRY_DAYS,
  DEDUP_SIMILARITY_THRESHOLD,
  similarity,
  normalizeStatement,
};
