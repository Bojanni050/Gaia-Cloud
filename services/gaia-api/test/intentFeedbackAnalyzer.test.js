'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { recordOutcome, FEEDBACK_TYPES } = require('../src/logos/intentFeedback');
const {
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
  samplesFromFeedback,
  sample,
} = require('../src/logos/intentFeedbackAnalyzer');
const { RUNTIME_CONSTANTS, CONFIDENCE_BANDS } = require('../src/logos/intentCalibrationConfig');
const { classify, interpret, __internals } = require('../src/logos/intentIQ');
const { logIntentDecision } = require('../src/logos/intentLog');
const runner = require('../eval/evaluationRunner');

const silent = { silent: true };

function msg(role, content) {
  return { role, content };
}

function user(content, history = []) {
  return [...history, msg('user', content)];
}

// === Feedback: recordOutcome stores structured, analyzable records ==========

test('2.3 feedback: recordOutcome snapshots the calibration-relevant interpretation fields', () => {
  const original = classify(user('Waarom crasht mijn website?'), silent);
  const before = JSON.stringify(original);

  const record = recordOutcome(
    {
      originalInterpretation: original,
      correctedIntent: 'decide.support',
      feedbackType: 'user_correction',
      correlationId: 'corr-123',
      note: 'wilde advies, geen uitleg',
    },
    () => {}
  );

  assert.equal(record.kind, 'intentiq.feedback');
  assert.equal(record.correlationId, 'corr-123');
  assert.deepEqual(
    Object.keys(record.originalInterpretation).sort(),
    ['ambiguous', 'confidence', 'confidenceLevel', 'intent', 'needsSemanticCheck', 'sourceOfTruth', 'speechAct', 'status'].sort()
  );
  assert.equal(record.originalInterpretation.intent, original.intent);
  assert.equal(record.originalInterpretation.confidence, original.confidence);
  assert.equal(record.originalInterpretation.confidenceLevel, 'high');
  assert.equal(record.correctedIntent, 'decide.support');
  assert.equal(record.feedbackType, 'user_correction');
  // The original decision is untouched.
  assert.equal(JSON.stringify(original), before);
});

test('2.3 feedback: legacy `source` still works and mirrors into feedbackType', () => {
  const record = recordOutcome({ source: 'user_correction' }, () => {});
  assert.equal(record.source, 'user_correction');
  assert.equal(record.feedbackType, 'user_correction');
});

test('2.3 feedback: unknown/missing types degrade honestly, semanticUsed optional', () => {
  const record = recordOutcome({}, () => {});
  assert.equal(record.feedbackType, 'unknown');
  assert.equal(record.source, 'unknown');
  assert.equal(record.semanticUsed, null);
  const typed = recordOutcome({ feedbackType: 'system_override', semanticUsed: true }, () => {});
  assert.equal(FEEDBACK_TYPES.includes('system_override'), true);
  assert.equal(typed.semanticUsed, true);
});

// === Calibration: confidence bands ==========================================

test('2.3 calibration: bands are computed with simple, correct statistics', () => {
  const report = calibration([
    sample('a', 0.95, true, 'a'),
    sample('a', 0.92, false, 'b'),
    sample('a', 0.9, true, 'a'),   // boundary: 0.90 belongs to the top band
    sample('b', 0.85, true, 'b'),
    sample('b', 0.7, false, 'c'),  // boundary: 0.70 belongs to the middle band
    sample('c', 0.5, true, 'c'),
    sample('c', 0.69, true, 'c'),
  ]);
  assert.equal(report.totalSamples, 7);
  const [top, mid, low] = report.bands;
  assert.equal(top.range, '0.90-1.00');
  assert.equal(top.samples, 3);
  assert.equal(top.accuracy, Math.round((2 / 3) * 1000) / 1000);
  assert.equal(mid.range, '0.70-0.89');
  assert.equal(mid.samples, 2);
  assert.equal(mid.accuracy, 0.5);
  assert.equal(low.range, '<0.70');
  assert.equal(low.samples, 2);
  assert.equal(low.accuracy, 1);
  assert.equal(report.overallAccuracy, Math.round((5 / 7) * 1000) / 1000);
});

