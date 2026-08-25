'use strict';

/**
 * Pattern Awareness 0.1 — consumption policy for patterns that already
 * exist. This module is NOT pattern formation (PatternManager / ReasonIQ
 * 0.4 owns that) and NOT persistence (hindsightPatternAdapter owns that).
 * It is the pure, model-free policy layer between "Hindsight recalled a
 * pattern" and "the Decision Engine decided what — if anything — Gaia does
 * with it":
 *
 *   Hindsight recallPatterns()     (retrieval — turn.js, gated, cheap)
 *        ↓ raw candidates [{...pattern, relevance}]
 *   evaluatePatternUsage()         (THIS file — filter → rank → decide)
 *        ↓ decision.patternUsage
 *   renderPatternContextBlock()    (THIS file — Response Engine guidance)
 *
 * Three hard invariants live here:
 *
 *   1. relevance != confidence. `relevance` is Hindsight's retrieval score
 *      for the current query (how well a stored pattern MATCHES this turn);
 *      `confidence` is the pattern's persisted Gaia confidence (how much
 *      Gaia believes the pattern at all). They never substitute for each
 *      other — a perfectly-matching candidate is still just a candidate.
 *   2. A pattern is a derived interpretation (knowledgeType: 'pattern'),
 *      never a user fact. Downstream it is rendered/voiced as an
 *      observation ("Ik krijg de indruk dat je…"), never as fact ("Jij
 *      bent iemand die…").
 *   3. Patterns are never automatically user-facing. The ONLY path to a
 *      user-visible mention is the Decision Engine explicitly selecting
 *      mode 'mention_as_observation' — and mention carries strictly higher
 *      bars than silent context (established status + high confidence +
 *      high relevance), plus its own per-turn budget and suppression rules.
 *
 * The default posture is deliberately conservative (ReasonIQ 0.4's own
 * false-positives-are-worse rule carries over): candidate patterns default
 * to ignore; only supported/established patterns become silent context at
 * all; every threshold below is documented next to its number.
 *
 * Boundary: PURE module — no I/O, no Hindsight client, no PatternManager,
 * no LLM. Retrieval happens upstream (turn.js through the existing adapter);
 * expression happens downstream (Response Engine). This file only judges.
 */

const { isTrivial, MEMORY_POLICY } = require('../memoryPolicy');

/**
 * Documented thresholds — all overridable via the injected `policy`
 * (the same constructor-injection style as PatternManager/HypothesisManager).
 */
const DEFAULT_PATTERN_AWARENESS_POLICY = Object.freeze({
  /** Confidence floor for ANY use (context or mention). Mirrors
   *  PatternManager's supportedConfidence: below 0.6 a pattern has not
   *  earned even silent contextual weight. */
  minConfidence: 0.6,
  /** Statuses eligible for SILENT context injection. Candidates are
   *  excluded by default (§12 — safer); widening this is a future explicit
   *  decision, not a threshold tweak. */
  contextEligibleStatuses: Object.freeze(['supported', 'established']),
  /** Retrieval relevance needed before a pattern becomes context at all
   *  (Hindsight scores.final; below this the match is too weak to trust). */
  minRelevanceForContext: 0.55,
  /** Statuses eligible for explicit mentioning. Only established patterns
   *  may ever be voiced (§8: established + high relevance → mention
   *  mogelijk; supported + high relevance → use_as_context only). */
  mentionEligibleStatuses: Object.freeze(['established']),
  /** Confidence floor for mentioning — aligned with PatternManager's
   *  establishedConfidence so "voiced" and "established" mean the same
   *  strength of belief. */
  minConfidenceForMention: 0.78,
  /** Retrieval relevance needed before mentioning is even considered —
   *  meaningfully above the context floor: voicing costs trust, silence
   *  does not. */
  minRelevanceForMention: 0.75,
  /** Max patterns folded into one turn's context — prevents context
   *  overload when several patterns recall at once (§19 Multiple). */
  maxPatternsAsContext: 2,
  /** Max patterns voiced per turn — one observation, never a lecture. */
  maxMentionsPerTurn: 1,
  /** Token overlap between pattern statement and current turn above which
   *  the pattern counts as RESTATING what the turn already expresses —
   *  mentioning it would add nothing new (§18). Overlap denominator is the
   *  SMALLER token set, so near-total coverage of either side suppresses. */
  restatementOverlapForMentionSuppression: 0.8,
  /** Relevance required to mention a pattern touching a sensitive topic
   *  (§18 conservative guard — not a safety engine, just a higher bar;
   *  such patterns still work fine as silent context). */
  sensitiveTopicRelevanceForMention: 0.85,
});

