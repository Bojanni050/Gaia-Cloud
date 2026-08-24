#!/usr/bin/env node
'use strict';

/**
 * IntentIQ 2.3 — offline evaluation runner.
 *
 * Usage: node eval/evaluationRunner.js [--mock] [--json] [--dataset <path>]
 * (or: npm run eval:intent-eval)
 *
 * Runs eval/intent-eval.json against the CURRENT classifier and reports,
 * per the 2.3 brief: accuracy, a real expected-x-predicted confusion
 * matrix, confidence calibration (bands + over/underconfidence),
 * semantic-call efficiency, heuristic/semantic conflicts, and
 * reference-resolution statistics — plus deterministic recommendations
 * that are printed for humans and applied by no one.
 *
 * Semantic tier handling (deliberate, honest):
 *   - default: heuristic-only, like the existing eval/run.js harness.
 *     Semantic metrics are reported as N/A, never simulated.
 *   - --mock: injects a tiny DETERMINISTIC fixture model (mockSemanticModel,
 *     below) so the cascade condition, consensus paths, and semantic-value /
 *     reference-resolution machinery are exercised reproducibly. It is a
 *     fixture, exactly like reasoningModelStub.js is for ReasonIQ — its
 *     numbers say "the pipeline behaves sanely", never "the semantic model
 *     is good". A real configured GAIA_INTENT_BASE_URL model can be passed
 *     programmatically via runEvaluation(dataset, { model }).
 *
 * This runner changes nothing: it observes, reports, and exits.
 */

const fs = require('fs');
const path = require('path');
const { classify, interpret } = require('../src/logos/intentIQ');
const {
  calibration,
  detectOverconfidence,
  detectUnderconfidence,
  semanticEfficiency,
  conflictStats,
  referenceStats,
  buildRecommendations,
  metrics,
  sample,
} = require('../src/logos/intentFeedbackAnalyzer');
const { RUNTIME_CONSTANTS, CONFIDENCE_BANDS, LOW_REFERENT_CONFIDENCE } = require('../src/logos/intentCalibrationConfig');

const DEFAULT_DATASET = path.join(__dirname, 'intent-eval.json');

/**
 * Deterministic stand-in for the semantic classifier. Keyed on stable
 * input substrings — a FIXTURE, not intelligence. Anything unmatched gets
 * an explicit "no opinion" (intent null), which combineConsensus treats as
 * "heuristic stands unchanged", mirroring a degraded/uninformative call.
 */
function mockSemanticModel(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('nba draft')) {
    return { intent: 'converse', confidence: 0.82, sourceOfTruth: 'conversation', speechAct: 'assert', referents: [], ambiguous: false };
  }
  if (t.includes("schedule looking")) {
    return { intent: 'inform.explain', confidence: 0.78, sourceOfTruth: 'conversation', speechAct: 'question', referents: [], ambiguous: false };
  }
  if (t.includes('analyseur') || t.includes('analyseer deze flow')) {
    return {
      intent: 'inform.explain',
      confidence: 0.74,
      sourceOfTruth: 'conversation',
      speechAct: 'request',
      referents: [{ expression: 'deze flow', resolvedTo: 'de authentication-flow uit de vorige beurt', confidence: 0.81 }],
      ambiguous: false,
    };
  }
  if (/^(en |and )?(deze|die|dit|dat|this|that)\b/.test(t)) {
    // Follow-ups: confirm the inherited intent with moderate confidence —
    // enough to exercise the agreement path without inventing knowledge.
    return { intent: null, confidence: 0, sourceOfTruth: 'unknown', speechAct: null, referents: [], ambiguous: false, reason: 'fixture_no_opinion' };
  }
  return { intent: null, confidence: 0, sourceOfTruth: 'unknown', speechAct: null, referents: [], ambiguous: false, reason: 'fixture_no_opinion' };
}

function loadDataset(datasetPath) {
  const raw = fs.readFileSync(datasetPath || DEFAULT_DATASET, 'utf-8');
  const dataset = JSON.parse(raw);
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new Error(`evaluation dataset at ${datasetPath || DEFAULT_DATASET} has no cases`);
  }
  return dataset;
}