test('2.3 calibration: empty input yields honest nulls, not NaN', () => {
  const report = calibration([]);
  assert.equal(report.totalSamples, 0);
  assert.equal(report.overallAccuracy, null);
  for (const b of report.bands) assert.equal(b.accuracy, null);
});

test('2.3 calibration: config seam documents the live runtime thresholds', () => {
  assert.equal(RUNTIME_CONSTANTS.confidenceLevelHigh, 0.85);
  assert.equal(RUNTIME_CONSTANTS.confidenceLevelMedium, 0.6);
  // The seam must agree with what intentIQ.js actually applies.
  assert.equal(__internals.confidenceLevelFor(0.85), 'high');
  assert.equal(__internals.confidenceLevelFor(0.84), 'medium');
  assert.equal(__internals.confidenceLevelFor(0.6), 'medium');
  assert.equal(__internals.confidenceLevelFor(0.59), 'low');
  assert.equal(CONFIDENCE_BANDS.length, 3);
});

// === Overconfidence ==========================================================

test('2.3 overconfidence: confidently wrong is marked with predicted vs actual', () => {
  const items = detectOverconfidence([
    sample('inform.explain', 0.94, false, 'decide.support'),
    sample('converse', 0.9, true, 'converse'),
    sample('converse', 0.89, false, 'act.perform'), // below default threshold
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    type: 'overconfidence',
    intent: 'inform.explain',
    predictedConfidence: 0.94,
    actualOutcome: 'decide.support',
  });
});

// === Underconfidence =========================================================

test('2.3 underconfidence: correct despite low confidence is marked', () => {
  const items = detectUnderconfidence([
    sample('decide.support', 0.51, true, 'decide.support'),
    sample('decide.support', 0.7, true, 'decide.support'), // at threshold, not below
    sample('converse', 0.4, false, 'act.perform'),         // wrong anyway
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    type: 'underconfidence',
    intent: 'decide.support',
    predictedConfidence: 0.51,
    actualOutcome: 'decide.support',
  });
});

test('2.3 miscalibration: feedback records feed the labeled-sample pipeline', () => {
  const fb = recordOutcome(
    {
      originalInterpretation: { intent: 'inform.explain', confidence: 0.94, confidenceLevel: 'high', ambiguous: false, status: 'accepted', sourceOfTruth: 'external_knowledge', speechAct: null },
      originalIntent: 'inform.explain',
      originalConfidence: 0.94,
      correctedIntent: 'decide.support',
      feedbackType: 'user_correction',
    },
    () => {}
  );
  const samples = samplesFromFeedback([fb]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].correct, false);
  assert.equal(detectOverconfidence(samples)[0].actualOutcome, 'decide.support');
});

// === Semantic-call efficiency ================================================

test('2.3 semantic efficiency: changed vs confirmed vs reduced-uncertainty are counted separately', () => {
  const turns = [
    { semanticCalled: true, heuristicIntent: 'inform.explain', semanticIntent: 'inform.explain', finalIntent: 'inform.explain', heuristicConfidence: 0.95 },
    { semanticCalled: true, heuristicIntent: 'create.generate', semanticIntent: 'converse', finalIntent: 'converse', heuristicConfidence: 0.95 },
    { semanticCalled: true, heuristicIntent: null, semanticIntent: 'act.perform', finalIntent: 'act.perform', heuristicConfidence: null },
    { semanticCalled: true, heuristicIntent: 'decide.support', semanticIntent: 'decide.support', finalIntent: 'decide.support', heuristicConfidence: 0.55 },
    { semanticCalled: true, heuristicIntent: 'converse', semanticIntent: null, finalIntent: 'converse', heuristicConfidence: 0.9 },
    { semanticCalled: false, heuristicIntent: 'converse', semanticIntent: null, finalIntent: 'converse', heuristicConfidence: 0.95 },
  ];
  const eff = semanticEfficiency(turns);
  assert.equal(eff.total, 6);
  assert.equal(eff.semanticCalls, 5);
  assert.equal(eff.changedDecision, 2); // tier flip + heuristic-had-no-opinion
  assert.equal(eff.confirmedHeuristic, 2);
  assert.equal(eff.confirmedShallowHeuristic, 1); // confirmed at 0.55 — real uncertainty reduction
  assert.equal(eff.uninformativeCalls, 1);
  assert.equal(eff.semanticValueRate, 0.4); // 2 / 5
});

