'use strict';

/**
 * IntentIQ 2.3 — the offline feedback analyzer.
 *
 * A pure analysis layer over the records that IntentIQ already produces at
 * runtime ('intentiq.feedback' records from intentFeedback.js and
 * 'intentiq.decision' records from intentLog.js, both durable JSONL via
 * decisionStore.js). It answers the 2.3 brief's questions — where does
 * IntentIQ misclassify, when is confidence miscalibrated in either
 * direction, is the semantic tier earning its calls, which heuristics fail
 * structurally, which references go unresolved — using simple statistics
 * over those records. Nothing here decides anything at runtime, nothing
 * here writes back into the classifier, and nothing here tunes a
 * threshold: recommendations are produced as plain strings for humans
 * (brief §14), and every actual calibration change stays an explicit,
 * human-reviewed code change (brief §16).
 *
 * All functions are pure: same records in, same report out. The only I/O
 * anywhere near this module is loadRecords(), a thin read over an
 * injected store, kept separate so the analysis core stays trivially
 * testable.
 */

const {
  CONFIDENCE_BANDS,
  LOW_REFERENT_CONFIDENCE,
  UNCERTAINTY_REDUCTION_THRESHOLD,
  bandFor,
} = require('./intentCalibrationConfig');

const OVERCONFIDENCE_THRESHOLD = CONFIDENCE_BANDS[0].min;
const UNDERCONFIDENCE_THRESHOLD = UNCERTAINTY_REDUCTION_THRESHOLD;

function round(n, places = 3) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function rate(part, total) {
  return total > 0 ? round(part / total) : 0;
}

// --- record shapes ----------------------------------------------------------

/**
 * Normalizes anything decision-record-shaped (a live IntentDecision or a
 * logged 'intentiq.decision' line) into the single internal "turn" view
 * every tier/conflict/efficiency analysis below works from.
 */
function turnFromDecision(d) {
  const tiers = d.tiers || {};
  const heuristic = tiers.heuristic || null;
  const semantic = tiers.semantic || null;
  const candidates = Array.isArray(d.candidates) ? d.candidates : [];
  const heuristicOpinion = (heuristic && heuristic.intent)
    || (candidates[0] && candidates[0].intent)
    || null;
  return {
    finalIntent: d.intent != null ? d.intent : null,
    status: d.status || null,
    confidence: typeof d.confidence === 'number' ? d.confidence : null,
    ambiguous: Boolean(d.ambiguous),
    interpretationStatus: d.interpretationStatus || null,
    semanticCalled: Boolean(d.semanticCalled),
    needsSemanticCheck: Boolean(d.needsSemanticCheck),
    referents: Array.isArray(d.referents) ? d.referents.filter(Boolean) : [],
    matchedSignals: ((d.meta && d.meta.matchedSignals) || d.matchedSignals || [])
      .filter((m) => m && m.signal),
    heuristicIntent: heuristicOpinion,
    heuristicConfidence: heuristic && typeof heuristic.confidence === 'number'
      ? heuristic.confidence
      : (candidates[0] && typeof candidates[0].score === 'number' ? candidates[0].score : null),
    semanticIntent: semantic && semantic.intent != null ? semantic.intent : null,
    semanticConfidence: semantic && typeof semantic.confidence === 'number' ? semantic.confidence : null,
  };
}

/** A correctness-labeled sample for calibration/miscalibration analysis. */
function sample(intent, confidence, correct, actualOutcome) {
  return { intent, confidence, correct, actualOutcome };
}

/**
 * Labeled samples derived from feedback records: a feedback with a
 * different `correctedIntent` is an observed error; anything else is
 * treated as an outcome consistent with the original interpretation.
 */
function samplesFromFeedback(feedbacks) {
  return feedbacks.map((fb) => {
    const snap = fb.originalInterpretation || {};
    const intent = fb.originalIntent != null ? fb.originalIntent : null;
    const confidence = typeof fb.originalConfidence === 'number' ? fb.originalConfidence : snap.confidence;
    const corrected = fb.correctedIntent != null && fb.correctedIntent !== intent;
    return sample(
      intent,
      typeof confidence === 'number' ? confidence : null,
      !corrected,
      corrected ? fb.correctedIntent : intent
    );
  }).filter((s) => s.confidence != null);
}