function acceptableIntents(testCase) {
  return [testCase.expectedIntent, ...(testCase.acceptableAlternatives || [])].filter(Boolean);
}

function expectedKey(testCase) {
  if (testCase.expectUnknown) return 'unknown';
  if (testCase.expectAmbiguous) return 'ambiguous';
  return testCase.expectedIntent;
}

function observedKey(decision) {
  return decision.status === 'accepted' ? decision.intent : decision.status;
}

/**
 * Runs one case through BOTH tiers (classify for heuristic-tier telemetry
 * like needsSemanticCheck/matchedSignals, interpret for the final
 * cascaded decision) and grades it. Never throws on weird input; grading
 * failures are mismatches with a reason, like eval/harness.js.
 */
async function evaluateCase(testCase, options = {}) {
  const messages = [
    ...(Array.isArray(testCase.context) ? testCase.context : []),
    { role: 'user', content: testCase.input },
  ];
  const inputOptions = { silent: true };
  if (Object.prototype.hasOwnProperty.call(testCase, 'hasAttachment')) {
    inputOptions.hasAttachment = testCase.hasAttachment;
  }
  const heuristic = classify(messages, inputOptions);

  let logged = null;
  const decision = await interpret(messages, {
    ...inputOptions,
    model: options.model,
    silent: false,
    logger: (line) => { logged = line; },
  });
  let loggedRecord = null;
  try {
    loggedRecord = logged ? JSON.parse(logged) : null;
  } catch (_) {
    loggedRecord = null;
  }
  const tiers = loggedRecord ? loggedRecord.tiers : null;

  const expected = expectedKey(testCase);
  const observed = observedKey(decision);
  let outcome;
  let why = '';
  if (expected === 'unknown') {
    outcome = decision.status === 'unknown' ? 'match' : 'mismatch';
    if (outcome === 'mismatch') why = `expected unknown, got ${decision.status}/${decision.intent}`;
  } else if (expected === 'ambiguous') {
    outcome = decision.status === 'ambiguous' ? 'match' : 'mismatch';
    if (outcome === 'mismatch') why = `expected ambiguous, got ${decision.status}/${decision.intent}`;
  } else {
    const ok = decision.status === 'accepted' && acceptableIntents(testCase).includes(decision.intent);
    outcome = ok ? 'match' : 'mismatch';
    if (!ok) why = `expected one of [${acceptableIntents(testCase).join(', ')}], got ${decision.status}/${decision.intent}`;
  }

  const heuristicIntent = (tiers && tiers.heuristic && tiers.heuristic.intent)
    || (heuristic.candidates[0] && heuristic.candidates[0].intent)
    || null;

  return {
    id: testCase.id,
    category: testCase.category || 'uncategorized',
    input: testCase.input,
    notes: testCase.notes || '',
    expected,
    observed,
    outcome,
    why,
    sourceOfTruthExpected: testCase.expectedSourceOfTruth || null,
    sourceOfTruthObserved: decision.sourceOfTruth || null,
    needsSemanticCheckExpected: Object.prototype.hasOwnProperty.call(testCase, 'expectedNeedsSemanticCheck')
      ? Boolean(testCase.expectedNeedsSemanticCheck)
      : null,
    needsSemanticCheckHeuristic: heuristic.needsSemanticCheck,
    decision,
    heuristic,
    // Analyzer turn shape (brief §7/§9 inputs).
    turn: {
      finalIntent: decision.intent,
      status: decision.status,
      confidence: decision.confidence,
      ambiguous: Boolean(decision.ambiguous),
      interpretationStatus: decision.interpretationStatus || null,
      semanticCalled: Boolean(loggedRecord && loggedRecord.semanticCalled),
      heuristicIntent,
      heuristicConfidence: heuristic.status === 'accepted'
        ? heuristic.confidence
        : (heuristic.candidates[0] ? heuristic.candidates[0].score : null),
      semanticIntent: (tiers && tiers.semantic && tiers.semantic.intent) || null,
      referents: Array.isArray(decision.referents) ? decision.referents : [],
      matchedSignals: ((heuristic.meta && heuristic.meta.matchedSignals) || []),
    },
  };
}