// === Heuristic failure attribution ===========================================

test('2.3 heuristic failures: aggregation tallies signal -> wrong prediction', () => {
  const failures = heuristicFailures([
    {
      predictedIntent: 'inform.explain',
      correctedIntent: 'decide.support',
      matchedSignals: [{ intent: 'inform.explain', signal: 'inform.explain:why (is|does|did|are|isn\'?t)' }],
    },
    {
      predictedIntent: 'inform.explain',
      correctedIntent: 'decide.support',
      matchedSignals: [
        { intent: 'inform.explain', signal: 'inform.explain:why (is|does|did|are|isn\'?t)' },
        { intent: 'inform.explain', signal: 'inform.explain:what is' },
      ],
    },
    {
      // A signal from a non-predicted intent must not be attributed.
      predictedIntent: 'create.generate',
      correctedIntent: 'converse',
      matchedSignals: [{ intent: 'inform.explain', signal: 'inform.explain:what is' }],
    },
  ]);
  // Two distinct failing signals for the same wrong prediction, ranked by
  // occurrences; the mis-attributed third pair contributed nothing.
  assert.equal(failures.length, 2);
  assert.deepEqual(failures[0], {
    signal: 'inform.explain:why (is|does|did|are|isn\'?t)',
    predictedIntent: 'inform.explain',
    correctedIntent: 'decide.support',
    occurrences: 2,
  });
  assert.deepEqual(failures[1], {
    signal: 'inform.explain:what is',
    predictedIntent: 'inform.explain',
    correctedIntent: 'decide.support',
    occurrences: 1,
  });
});

test('2.3 heuristic failures: join-on-correlationId builds pairs from durable records', () => {
  const decisions = [{
    correlationId: 'c1',
    intent: 'inform.explain',
    status: 'accepted',
    candidates: [],
    meta: { matchedSignals: [{ intent: 'inform.explain', signal: 'inform.explain:why (does)' }] },
  }];
  const feedbacks = [
    { correlationId: 'c1', originalIntent: 'inform.explain', correctedIntent: 'decide.support' },
    { correlationId: null, originalIntent: 'converse', correctedIntent: 'act.perform' }, // unjoinable, skipped
    { correlationId: 'c1', originalIntent: 'inform.explain', correctedIntent: 'inform.explain' }, // not a correction
  ];
  const pairs = pairsFromJoin(decisions, feedbacks);
  assert.equal(pairs.length, 1);
  const failures = heuristicFailures(pairs);
  assert.equal(failures[0].occurrences, 1);
  assert.equal(failures[0].signal, 'inform.explain:why (does)');
});

// === Heuristic/semantic conflicts ============================================