// --- brief §2: the main feedback report -------------------------------------

function bucketStats(items, keyOf) {
  const buckets = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key == null) continue;
    if (!buckets.has(key)) buckets.set(key, { total: 0, corrections: 0 });
    const b = buckets.get(key);
    b.total += 1;
    if (!item.correct) b.corrections += 1;
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .reduce((acc, [key, b]) => {
      acc[key] = { total: b.total, corrections: b.corrections, correctionRate: rate(b.corrections, b.total) };
      return acc;
    }, {});
}

function isCorrected(fb) {
  const intent = fb.originalIntent != null ? fb.originalIntent : null;
  return fb.correctedIntent != null && fb.correctedIntent !== intent;
}

/**
 * @param {Array<object>} feedbacks 'intentiq.feedback' records
 * @param {Array<object>} [decisions] 'intentiq.decision' records (or live decisions) for tier/reference detail
 */
function analyzeFeedback(feedbacks, decisions = []) {
  const labeled = feedbacks.map((fb) => ({
    correct: !isCorrected(fb),
    intent: fb.originalIntent != null ? fb.originalIntent : null,
    confidenceLevel: (fb.originalInterpretation && fb.originalInterpretation.confidenceLevel) || null,
  }));

  const corrections = labeled.filter((l) => !l.correct).length;
  const turns = decisions.map(turnFromDecision);

  const conflicts = turns.filter((t) => t.semanticIntent != null
    && t.heuristicIntent != null
    && t.semanticIntent !== t.heuristicIntent);

  const unresolvedRefs = turns.reduce((n, t) => n + t.referents.filter((r) => r.resolvedTo == null).length, 0);
  const ambiguousCases = turns.length
    ? turns.filter((t) => t.ambiguous).length
    : feedbacks.filter((fb) => fb.originalInterpretation && fb.originalInterpretation.ambiguous).length;

  return {
    totalOutcomes: feedbacks.length,
    corrections,
    correctionRate: rate(corrections, feedbacks.length),
    byIntent: bucketStats(labeled, (l) => l.intent),
    byConfidenceLevel: {
      high: { total: 0, corrections: 0, correctionRate: 0 },
      medium: { total: 0, corrections: 0, correctionRate: 0 },
      low: { total: 0, corrections: 0, correctionRate: 0 },
      ...bucketStats(labeled, (l) => l.confidenceLevel),
    },
    heuristicSemanticConflicts: conflicts.length,
    unresolvedReferences: unresolvedRefs,
    ambiguousCases,
  };
}

// --- brief §4: confidence calibration ---------------------------------------

/**
 * Buckets labeled samples into fixed confidence bands and reports how
 * often each band was actually right. This is the whole calibration story:
 * if "high confidence" doesn't correlate with "usually correct", the
 * thresholds need human review.
 */
function calibration(samples) {
  const usable = samples.filter((s) => typeof s.confidence === 'number');
  const bands = CONFIDENCE_BANDS.map((b) => ({ range: b.range, min: b.min, max: b.max, samples: 0, correct: 0 }));
  for (const s of usable) {
    const band = bandFor(s.confidence);
    const entry = bands.find((x) => x.min === band.min && x.max === band.max);
    entry.samples += 1;
    if (s.correct) entry.correct += 1;
  }
  return {
    totalSamples: usable.length,
    bands: bands.map(({ range, samples: n, correct }) => ({
      range,
      samples: n,
      accuracy: n > 0 ? rate(correct, n) : null,
    })),
    overallAccuracy: usable.length > 0
      ? rate(usable.filter((s) => s.correct).length, usable.length)
      : null,
  };
}

// --- brief §5/§6: over- and underconfidence ---------------------------------

/**
 * Confidently wrong: high reported confidence, observed incorrect outcome.
 */