/**
 * Topics where an unsolicited observation about the user could land badly.
 * Deliberately tiny and explicit — an input to the mention gate only.
 */
const SENSITIVE_TOPIC_TOKENS = new Set([
  'gezondheid', 'health', 'ziek', 'illness', 'slaap', 'sleep', 'depressie',
  'angst', 'anxiety', 'relatie', 'relationship', 'relaties', 'geld',
  'money', 'schuld', 'debt', 'eenzaam', 'alone',
]);

// IntentIQ intents describing turns about Gaia herself or pure social
// ritual — no user topic exists for a pattern to be relevant TO (§4 gate).
const NON_TOPICAL_INTENTS = new Set([
  'greet', 'farewell', 'acknowledge',
  'meta.question', 'meta.correction', 'meta.capability_question',
]);

function clamp01(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

function contentTokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 3);
}

/**
 * Cheap pre-retrieval gate (§4): a plain conversational turn must never
 * trigger pattern analysis. Uses only existing signals — the same filler/
 * length vocabulary as memory recall (memoryPolicy.isTrivial) plus
 * IntentIQ's own classification. One scoped Hindsight call on a topical
 * turn is the entire cost when the gate opens.
 * @param {string} userText
 * @param {object|null|undefined} intentDecision - IntentIQ's IntentDecision
 * @returns {boolean}
 */
function shouldAttemptPatternRetrieval(userText, intentDecision) {
  const text = String(userText || '');
  if (!text.trim()) return false;
  // Same trivial-turn floor as memory recall ("Hoi Gaia" never recalls).
  if (isTrivial(text, MEMORY_POLICY.minRecallLength)) return false;

  if (!intentDecision) return true; // no IntentIQ ran — the text check is all we have

  const intent = intentDecision.intent;
  if (intent && NON_TOPICAL_INTENTS.has(intent)) return false;

  // An unresolved turn with neither a source nor any extracted entity has
  // no topic for a pattern to be relevant to.
  if (!intent
    && intentDecision.status === 'unknown'
    && !(Array.isArray(intentDecision.entities) && intentDecision.entities.length > 0)
    && (!intentDecision.sourceOfTruth || intentDecision.sourceOfTruth === 'unknown')) {
    return false;
  }
  return true;
}