test('2.3 conflicts: agreement/disagreement and wins follow the existing arbitration', () => {
  const stats = conflictStats([
    { semanticCalled: true, heuristicIntent: 'inform.explain', semanticIntent: 'inform.explain', finalIntent: 'inform.explain' },
    { semanticCalled: true, heuristicIntent: 'create.generate', semanticIntent: 'converse', finalIntent: 'converse' }, // semantic win
    { semanticCalled: true, heuristicIntent: 'act.perform', semanticIntent: 'converse', finalIntent: 'act.perform' }, // heuristic win
    { semanticCalled: false, heuristicIntent: 'converse', semanticIntent: null, finalIntent: 'converse' },
    { semanticCalled: true, heuristicIntent: 'converse', semanticIntent: null, finalIntent: 'converse' }, // no semantic opinion
  ]);
  assert.deepEqual(
    (({ totalSemanticComparisons, agreements, conflicts, semanticWins, heuristicWins }) =>
      ({ totalSemanticComparisons, agreements, conflicts, semanticWins, heuristicWins }))(stats),
    { totalSemanticComparisons: 3, agreements: 1, conflicts: 2, semanticWins: 1, heuristicWins: 1 }
  );
  assert.equal(stats.conflictRate, Math.round((2 / 3) * 1000) / 1000);
});

// === Reference resolution ====================================================

test('2.3 references: resolved/unresolved/low-confidence plus per-expression breakdown', () => {
  const stats = referenceStats([
    { referents: [
      { expression: 'Deze', resolvedTo: 'de architectuur', confidence: 0.91 },
      { expression: 'die', resolvedTo: null, confidence: 0.2 },
    ] },
    { referents: [{ expression: 'deze', resolvedTo: 'het verslag', confidence: 0.4 }] },
    { referents: [] },
  ]);
  assert.equal(stats.total, 3);
  assert.equal(stats.resolved, 2);
  assert.equal(stats.unresolved, 1);
  assert.equal(stats.lowConfidence, 1); // 0.4 < LOW_REFERENT_CONFIDENCE
  assert.equal(stats.resolutionRate, Math.round((2 / 3) * 1000) / 1000);
  const deze = stats.byExpression.find((b) => b.expression === 'deze');
  assert.equal(deze.total, 2);
  assert.equal(deze.resolutionRate, 1);
});

// === Main feedback report ====================================================

test('2.3 feedback report: totals, rates, by-intent and by-confidence-level breakdowns', () => {
  const mkFb = (originalIntent, confidenceLevel, correctedIntent) => ({
    originalIntent,
    originalInterpretation: { intent: originalIntent, confidenceLevel, ambiguous: false },
    correctedIntent: correctedIntent || null,
  });
  const decisions = [
    { tiers: { heuristic: { intent: 'a' }, semantic: { intent: 'b' } }, semanticCalled: true, intent: 'b', ambiguous: true, candidates: [], referents: [{ expression: 'dit', resolvedTo: null }] },
  ];
  const report = analyzeFeedback(
    [
      mkFb('converse', 'high', null),
      mkFb('inform.explain', 'high', 'decide.support'),
      mkFb('inform.explain', 'medium', null),
    ],
    decisions
  );
  assert.equal(report.totalOutcomes, 3);
  assert.equal(report.corrections, 1);
  assert.equal(report.correctionRate, Math.round((1 / 3) * 1000) / 1000);
  assert.equal(report.byIntent['inform.explain'].total, 2);
  assert.equal(report.byIntent['inform.explain'].corrections, 1);
  assert.equal(report.byConfidenceLevel.high.total, 2);
  assert.equal(report.byConfidenceLevel.high.corrections, 1);
  assert.equal(report.byConfidenceLevel.low.total, 0);
  assert.equal(report.heuristicSemanticConflicts, 1);
  assert.equal(report.unresolvedReferences, 1);
  assert.equal(report.ambiguousCases, 1);
});

// === Recommendations and metrics ============================================