/** Labeled calibration/miscalibration samples from resolved-intent cases only. */
function samplesFromResults(results) {
  return results
    .filter((r) => r.expected !== 'unknown' && r.expected !== 'ambiguous' && r.decision.confidence > 0)
    .map((r) => sample(r.decision.intent, r.decision.confidence, r.outcome === 'match', r.expected));
}

function topConfusedPairs(confusion, limit = 3) {
  const pairs = [];
  for (const [expectedRow, row] of Object.entries(confusion)) {
    for (const [observedCol, n] of Object.entries(row)) {
      if (expectedRow !== observedCol && n > 0) pairs.push({ pair: `${expectedRow} <-> ${observedCol}`, count: n });
    }
  }
  return pairs.sort((a, b) => b.count - a.count).slice(0, limit).map((p) => p.pair);
}

function buildReport(results, extra = {}) {
  const total = results.length;
  const matches = results.filter((r) => r.outcome === 'match').length;
  const unknownCount = results.filter((r) => r.decision.status === 'unknown').length;
  const ambiguousCount = results.filter((r) => r.decision.status === 'ambiguous').length;

  const confusion = {};
  for (const r of results) {
    confusion[r.expected] = confusion[r.expected] || {};
    confusion[r.expected][r.observed] = (confusion[r.expected][r.observed] || 0) + 1;
  }

  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] = byCategory[r.category] || { total: 0, matches: 0 };
    byCategory[r.category].total += 1;
    if (r.outcome === 'match') byCategory[r.category].matches += 1;
  }
  for (const c of Object.values(byCategory)) c.accuracy = c.total > 0 ? Math.round((c.matches / c.total) * 1000) / 1000 : null;

  const sotChecked = results.filter((r) => r.sourceOfTruthExpected);
  const sotMatches = sotChecked.filter((r) => r.sourceOfTruthObserved === r.sourceOfTruthExpected).length;
  const nscChecked = results.filter((r) => r.needsSemanticCheckExpected != null);
  const nscMatches = nscChecked.filter((r) => r.needsSemanticCheckHeuristic === r.needsSemanticCheckExpected).length;

  const samples = samplesFromResults(results);
  const calibrationReport = calibration(samples);
  const overconfidence = detectOverconfidence(samples);
  const underconfidence = detectUnderconfidence(samples);

  const turns = results.map((r) => r.turn);
  const efficiency = semanticEfficiency(turns);
  const conflicts = conflictStats(turns);
  const references = referenceStats(turns);

  // Failure attribution: cases whose TRUE-intent expectation was missed,
  // projected onto the heuristic signals that fired for the wrong guess.
  const failurePairs = results
    .filter((r) => r.outcome === 'mismatch' && r.observed !== 'unknown' && r.expected !== 'unknown' && r.expected !== 'ambiguous')
    .map((r) => ({
      predictedIntent: r.decision.intent || r.turn.heuristicIntent,
      correctedIntent: r.expected,
      matchedSignals: r.turn.matchedSignals.filter((m) => m.intent === (r.decision.intent || r.turn.heuristicIntent)),
    }));
  const failures = require('../src/logos/intentFeedbackAnalyzer').heuristicFailures(failurePairs);

  const recommendations = buildRecommendations({
    calibrationReport,
    efficiency,
    failures,
    conflicts,
    references,
    overconfidence,
    underconfidence,
  });

  const semanticCallsTotal = efficiency.semanticCalls;
  const namedMetrics = metrics({
    totalTurns: total,
    semanticCalls: semanticCallsTotal,
    semanticChanges: efficiency.changedDecision,
    conflicts: conflicts.conflicts,
    ambiguous: ambiguousCount,
    referenceUnresolved: references.unresolved,
    corrections: results.filter((r) => r.outcome === 'mismatch').length,
    highConfidenceErrors: overconfidence.length,
    lowConfidenceCorrect: underconfidence.length,
  });

  return {
    total,
    matches,
    accuracy: total > 0 ? Math.round((matches / total) * 1000) / 1000 : null,
    unknownRate: total > 0 ? Math.round((unknownCount / total) * 1000) / 1000 : null,
    ambiguousRate: total > 0 ? Math.round((ambiguousCount / total) * 1000) / 1000 : null,
    semanticCallRate: total > 0 ? Math.round((semanticCallsTotal / total) * 1000) / 1000 : null,
    semanticChangedRate: total > 0 ? Math.round((efficiency.changedDecision / total) * 1000) / 1000 : null,
    byCategory,
    confusion,
    mostConfused: topConfusedPairs(confusion),
    calibrationReport,
    overconfidence,
    underconfidence,
    efficiency,
    conflicts,
    references,
    failures,
    recommendations,
    metrics: namedMetrics,
    sourceOfTruthChecks: sotChecked.length > 0
      ? { checked: sotChecked.length, matches: sotMatches, accuracy: Math.round((sotMatches / sotChecked.length) * 1000) / 1000 }
      : null,
    needsSemanticCheckChecks: nscChecked.length > 0
      ? { checked: nscChecked.length, matches: nscMatches, accuracy: Math.round((nscMatches / nscChecked.length) * 1000) / 1000 }
      : null,
    mismatches: results.filter((r) => r.outcome === 'mismatch').map((r) => ({
      id: r.id, category: r.category, input: r.input, expected: r.expected, observed: r.observed, why: r.why,
    })),
    mode: extra.mode || 'heuristic-only',
  };
}

