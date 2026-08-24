'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createHypothesisManager,
  HYPOTHESIS_TRANSITIONS,
  DEFAULT_POLICY,
} = require('../src/reasoning/hypothesisManager');

function seeded() {
  return createHypothesisManager({
    hypotheses: [{
      id: 'hyp-123',
      statement: 'Concurrent cancellation causes the streaming race.',
      status: 'testing',
      confidence: 0.64,
      evidenceFor: ['hindsight-1', 'hindsight-2'],
      evidenceAgainst: [],
    }],
  });
}

// --- lifecycle vocabulary -----------------------------------------------------

test('transitions: the lifecycle map is explicit and frozen', () => {
  assert.deepEqual(HYPOTHESIS_TRANSITIONS.proposed, ['testing', 'rejected']);
  assert.deepEqual(HYPOTHESIS_TRANSITIONS.testing, ['confirmed', 'rejected']);
  assert.deepEqual(HYPOTHESIS_TRANSITIONS.confirmed, ['testing']);
  assert.deepEqual(HYPOTHESIS_TRANSITIONS.rejected, ['testing']);
});

// --- create -------------------------------------------------------------------

test('create: a new hypothesis gets a stable hyp-N id and starts as proposed', () => {
  const m = createHypothesisManager();
  const { hypothesis, duplicateOf } = m.propose({ statement: 'The race is caused by cancellation.', confidence: 0.5 });
  assert.equal(duplicateOf, null);
  assert.match(hypothesis.id, /^hyp-\d+$/);
  assert.equal(hypothesis.status, 'proposed');
  assert.equal(hypothesis.confidence, 0.5);
});

test('existing: a seeded hypothesis is recognized by id and keeps its state', () => {
  const m = seeded();
  const h = m.get('hyp-123');
  assert.ok(h);
  assert.equal(h.status, 'testing');
  assert.equal(h.confidence, 0.64);
  assert.deepEqual(h.evidenceFor, ['hindsight-1', 'hindsight-2']);
});

// --- evidence updates ----------------------------------------------------------

test('supports: new supporting evidence raises confidence and is recorded once', () => {
  const m = seeded();
  const audit = m.applyUpdate({ hypothesisId: 'hyp-123', evidenceId: 'upload-9', relation: 'supports', confidenceDelta: 0.1, rationale: 'matches the observed abort pattern' });
  assert.equal(audit.accepted, true);
  const h = m.get('hyp-123');
  assert.equal(h.confidence, 0.74);
  assert.deepEqual(h.evidenceFor, ['hindsight-1', 'hindsight-2', 'upload-9']);
  m.applyUpdate({ hypothesisId: 'hyp-123', evidenceId: 'upload-9', relation: 'supports', confidenceDelta: 0.1 });
  assert.equal(m.get('hyp-123').evidenceFor.length, 3); // no double-count
});

test('weakens: opposing evidence lowers confidence and lands in evidenceAgainst', () => {
  const m = seeded();
  m.applyUpdate({ hypothesisId: 'hyp-123', evidenceId: 'turn-7', relation: 'weakens', confidenceDelta: 0.2, rationale: 'races also occur without cancels' });
  const h = m.get('hyp-123');
  assert.equal(h.confidence, 0.44);
  assert.deepEqual(h.evidenceAgainst, ['turn-7']);
});

test('contradicts: contradicting evidence registers as a conflict, never silently ignored', () => {
  const m = seeded();
  const audit = m.applyUpdate({ hypothesisId: 'hyp-123', evidenceId: 'log-3', relation: 'contradicts', confidenceDelta: 0.15, rationale: 'logs show clean teardown' });
  assert.equal(audit.relation, 'contradicts');
  assert.ok(m.get('hyp-123').evidenceAgainst.includes('log-3'));
});