/** Restatement guard (§18): overlap over the smaller token set. */
function restatementOverlap(statement, userInput) {
  const a = new Set(contentTokens(statement));
  const b = new Set(contentTokens(userInput));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

function touchesSensitiveTopic(statement) {
  const tokens = String(statement || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  return tokens.some((t) => SENSITIVE_TOPIC_TOKENS.has(t));
}

/** Epistemic label for rendering — never a claim of certainty (soul.md). */
function certaintyLabel(confidence) {
  if (!(typeof confidence === 'number') || confidence < 0.6) return 'low';
  return confidence >= 0.78 ? 'high' : 'moderate';
}

/**
 * Normalizes one recalled candidate into the shape the policy consumes:
 * { id, statement, status, confidence, hypothesisIds, persistence,
 *   sourceRef, knowledgeType: 'pattern', relevance }. Uses the existing
 * persisted representation as-is; corrupt entries are dropped, never
 * fabricated. `relevance` defaults to 0 so an unscored recall can never
 * pass a relevance floor by accident.
 * @param {*} raw
 * @returns {object|null}
 */
function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const statement = typeof raw.statement === 'string' ? raw.statement : '';
  if (!statement.trim()) return null;
  const confidence = clamp01(raw.confidence);
  const relevance = clamp01(raw.relevance);
  return {
    id: String(raw.id),
    statement,
    status: typeof raw.status === 'string' ? raw.status : 'candidate',
    confidence: confidence == null ? 0 : confidence,
    hypothesisIds: Array.isArray(raw.hypothesisIds) ? raw.hypothesisIds.map(String) : [],
    persistence: raw.persistence === 'ephemeral' ? 'ephemeral' : 'durable',
    sourceRef: raw.sourceRef != null ? String(raw.sourceRef) : null,
    knowledgeType: 'pattern',
    relevance: relevance == null ? 0 : relevance,
  };
}

/**
 * The Pattern Awareness judgment for ONE normalized candidate:
 * { action: 'ignore'|'use_as_context'|'mention_as_observation', reason }.
 * Pure policy — every number comes from DEFAULT_PATTERN_AWARENESS_POLICY.
 * @param {object} c normalized candidate
 * @param {{ userInput?: string, mentionsBudgetLeft?: number, policy?: object }} [ctx]
 */
function decidePatternAction(c, { userInput = '', mentionsBudgetLeft = 0, policy } = {}) {
  const p = policy || DEFAULT_PATTERN_AWARENESS_POLICY;

  if (!p.contextEligibleStatuses.includes(c.status)) {
    return { action: 'ignore', reason: `status "${c.status}" is not eligible for pattern awareness 0.1` };
  }
  if (c.confidence < p.minConfidence) {
    return { action: 'ignore', reason: `confidence ${c.confidence} below floor ${p.minConfidence}` };
  }
  if (c.relevance < p.minRelevanceForContext) {
    return { action: 'ignore', reason: `relevance ${c.relevance} below context floor ${p.minRelevanceForContext}` };
  }

  const mentionAllowed = p.mentionEligibleStatuses.includes(c.status)
    && c.confidence >= p.minConfidenceForMention
    && c.relevance >= p.minRelevanceForMention
    && mentionsBudgetLeft > 0;

  if (mentionAllowed && restatementOverlap(c.statement, userInput) >= p.restatementOverlapForMentionSuppression) {
    return { action: 'use_as_context', reason: 'mention suppressed: pattern restates what this turn already expresses' };
  }
  if (mentionAllowed && touchesSensitiveTopic(c.statement)
    && c.relevance < p.sensitiveTopicRelevanceForMention) {
    return { action: 'use_as_context', reason: 'mention suppressed: sensitive topic without clearly high relevance' };
  }
  if (mentionAllowed) {
    return { action: 'mention_as_observation', reason: `established pattern with clearly high relevance (${c.relevance}) earns a tentative observation` };
  }
  return { action: 'use_as_context', reason: `relevant enough for quiet context (${c.relevance})` };
}

module.exports = {
  DEFAULT_PATTERN_AWARENESS_POLICY,
  SENSITIVE_TOPIC_TOKENS,
  NON_TOPICAL_INTENTS,
  shouldAttemptPatternRetrieval,
  restatementOverlap,
  certaintyLabel,
  normalizeCandidate,
  decidePatternAction,
};

// --- batch evaluation (the Decision Engine's entry point) -------------------

/**
 * Filters, ranks and decides a whole recall batch. Ranking is relevance
 * desc, then confidence desc; context is capped (maxPatternsAsContext) and
 * mentions are budgeted (maxMentionsPerTurn) so multiple relevant patterns
 * can never flood either the prompt or the reply.
 *
 * @param {Array<object>|null|undefined} candidates raw recalled candidates
 * @param {{ userInput?: string, policy?: Partial<DEFAULT_POLICY_SHAPE> }} [options]
 * @returns {{
 *   mode: 'ignore'|'use_as_context'|'mention_as_observation',
 *   patterns: string[],
 *   contextPatternIds: string[],
 *   mentions: Array<{ patternId: string, phrasing: 'tentative' }>,
 *   decisions: Array<{ patternId: string, action: string, reason: string }>,
 *   candidatesById: Map<string, object>,
 * }|null}
 *   null when there were no usable candidates at all — no patternUsage is
 *   attached to the Decision (absent means "patterns played no part").
 */
function evaluatePatternUsage(candidates, options = {}) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map(normalizeCandidate)
    .filter(Boolean);
  if (list.length === 0) return null;

  const policy = { ...DEFAULT_PATTERN_AWARENESS_POLICY, ...(options.policy || {}) };
  const ranked = [...list].sort((a, b) =>
    (b.relevance - a.relevance) || (b.confidence - a.confidence)
  );
  const candidatesById = new Map(list.map((c) => [c.id, c]));

  const decisions = [];
  const contextIds = [];
  const mentions = [];

  for (const c of ranked) {
    const verdict = decidePatternAction(c, {
      userInput: options.userInput,
      mentionsBudgetLeft: policy.maxMentionsPerTurn - mentions.length,
      policy,
    });
    if (verdict.action === 'mention_as_observation') {
      mentions.push({ patternId: c.id, phrasing: 'tentative' });
      decisions.push({ patternId: c.id, ...verdict });
      continue;
    }
    if (verdict.action === 'use_as_context') {
      if (contextIds.length < policy.maxPatternsAsContext) {
        contextIds.push(c.id);
        decisions.push({ patternId: c.id, ...verdict });
      } else {
        decisions.push({
          patternId: c.id,
          action: 'ignore',
          reason: `context budget reached (${policy.maxPatternsAsContext})`,
        });
      }
      continue;
    }
    decisions.push({ patternId: c.id, ...verdict });
  }

  const mode = mentions.length > 0
    ? 'mention_as_observation'
    : (contextIds.length > 0 ? 'use_as_context' : 'ignore');

  return {
    mode,
    // `patterns` mirrors the strongest usage (§15): the mentioned id(s)
    // when mentioning, else the silently-used ids. Full detail stays in
    // contextPatternIds/mentions — additive fields the Orchestrator never
    // reads.
    patterns: mode === 'mention_as_observation' ? mentions.map((m) => m.patternId) : [...contextIds],
    contextPatternIds: contextIds,
    mentions,
    decisions,
    candidatesById,
  };
}