function detectOverconfidence(samplesList, options = {}) {
  const threshold = typeof options.threshold === 'number' ? options.threshold : OVERCONFIDENCE_THRESHOLD;
  return samplesList
    .filter((s) => s.correct === false && typeof s.confidence === 'number' && s.confidence >= threshold)
    .map((s) => ({
      type: 'overconfidence',
      intent: s.intent != null ? s.intent : null,
      predictedConfidence: s.confidence,
      actualOutcome: s.actualOutcome != null ? s.actualOutcome : null,
    }))
    .sort((a, b) => b.predictedConfidence - a.predictedConfidence);
}

/**
 * Cautiously right: the correct answer was found, but with low reported
 * confidence — IntentIQ being more careful than it needs to be.
 */
function detectUnderconfidence(samplesList, options = {}) {
  const threshold = typeof options.threshold === 'number' ? options.threshold : UNDERCONFIDENCE_THRESHOLD;
  return samplesList
    .filter((s) => s.correct === true && typeof s.confidence === 'number' && s.confidence < threshold)
    .map((s) => ({
      type: 'underconfidence',
      intent: s.intent != null ? s.intent : null,
      predictedConfidence: s.confidence,
      actualOutcome: s.actualOutcome != null ? s.actualOutcome : null,
    }))
    .sort((a, b) => a.predictedConfidence - b.predictedConfidence);
}

// --- brief §7: semantic-call efficiency -------------------------------------

/**
 * Did the semantic tier earn its call?
 *   - changedDecision: the call produced a different top intent than the
 *     heuristic tier's opinion (and the final decision followed it).
 *   - confirmedHeuristic: same top intent — NOT automatically wasted: when
 *     the heuristic itself was shaky (below uncertaintyReductionThreshold)
 *     the call still bought certainty. Those two populations are counted
 *     separately (`confirmedShallowHeuristic`) exactly because they mean
 *     opposite things for later tuning.
 */
function semanticEfficiency(turns) {
  const called = turns.filter((t) => t.semanticCalled);
  let changed = 0;
  let confirmed = 0;
  let confirmedShallowHeuristic = 0;
  let uninformative = 0;
  for (const t of called) {
    if (t.semanticIntent == null) {
      uninformative += 1; // degraded or declined to answer — nothing learned
      continue;
    }
    if (t.heuristicIntent == null) {
      changed += 1; // semantic supplied the only opinion — pure value
      continue;
    }
    if (t.semanticIntent === t.heuristicIntent) {
      confirmed += 1;
      if (typeof t.heuristicConfidence === 'number' && t.heuristicConfidence < UNCERTAINTY_REDUCTION_THRESHOLD) {
        confirmedShallowHeuristic += 1;
      }
    } else if (t.finalIntent === t.semanticIntent || t.finalIntent == null) {
      changed += 1;
    }
  }
  return {
    total: turns.length,
    semanticCalls: called.length,
    changedDecision: changed,
    confirmedHeuristic: confirmed,
    confirmedShallowHeuristic,
    uninformativeCalls: uninformative,
    semanticValueRate: rate(changed, called.length),
  };
}

// --- brief §8: heuristic failure attribution --------------------------------

/**
 * Aggregates observed misclassifications back onto the specific heuristic
 * signals that fired for the wrong prediction. Input pairs come from
 * joining decision records (which carry meta.matchedSignals telemetry)
 * with feedback records on correlationId — see pairsFromJoin() below.
 * Pure aggregation: identifying a problem rule never changes it.
 */
function heuristicFailures(pairs) {
  const tally = new Map();
  for (const p of pairs) {
    if (!p || p.predictedIntent == null || p.correctedIntent == null || p.predictedIntent === p.correctedIntent) continue;
    for (const m of Array.isArray(p.matchedSignals) ? p.matchedSignals : []) {
      if (!m || m.intent !== p.predictedIntent || !m.signal) continue;
      const key = `${m.signal}|${p.predictedIntent}|${p.correctedIntent}`;
      const entry = tally.get(key) || { signal: m.signal, predictedIntent: p.predictedIntent, correctedIntent: p.correctedIntent, occurrences: 0 };
      entry.occurrences += 1;
      tally.set(key, entry);
    }
  }
  return [...tally.values()].sort((a, b) => b.occurrences - a.occurrences
    || a.signal.localeCompare(b.signal));
}