test('contradicts on a CONFIRMED hypothesis forces it back to testing (never silently confirmed)', () => {
  const m = createHypothesisManager({
    hypotheses: [{ id: 'hyp-c1', statement: 'X causes Y.', status: 'confirmed', confidence: 0.8 }],
  });
  const audit = m.applyUpdate({ hypothesisId: 'hyp-c1', evidenceId: 'e-new', relation: 'contradicts', confidenceDelta: 0.15, rationale: 'new counterexample' });
  assert.equal(audit.from, 'confirmed');
  assert.equal(audit.to, 'testing');
  assert.equal(m.get('hyp-c1').status, 'testing');
});

test('irrelevant: recorded but adjusts nothing', () => {
  const m = seeded();
  const before = JSON.stringify(m.get('hyp-123'));
  const audit = m.applyUpdate({ hypothesisId: 'hyp-123', evidenceId: 'noise-1', relation: 'irrelevant' });
  assert.equal(audit.accepted, true);
  assert.equal(audit.to, null);
  assert.equal(JSON.stringify({ ...m.get('hyp-123'), updatedAt: 0 }), before.replace(/"updatedAt":"[^"]+"/, '"updatedAt":0'));
});

// --- confirm / reject via the policy -------------------------------------------

test('confirm: refused while policy is unmet, allowed through evaluateTransition when met', () => {
  const m = seeded();
  // Only 2 support items, confidence 0.64 < 0.75 -> policy refuses.
  let res = m.evaluateTransition('hyp-123', 'confirmed', { rationale: 'seems likely' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /policy/);

  m.applyUpdate({ hypothesisId: 'hyp-123', evidenceId: 'upload-9', relation: 'supports', confidenceDelta: 0.2 });
  res = m.evaluateTransition('hyp-123', 'confirmed', { rationale: 'three independent sources now agree; no counter-evidence' });
  assert.equal(res.ok, true);
  assert.equal(m.get('hyp-123').status, 'confirmed');

  // A rationale is mandatory for confirm.
  const m2 = seeded();
  m2.applyUpdate({ hypothesisId: 'hyp-123', evidenceId: 'u', relation: 'supports', confidenceDelta: 0.31 });
  assert.equal(m2.evaluateTransition('hyp-123', 'confirmed', {}).ok, false);
});

test('reject: requires strong opposition AND low confidence per policy', () => {
  const m = createHypothesisManager({
    hypotheses: [{ id: 'hyp-r1', statement: 'Memory leaks crash the server.', status: 'testing', confidence: 0.3, evidenceFor: [], evidenceAgainst: ['a'] }],
  });
  // One oppose item only -> refused.
  assert.equal(m.evaluateTransition('hyp-r1', 'rejected', { rationale: 'disproven' }).ok, false);
  m.applyUpdate({ hypothesisId: 'hyp-r1', evidenceId: 'b', relation: 'contradicts', confidenceDelta: 0.05, rationale: 'second independent disproof' });
  const res = m.evaluateTransition('hyp-r1', 'rejected', { rationale: 'two strong counterexamples, confidence collapsed' });
  assert.equal(res.ok, true);
  assert.equal(m.get('hyp-r1').status, 'rejected');
});

test('re-open: confirmed -> testing is legal; rejected -> testing needs a rationale', () => {
  const m = createHypothesisManager({
    hypotheses: [
      { id: 'hyp-ok', statement: 'A.', status: 'confirmed', confidence: 0.8 },
      { id: 'hyp-rej', statement: 'B.', status: 'rejected', confidence: 0.2 },
    ],
  });
  assert.equal(m.evaluateTransition('hyp-ok', 'testing', { rationale: 'fresh contradiction pressure' }).ok, true);
  assert.equal(m.get('hyp-ok').status, 'testing');
  assert.equal(m.evaluateTransition('hyp-rej', 'testing', {}).ok, false); // re-open demands a reason
  assert.equal(m.evaluateTransition('hyp-rej', 'testing', { rationale: 'strong new evidence surfaced' }).ok, true);
  assert.equal(m.get('hyp-rej').status, 'testing');
});

test('invalid transitions are refused with an explicit reason', () => {
  const m = createHypothesisManager();
  const { hypothesis } = m.propose({ statement: 'Fresh proposal.' });
  // proposed -> confirmed skips testing: never allowed.
  const res = m.evaluateTransition(hypothesis.id, 'confirmed', { rationale: 'jump ahead anyway' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /invalid transition proposed -> confirmed/);
  assert.equal(m.get(hypothesis.id).status, 'proposed');
});

test('first evidence moves a fresh proposal into testing automatically', () => {
  const m = createHypothesisManager();
  const { hypothesis } = m.propose({ statement: 'Cache stampede causes the 500s.' });
  m.applyUpdate({ hypothesisId: hypothesis.id, evidenceId: 'log-1', relation: 'supports', confidenceDelta: 0.1, rationale: 'spike pattern matches' });
  assert.equal(m.get(hypothesis.id).status, 'testing');
});

// --- deduplication -------------------------------------------------------------

test('dedup: exact-normalized duplicate statements return the SAME hypothesis', () => {
  const m = seeded();
  const { hypothesis, duplicateOf } = m.propose({ statement: 'Concurrent cancellation causes the streaming race.' });
  assert.equal(duplicateOf, 'hyp-123');
  assert.equal(hypothesis.id, 'hyp-123');
});

test('dedup: phrased differently but token-equivalent statements are recognized too', () => {
  const m = seeded();
  const { duplicateOf } = m.propose({ statement: 'The streaming race comes from concurrent cancellation.' });
  assert.equal(duplicateOf, 'hyp-123');
});

test('dedup: genuinely different hypotheses do NOT collide', () => {
  const m = seeded();
  const { duplicateOf } = m.propose({ statement: 'The database connection pool exhausts under load.' });
  assert.equal(duplicateOf, null);
});

// --- applyReasoningResult --------------------------------------------------------

test('applyReasoningResult: structured reasoning output drives propose + updates, nothing else does', () => {
  const saved = [];
  const updated = [];
  const m = createHypothesisManager({
    sink: { save: (h) => saved.push(h), update: (id) => updated.push(id) },
    hypotheses: [{ id: 'hyp-123', statement: 'Cancellation races break streaming.', status: 'testing', confidence: 0.6 }],
  });

  const { applied } = m.applyReasoningResult({
    hypotheses: [
      { statement: 'Cancellation races break streaming.', existingId: 'hyp-123', confidence: 0.68, evidenceFor: ['upload-1'], evidenceAgainst: [] },
      { statement: 'A brand new hypothesis about retries.', confidence: 0.4, evidenceFor: [], evidenceAgainst: [] },
    ],
    hypothesisUpdates: [
      { hypothesisId: 'hyp-123', evidenceId: 'upload-1', relation: 'supports', confidenceDelta: 0.08, rationale: 'doc confirms abort path' },
      { hypothesisId: 'invented-hyp', evidenceId: 'x', relation: 'supports', confidenceDelta: 0.1, rationale: 'nope' },
    ],
  });

  assert.equal(updated.length >= 1, true); // sink saw the update
  assert.equal(saved.length, 1); // one NEW hypothesis persisted
  assert.equal(m.get('hyp-123').confidence, 0.68);
  assert.deepEqual(m.get('hyp-123').evidenceFor, ['upload-1']);
  const fresh = m.list().find((h) => h.id !== 'hyp-123');
  assert.ok(fresh && fresh.status === 'proposed'); // new one proposed, not auto-tested
  // The invented-hyp update was recorded as refused — nothing to route to.
  const refused = applied.find((a) => a.accepted === false);
  assert.ok(refused && /unknown hypothesis/.test(refused.reason));
});

test('provenance: the manager never fabricates evidence ids beyond what reasoning supplied', () => {
  const m = seeded();
  m.applyReasoningResult({
    hypotheses: [{ statement: 'Cancellation races break streaming.', existingId: 'hyp-123', evidenceFor: ['hindsight-1'], evidenceAgainst: [] }],
    hypothesisUpdates: [],
  });
  const h = m.get('hyp-123');
  assert.ok(!h.evidenceFor.includes('made-up'));
  assert.deepEqual(h.evidenceFor.filter((id) => !['hindsight-1', 'hindsight-2'].includes(id)), []);
});

// --- persistence boundary --------------------------------------------------------

test('persistence goes ONLY through the injected sink; default sink is an honest no-op', () => {
  const calls = [];
  const m = createHypothesisManager({
    sink: { save: (h) => calls.push(['save', h.id]), update: (id) => calls.push(['update', id]) },
  });
  const { hypothesis } = m.propose({ statement: 'Persisted via sink only.' });
  m.applyUpdate({ hypothesisId: hypothesis.id, evidenceId: 'e1', relation: 'supports', confidenceDelta: 0.05, rationale: 'r' });
  assert.deepEqual(calls, [['save', hypothesis.id], ['update', hypothesis.id]]);

  // A throwing sink must never break state upkeep.
  const m2 = createHypothesisManager({ sink: { save: () => { throw new Error('hindsight down'); }, update: () => { throw new Error('down'); } } });
  const { hypothesis: h2 } = m2.propose({ statement: 'Survives sink failures.' });
  m2.applyUpdate({ hypothesisId: h2.id, evidenceId: 'e2', relation: 'supports', confidenceDelta: 0.05 });
  assert.equal(m2.get(h2.id).status, 'testing'); // in-memory state intact
});

// --- boundaries ------------------------------------------------------------------

test('boundary: no reasoning, no retrieval, no capabilities anywhere in the manager', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/reasoning/hypothesisManager.js'), 'utf-8');
  // Requires are the real boundary — prose in comments may mention names.
  for (const forbidden of ['hindsightClient', 'hermesClient', 'braveSearch', 'decisionEngine', "require('./reasonIQ')", 'buildReasoningPrompt']) {
    assert.ok(!new RegExp(`require\\([^)]*${forbidden}`).test(source), `hypothesisManager requires ${forbidden}`);
  }
  assert.ok(!/\bfetch\s*\(/.test(source), 'hypothesisManager performs network calls');
});

test('policy: every threshold is explicit and documented, overridable, never magic inline numbers', () => {
  const m = createHypothesisManager({ policy: { confirmConfidence: 0.6, minSupportEvidence: 1 } });
  const { hypothesis } = m.propose({ statement: 'Custom policy path.', confidence: 0.62 });
  m.applyUpdate({ hypothesisId: hypothesis.id, evidenceId: 'e', relation: 'supports', confidenceDelta: 0.01 });
  assert.equal(m.policy.confirmConfidence, 0.6);
  assert.equal(m.evaluateTransition(hypothesis.id, 'confirmed', { rationale: 'custom policy allows this' }).ok, true);
  // Defaults elsewhere remain strict.
  assert.equal(DEFAULT_POLICY.confirmConfidence, 0.75);
});

test("hygiene: a provenance-stripped (null) citation never pollutes evidence lists", () => {
  const m = seeded();
  m.applyUpdate({ hypothesisId: "hyp-123", evidenceId: null, relation: "supports", confidenceDelta: 0.1, rationale: "citation was stripped upstream" });
  const h = m.get("hyp-123");
  assert.equal(h.confidence, 0.74); // confidence effect kept
  assert.deepEqual(h.evidenceFor, ["hindsight-1", "hindsight-2"]); // no null member
});

test('fresh proposals with linked evidence enter testing on creation of applyReasoningResult', () => {
  const m = createHypothesisManager();
  m.applyReasoningResult({
    hypotheses: [{ statement: 'Brand new but already evidenced.', confidence: 0.6, evidenceFor: ['upload-1'] }],
    hypothesisUpdates: [],
  });
  const [h] = m.list();
  assert.equal(h.status, 'testing');
});