function renderConfusionMatrix(confusion) {
  const rows = Object.keys(confusion).sort();
  const cols = [...new Set(rows.flatMap((r) => Object.keys(confusion[r])))].sort();
  const width = Math.max(12, ...rows.concat(cols).map((s) => s.length)) + 2;
  const head = ''.padEnd(width) + cols.map((c) => c.padEnd(width)).join('');
  const lines = [head];
  for (const r of rows) {
    lines.push(r.padEnd(width) + cols.map((c) => String(confusion[r][c] || 0).padEnd(width)).join(''));
  }
  return lines.join('\n');
}

function formatReport(report) {
  const lines = [];
  const pct = (x) => (x == null ? 'N/A' : `${(Math.round(x * 10000) / 100).toFixed(2)}%`);
  lines.push('IntentIQ Evaluation');
  lines.push('-------------------');
  lines.push(`Mode:                 ${report.mode}`);
  lines.push(`Samples:              ${report.total}`);
  lines.push(`Accuracy:             ${pct(report.accuracy)}`);
  lines.push(`Ambiguous rate:       ${pct(report.ambiguousRate)}`);
  lines.push(`Unknown rate:         ${pct(report.unknownRate)}`);
  lines.push(`Semantic call rate:   ${pct(report.semanticCallRate)}`);
  lines.push(`Semantic changed:     ${pct(report.semanticChangedRate)}`);
  lines.push(`Reference resolution: ${pct(report.references.resolutionRate)}${report.references.total > 0 ? '' : ' (no referents observable)'}`);
  lines.push(`Source-of-truth:      ${report.sourceOfTruthChecks ? `${report.sourceOfTruthChecks.matches}/${report.sourceOfTruthChecks.checked}` : 'not graded'}`);
  lines.push(`needsSemanticCheck:   ${report.needsSemanticCheckChecks ? `${report.needsSemanticCheckChecks.matches}/${report.needsSemanticCheckChecks.checked}` : 'not graded'}`);
  lines.push('');
  lines.push('Confidence calibration:');
  for (const b of report.calibrationReport.bands) {
    lines.push(`  ${b.range.padEnd(10)} samples=${String(b.samples).padEnd(4)} accuracy=${b.accuracy == null ? 'N/A' : pct(b.accuracy)}`);
  }
  lines.push(`  overall                accuracy=${pct(report.calibrationReport.overallAccuracy)}`);
  lines.push('');
  if (report.mostConfused.length) {
    lines.push('Most confused:');
    for (const p of report.mostConfused) lines.push(`  ${p}`);
    lines.push('');
  }
  if (report.failures.length) {
    lines.push('Heuristic failures (signal -> wrong prediction):');
    for (const f of report.failures.slice(0, 5)) {
      lines.push(`  "${f.signal}" ${f.predictedIntent} -> ${f.correctedIntent} x${f.occurrences}`);
    }
    lines.push('');
  }
  if (report.mode !== 'heuristic-only') {
    lines.push('Semantic efficiency:');
    lines.push(`  calls=${report.efficiency.semanticCalls} changed=${report.efficiency.changedDecision} confirmed=${report.efficiency.confirmedHeuristic} (of which reduced-uncertainty=${report.efficiency.confirmedShallowHeuristic}) valueRate=${pct(report.efficiency.semanticValueRate)}`);
    lines.push('Conflicts:');
    lines.push(`  comparisons=${report.conflicts.totalSemanticComparisons} agreements=${report.conflicts.agreements} conflicts=${report.conflicts.conflicts} semanticWins=${report.conflicts.semanticWins} heuristicWins=${report.conflicts.heuristicWins}`);
    lines.push('');
  }
  if (report.recommendations.length) {
    lines.push('Recommendations (for human review — nothing is applied automatically):');
    for (const r of report.recommendations) lines.push(`  - ${r}`);
    lines.push('');
  }
  lines.push('Metrics:');
  for (const [k, v] of Object.entries(report.metrics)) lines.push(`  ${k} = ${v}`);
  lines.push('');
  lines.push('Confusion matrix (rows=expected, cols=observed):');
  lines.push(renderConfusionMatrix(report.confusion));
  if (report.mismatches.length) {
    lines.push('');
    lines.push(`Mismatches (${report.mismatches.length}):`);
    for (const m of report.mismatches) {
      lines.push(`  [${m.id}] (${m.category}) "${m.input}" — ${m.why}${m.notes ? ` {${m.notes}}` : ''}`);
    }
  }
  return lines.join('\n');
}