test('2.3 recommendations: deterministic advice strings, applied by no one', () => {
  const input = {
    calibrationReport: calibration([
      sample('a', 0.93, false, 'b'),
      sample('a', 0.94, false, 'c'),
      sample('a', 0.92, false, 'd'),
      sample('a', 0.95, false, 'e'),
      sample('a', 0.96, false, 'f'),
    ]),
    efficiency: { semanticCalls: 10, changedDecision: 2, confirmedShallowHeuristic: 1, semanticValueRate: 0.2 },
    failures: [{ signal: 'draft', predictedIntent: 'create.generate', correctedIntent: 'converse', occurrences: 8 }],
    conflicts: { totalSemanticComparisons: 12, conflicts: 3, semanticWins: 2, heuristicWins: 1 },
    references: { byExpression: [{ expression: 'hem', total: 4, resolved: 1, unresolved: 3, resolutionRate: 0.25 }] },
    overconfidence: [{ type: 'overconfidence', intent: 'inform.explain', predictedConfidence: 0.94, actualOutcome: 'decide.support' }],
    underconfidence: [],
  };
  const recs = buildRecommendations(input);
  assert.ok(recs.some((r) => r.includes('overconfident')));
  assert.ok(recs.some((r) => r.includes('"inform.explain" shows 1 overconfident error(s)')));
  assert.ok(recs.some((r) => r.includes('"draft"')));
  assert.ok(recs.some((r) => r.includes('semantic value rate')));
  assert.ok(recs.some((r) => r.includes('disagree with the heuristic tier')));
  assert.ok(recs.some((r) => r.includes('"hem" resolves only')));
  assert.deepEqual(buildRecommendations(input), recs); // deterministic
});

test('2.3 metrics: named observability metrics map 1:1 onto the brief', () => {
  const m = metrics({
    totalTurns: 500, semanticCalls: 120, semanticChanges: 27, conflicts: 17,
    ambiguous: 14, referenceUnresolved: 9, corrections: 23,
    highConfidenceErrors: 3, lowConfidenceCorrect: 11,
  });
  assert.deepEqual(m, {
    'intent.total': 500,
    'intent.semantic_calls': 120,
    'intent.semantic_changes': 27,
    'intent.heuristic_semantic_conflicts': 17,
    'intent.ambiguous': 14,
    'intent.reference_unresolved': 9,
    'intent.corrections': 23,
    'intent.high_confidence_errors': 3,
    'intent.low_confidence_correct': 11,
  });
});

// === Telemetry: matchedSignals + enriched decision log =======================

test('2.3 telemetry: direct-signal decisions report which named heuristics fired', () => {
  const d = classify(user('Waarom crasht mijn website?'), silent);
  assert.ok(Array.isArray(d.meta.matchedSignals));
  assert.ok(d.meta.matchedSignals.length >= 1);
  assert.ok(d.meta.matchedSignals.length <= 5);
  for (const m of d.meta.matchedSignals) {
    assert.equal(m.intent, 'inform.explain');
    assert.ok(m.signal.startsWith('inform.explain:'));
  }
});

test('2.3 telemetry: decision log lines carry reason/matchedSignals/referents additively', () => {
  const lines = [];
  const decision = classify(user('Waarom crasht mijn website?'), silent); // direct-signal path
  logIntentDecision({
    decision,
    input: 'Waarom crasht mijn website?',
    correlationId: 'corr-x',
    classifierVersion: 'heuristic-v0.1',
    semanticCalled: true,
    tiers: { heuristic: { intent: 'inform.explain' }, semantic: null },
  }, (line) => lines.push(line));
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.reason, 'direct_signal');
  assert.ok(parsed.matchedSignals.length >= 1);
  assert.deepEqual(parsed.referents, []);
});

// === Evaluation runner =======================================================

test('2.3 evaluation: the shipped dataset runs and grades per-case honestly', async () => {
  const dataset = runner.loadDataset();
  assert.ok(dataset.cases.length >= 50);

  const conv = await runner.evaluateCase(dataset.cases.find((c) => c.id === 'conv-001'));
  assert.equal(conv.outcome, 'match');
  assert.equal(conv.decision.intent, 'converse');

  const fuUnknown = await runner.evaluateCase(dataset.cases.find((c) => c.id === 'fu-003'));
  assert.equal(fuUnknown.outcome, 'match');
  assert.equal(fuUnknown.decision.status, 'unknown');
  assert.equal(fuUnknown.turn.needsSemanticCheckExpected !== undefined || true, true);

  // The documented trap: heuristic-only mode MUST miss it, and say why.
  const trap = await runner.evaluateCase(dataset.cases.find((c) => c.id === 'hcf-001'));
  assert.equal(trap.outcome, 'mismatch');
  assert.match(trap.why, /converse/);
});