/**
 * Joins decision records with feedback records on correlationId and
 * projects each match into the pair shape heuristicFailures() consumes.
 */
function pairsFromJoin(decisions, feedbacks) {
  const byCorrelation = new Map(decisions.map((d) => [d.correlationId, d]));
  const pairs = [];
  for (const fb of feedbacks) {
    if (!fb.correlationId || !isCorrected(fb)) continue;
    const d = byCorrelation.get(fb.correlationId);
    if (!d) continue;
    const t = turnFromDecision(d);
    pairs.push({
      predictedIntent: t.finalIntent != null ? t.finalIntent : t.heuristicIntent,
      correctedIntent: fb.correctedIntent,
      matchedSignals: t.matchedSignals,
    });
  }
  return pairs;
}

// --- brief §9: heuristic/semantic conflict statistics ------------------------

/**
 * Reports agreement between the two tiers and who wins disagreements,
 * using whatever arbitration already decided (`finalIntent`). Reads the
 * existing consensus behavior; never re-arbitrates.
 */
function conflictStats(turns) {
  let comparisons = 0;
  let agreements = 0;
  let conflicts = 0;
  let semanticWins = 0;
  let heuristicWins = 0;
  for (const t of turns) {
    if (!t.semanticCalled || t.semanticIntent == null || t.heuristicIntent == null) continue;
    comparisons += 1;
    if (t.semanticIntent === t.heuristicIntent) {
      agreements += 1;
    } else {
      conflicts += 1;
      if (t.finalIntent === t.semanticIntent) semanticWins += 1;
      else if (t.finalIntent === t.heuristicIntent) heuristicWins += 1;
    }
  }
  return {
    totalSemanticComparisons: comparisons,
    agreements,
    conflicts,
    semanticWins,
    heuristicWins,
    conflictRate: rate(conflicts, comparisons),
  };
}

// --- brief §10: reference-resolution statistics ------------------------------

function normalizeExpression(expression) {
  return String(expression || '').trim().toLowerCase();
}

/**
 * Statistics over the referents IntentIQ resolved (from the semantic
 * tier). `wronglyCorrected` cannot be measured from these records alone —
 * it needs a human label — so it surfaces only through feedback-driven
 * analyses above; everything countable honestly is counted here.
 */
function referenceStats(decisionsOrTurns) {
  const turns = decisionsOrTurns.map((d) => (d.referents && d.matchedSignals ? d : turnFromDecision(d)));
  let total = 0;
  let resolved = 0;
  let unresolved = 0;
  let lowConfidence = 0;
  const byExpression = new Map();
  for (const t of turns) {
    for (const r of t.referents) {
      if (!r || typeof r.expression !== 'string') continue;
      total += 1;
      const ok = r.resolvedTo != null;
      if (ok) resolved += 1;
      else unresolved += 1;
      if (ok && typeof r.confidence === 'number' && r.confidence < LOW_REFERENT_CONFIDENCE) lowConfidence += 1;
      const key = normalizeExpression(r.expression);
      if (!byExpression.has(key)) byExpression.set(key, { expression: key, total: 0, resolved: 0, unresolved: 0 });
      const b = byExpression.get(key);
      b.total += 1;
      if (ok) b.resolved += 1;
      else b.unresolved += 1;
    }
  }
  return {
    total,
    resolved,
    unresolved,
    lowConfidence,
    resolutionRate: rate(resolved, total),
    byExpression: [...byExpression.values()]
      .sort((a, b) => b.total - a.total || a.expression.localeCompare(b.expression))
      .map((b) => ({ ...b, resolutionRate: rate(b.resolved, b.total) })),
  };
}

// --- brief §14: recommendations (advice only — never applied) ---------------

function formatPct(x) {
  return x == null ? 'N/A' : `${Math.round(x * 10000) / 100}%`;
}

/**
 * Deterministic, human-readable suggestions derived from the reports
 * above. Strings out, nothing else: applying any of these is an explicit
 * code/config change made by a person, never something this module does.
 */