function printConfig() {
  console.log('Calibration configuration (read-only documentation of live runtime constants):');
  for (const [k, v] of Object.entries(RUNTIME_CONSTANTS)) console.log(`  ${k} = ${v}`);
  console.log(`  confidenceBands = ${CONFIDENCE_BANDS.map((b) => b.range).join(' | ')}`);
  console.log(`  lowReferentConfidence = ${LOW_REFERENT_CONFIDENCE}`);
}

async function runEvaluation(dataset, options = {}) {
  const results = [];
  for (const testCase of dataset.cases) {
    results.push(await evaluateCase(testCase, { model: options.model }));
  }
  return buildReport(results, { mode: options.model ? 'semantic (injected model)' : 'heuristic-only' });
}

async function main(argv = process.argv.slice(2)) {
  const useMock = argv.includes('--mock');
  const asJson = argv.includes('--json');
  const datasetIdx = argv.indexOf('--dataset');
  const datasetPath = datasetIdx >= 0 ? argv[datasetIdx + 1] : null;

  const dataset = loadDataset(datasetPath);

  // The mock is wired per-case: it answers deterministically from that
  // case's own input text, never from the expected outcome.
  const results = [];
  for (const testCase of dataset.cases) {
    const caseModel = useMock
      ? { chat: async () => JSON.stringify(mockSemanticModel(testCase.input)) }
      : undefined;
    results.push(await evaluateCase(testCase, { model: caseModel }));
  }
  const report = buildReport(results, { mode: useMock ? 'semantic (--mock fixture)' : 'heuristic-only' });

  console.log('IntentIQ 2.3 — offline evaluation');
  console.log('(synthetic design/evaluation set, not real user data)');
  printConfig();
  console.log('');
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  return report;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`evaluation failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  loadDataset,
  evaluateCase,
  runEvaluation,
  buildReport,
  formatReport,
  renderConfusionMatrix,
  mockSemanticModel,
  samplesFromResults,
};