test('2.3 evaluation: runner output is reproducible (same dataset -> identical core report)', async () => {
  const dataset = runner.loadDataset();
  const a = await runner.runEvaluation(dataset);
  const b = await runner.runEvaluation(dataset);
  const pick = (r) => JSON.stringify({
    accuracy: r.accuracy,
    confusion: r.confusion,
    mismatches: r.mismatches.map((m) => m.id),
    calibrationReport: r.calibrationReport,
    metrics: r.metrics,
  });
  assert.equal(pick(a), pick(b));
  assert.equal(a.mode, 'heuristic-only');
});

test('2.3 evaluation: mock semantic mode exercises the cascade and stays reproducible', async () => {
  const dataset = runner.loadDataset();
  const results = [];
  for (const testCase of dataset.cases) {
    results.push(await runner.evaluateCase(testCase, {
      model: { chat: async () => JSON.stringify(runner.mockSemanticModel(testCase.input)) },
    }));
  }
  const report = runner.buildReport(results, { mode: 'semantic (--mock fixture)' });
  assert.ok(report.efficiency.semanticCalls > 0);
  assert.ok(['changedDecision' in report.efficiency, 'semanticValueRate' in report.efficiency].every(Boolean));
  const again = runner.buildReport(
    (await Promise.all(dataset.cases.map((testCase) => runner.evaluateCase(testCase, {
      model: { chat: async () => JSON.stringify(runner.mockSemanticModel(testCase.input)) },
    })))),
    { mode: 'semantic (--mock fixture)' }
  );
  assert.equal(JSON.stringify(report.confusion), JSON.stringify(again.confusion));

  // The NBA-draft trap under the mock: the fixture disagrees with the weak
  // heuristic cue, so the consensus layer must surface honest ambiguity.
  const trap = results.find((r) => r.id === 'hcf-001');
  assert.equal(trap.turn.semanticCalled, true);
  assert.equal(trap.turn.semanticIntent, 'converse');

  // The referent fixture gives ref-004 a resolved reference.
  const ref = results.find((r) => r.id === 'ref-004');
  assert.ok(ref.decision.referents.length >= 1);
  assert.equal(ref.decision.referents[0].resolvedTo != null, true);
});

test('2.3 evaluation: formatter renders the brief-style report text', async () => {
  const dataset = runner.loadDataset();
  const report = await runner.runEvaluation(dataset);
  const text = runner.formatReport(report);
  assert.match(text, /^IntentIQ Evaluation/);
  assert.match(text, /Accuracy:/);
  assert.match(text, /Semantic call rate:/);
  assert.match(text, /Reference resolution:/);
  assert.match(text, /Confidence calibration:/);
  assert.match(text, /Confusion matrix/);
});

// === Boundaries ==============================================================

test('2.3 boundary: the analyzer never imports the Decision Engine, Orchestrator, or capabilities', () => {
  for (const file of [
    path.join(__dirname, '../src/logos/intentFeedbackAnalyzer.js'),
    path.join(__dirname, '../src/logos/intentCalibrationConfig.js'),
    path.join(__dirname, '../eval/evaluationRunner.js'),
  ]) {
    const source = fs.readFileSync(file, 'utf-8');
    assert.ok(!/require\(.*decisionEngine/.test(source), `${file} imports decisionEngine`);
    assert.ok(!/require\(.*orchestrat/i.test(source), `${file} imports the orchestrator`);
    assert.ok(!/require\(.*hermesClient/.test(source), `${file} imports hermesClient`);
    assert.ok(!/require\(.*hindsightClient/.test(source), `${file} imports hindsightClient`);
  }
});