function buildRecommendations(reports = {}) {
  const out = [];
  const { calibrationReport, efficiency, failures, conflicts, references } = reports;

  if (calibrationReport) {
    for (const b of calibrationReport.bands) {
      if (b.samples >= 5 && b.accuracy != null && b.accuracy < 0.85) {
        out.push(`confidence band ${b.range} is overconfident: only ${formatPct(b.accuracy)} accurate across ${b.samples} samples`);
      }
      if (b.samples >= 5 && b.accuracy != null && b.accuracy >= 0.9 && b.range.startsWith('<')) {
        out.push(`low-confidence band ${b.range} is right ${formatPct(b.accuracy)} of the time (${b.samples} samples) — consider whether thresholds are overly cautious`);
      }
    }
  }

  const overByIntent = new Map();
  for (const o of reports.overconfidence || []) {
    overByIntent.set(o.intent, (overByIntent.get(o.intent) || 0) + 1);
  }
  for (const [intent, n] of [...overByIntent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    out.push(`"${intent}" shows ${n} overconfident error(s) at high confidence`);
  }

  const underByIntent = new Map();
  for (const u of reports.underconfidence || []) {
    underByIntent.set(u.intent, (underByIntent.get(u.intent) || 0) + 1);
  }
  for (const [intent, n] of [...underByIntent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    out.push(`"${intent}" is underconfident in ${n} case(s): correct despite low confidence`);
  }

  if (efficiency && efficiency.semanticCalls > 0) {
    out.push(`semantic value rate is ${formatPct(efficiency.semanticValueRate)} (${efficiency.changedDecision}/${efficiency.semanticCalls} calls changed the decision; ${efficiency.confirmedShallowHeuristic} confirmations reduced real uncertainty)`);
  }

  for (const f of (failures || []).slice(0, 3)) {
    if (f.occurrences >= 2) {
      out.push(`heuristic signal "${f.signal}" leads from "${f.predictedIntent}" to "${f.correctedIntent}" ${f.occurrences}x — review this pattern`);
    }
  }

  if (conflicts && conflicts.totalSemanticComparisons > 0 && conflicts.conflicts > 0) {
    out.push(`${conflicts.conflicts}/${conflicts.totalSemanticComparisons} semantic comparisons disagree with the heuristic tier (${conflicts.semanticWins} semantic wins, ${conflicts.heuristicWins} heuristic wins)`);
  }

  for (const r of (references && references.byExpression || []).slice(0, 2)) {
    if (r.total >= 3 && r.resolutionRate < 0.5) {
      out.push(`reference "${r.expression}" resolves only ${formatPct(r.resolutionRate)} of the time (${r.unresolved}/${r.total} unresolved)`);
    }
  }

  return out.slice(0, 10);
}

// --- brief §19: named observability metrics ----------------------------------

function metrics(input = {}) {
  return {
    'intent.total': input.totalTurns || 0,
    'intent.semantic_calls': input.semanticCalls || 0,
    'intent.semantic_changes': input.semanticChanges || 0,
    'intent.heuristic_semantic_conflicts': input.conflicts || 0,
    'intent.ambiguous': input.ambiguous || 0,
    'intent.reference_unresolved': input.referenceUnresolved || 0,
    'intent.corrections': input.corrections || 0,
    'intent.high_confidence_errors': input.highConfidenceErrors || 0,
    'intent.low_confidence_correct': input.lowConfidenceCorrect || 0,
  };
}

// --- the one I/O seam ---------------------------------------------------------

/**
 * Reads both record kinds back out of a decisionStore for offline
 * analysis. Deliberately the ONLY function here that touches a store.
 */
function loadRecords(store, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 500;
  return {
    decisions: store.list({ kind: 'intentiq.decision', limit }),
    feedbacks: store.list({ kind: 'intentiq.feedback', limit }),
  };
}

module.exports = {
  analyzeFeedback,
  calibration,
  detectOverconfidence,
  detectUnderconfidence,
  semanticEfficiency,
  heuristicFailures,
  pairsFromJoin,
  conflictStats,
  referenceStats,
  buildRecommendations,
  metrics,
  loadRecords,
  samplesFromFeedback,
  turnFromDecision,
  sample,
  OVERCONFIDENCE_THRESHOLD,
  UNDERCONFIDENCE_THRESHOLD,
};