// --- Response Engine guidance ------------------------------------------------

/**
 * Renders the guidance block for patterns the Decision Engine actually
 * chose to use. Returns null for ignore/empty usage — nothing pattern-
 * shaped may reach the prompt otherwise (invariant 3). Framing enforces
 * the semantic boundary (§11/§13): derived observations held with explicit
 * uncertainty, categorically distinct from memory facts, never to be
 * stated as facts about the user.
 * @param {object|null|undefined} usage decision.patternUsage
 * @param {Map<string, object>|null|undefined} candidatesById from evaluatePatternUsage
 * @returns {string|null}
 */
function renderPatternContextBlock(usage, candidatesById) {
  if (!usage || usage.mode === 'ignore') return null;
  const lines = [];

  if (Array.isArray(usage.contextPatternIds) && usage.contextPatternIds.length > 0) {
    lines.push(
      'Derived patterns (knowledgeType: pattern — interpretations Gaia formed over time,',
      'NOT confirmed facts about Bo). Hold them as background possibility; let them inform',
      'your answer quietly if they genuinely apply. Never state them as fact, never present',
      'them as proven, never announce that you consulted them.',
      ''
    );
    for (const id of usage.contextPatternIds) {
      const c = candidatesById && candidatesById.get(id);
      if (!c) continue;
      lines.push(`- (certainty: ${certaintyLabel(c.confidence)}) ${c.statement}`);
    }
    lines.push('');
  }

  if (usage.mode === 'mention_as_observation' && Array.isArray(usage.mentions)) {
    lines.push(
      'You may voice the observation below ONCE, if it fits naturally — phrased as a',
      'tentative impression you are noticing ("Ik krijg de indruk dat je..." / "I get the',
      'sense that you..."), NEVER as a statement of fact ("Jij bent iemand die..." / "You',
      'are someone who..."). If it does not fit the moment, leave it out entirely.',
      ''
    );
    for (const m of usage.mentions) {
      const c = candidatesById && candidatesById.get(m.patternId);
      if (!c) continue;
      lines.push(`- (pattern ${c.id} · certainty: ${certaintyLabel(c.confidence)}) ${c.statement}`);
    }
  }

  const body = lines.join('\n').trim();
  return body.length > 0 ? body : null;
}

// --- observability ------------------------------------------------------------

/**
 * Emits the Pattern Awareness log line (§21): candidate count plus one
 * entry per judged pattern with relevance/confidence/status/usage/reason.
 * Pattern ids and scores only — never user content, never statements.
 * Never allowed to affect the turn.
 * @param {Array<object>} recalledCandidates raw recall batch (pre-filtering)
 * @param {{ mode?: string, decisions?: Array<{ patternId: string, action: string, reason: string }> }|null} usage
 * @param {(line: string) => void} [logger] defaults to console.log
 */
function logPatternAwareness(recalledCandidates, usage, logger) {
  try {
    const byId = new Map((Array.isArray(recalledCandidates) ? recalledCandidates : [])
      .filter((c) => c && c.id != null)
      .map((c) => [String(c.id), c]));
    const decisions = (usage && Array.isArray(usage.decisions)) ? usage.decisions : [];
    const line = JSON.stringify({
      kind: 'pattern.awareness',
      candidates: Array.isArray(recalledCandidates) ? recalledCandidates.length : 0,
      selected: decisions.map((d) => {
        const c = byId.get(String(d.patternId));
        return {
          patternId: d.patternId,
          relevance: c ? (c.relevance != null ? c.relevance : null) : null,
          confidence: c ? (c.confidence != null ? c.confidence : null) : null,
          status: c ? (c.status || null) : null,
          usage: d.action,
          reason: d.reason,
        };
      }),
      mode: usage ? usage.mode : 'none',
    });
    if (logger) logger(line);
    else console.log(line);
  } catch (_) {
    // Observability must never take down a real conversational turn.
  }
}

module.exports.evaluatePatternUsage = evaluatePatternUsage;
module.exports.renderPatternContextBlock = renderPatternContextBlock;
module.exports.logPatternAwareness = logPatternAwareness;
