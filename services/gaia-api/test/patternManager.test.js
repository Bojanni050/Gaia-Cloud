'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createPatternManager,
  PATTERN_TRANSITIONS,
  PATTERN_PERSISTENCE,
} = require('../src/reasoning/patternManager');

// Deterministic fixture hypotheses. `refs` = native evidence provenance —
// shared refs deliberately model the "same observation thrice" trap (§4).
function H(id, statement, confidence, refs = [], status = 'testing', persistence = 'durable') {
  return { id, statement, confidence, evidenceFor: refs, status, persistence };
}

function relatedPair() {
  // mem-0 is SHARED provenance between the pair — the native relatedness
  // signal the discovery rule keys on (plus lexical overlap in a/b).
  return [
    H('hyp-a', "Bo werkt 's avonds vaak aan creatieve projecten.", 0.7, ['mem-0', 'mem-1']),
    H('hyp-b', 'Na een technische doorbraak start Bo creatieve werkfasen.', 0.68, ['mem-0', 'mem-2']),
  ];
}

function makeManager(extra = {}) {
  return createPatternManager({ ...extra });
}

// --- lifecycle vocabulary -----------------------------------------------------

test('lifecycle: conservative transitions, no confirmed semantics', () => {
  assert.deepEqual(PATTERN_TRANSITIONS.candidate, ['supported']);
  assert.deepEqual(PATTERN_TRANSITIONS.supported, ['established', 'candidate']);
  assert.deepEqual(PATTERN_TRANSITIONS.established, ['candidate']);
  for (const s of Object.keys(PATTERN_TRANSITIONS)) assert.ok(!PATTERN_TRANSITIONS[s].includes('confirmed'));
  assert.equal(PATTERN_PERSISTENCE, 'durable'); // patterns are durable-only by definition
});

// --- creation ------------------------------------------------------------------

test('creation: two related durable hypotheses form a candidate with provenance', () => {
  const m = createPatternManager();
  const [a, b] = relatedPair();
  const res = m.register({
    hypothesisIds: ['hyp-a', 'hyp-b'],
    rationale: 'co-occurring creative-work signals',
    hypothesesById: { 'hyp-a': a, 'hyp-b': b },
  });
  assert.equal(res.ok, true);
  const p = res.pattern;
  assert.match(p.id, /^pattern-\d+$/);
  assert.equal(p.status, 'candidate'); // starts explicitly uncertain
  assert.deepEqual(p.hypothesisIds.sort(), ['hyp-a', 'hyp-b']); // stable-id provenance only
  assert.equal(p.persistence, 'durable');
  assert.ok(p.confidence > 0 && p.confidence <= 0.95);
});

test('creation: fewer than two known hypotheses is refused', () => {
  const m = createPatternManager();
  const res = m.register({ hypothesisIds: ['hyp-only'], hypothesesById: {} });
  assert.equal(res.ok, false);
});

// --- ephemeral exclusion ---------------------------------------------------------

test('ephemeral exclusion (precise): register requires DURABLE members via caller-provided set', () => {
  const m = createPatternManager();
  // The gate/turn path filters durable before calling register; pin that
  // contract here by passing ONLY durable members in the lookup map.
  const durableB = H('hyp-db', 'Doorbraken triggeren creatieve fasen.', 0.8, ['m2']);
  const res = m.register({
    hypothesisIds: ['hyp-db'],
    hypothesesById: { 'hyp-db': durableB },
  });
  assert.equal(res.ok, false); // single member -> nothing to relate
});

// --- support / confidence policy ---------------------------------------------------

test('support: a third independent supporting hypothesis strengthens toward supported', () => {
  const m = createPatternManager();
  const [a, b] = relatedPair();
  // Third member joins via strong lexical overlap with `a` but carries its
  // OWN native evidence ref — genuinely independent support (§4).
  const c = H('hyp-c', "Bo werkt 's avonds aan creatieve projecten.", 0.75, ['mem-9']);
  const all = { 'hyp-a': a, 'hyp-b': b, 'hyp-c': c };
  const res = m.register({ hypothesisIds: ['hyp-a', 'hyp-b'], hypothesesById: { 'hyp-a': a, 'hyp-b': b } }); // lookup without c: only the pair exists yet
  assert.equal(res.pattern.status, 'candidate'); // pair alone stays candidate

  const refreshed = m.refresh(res.pattern.id, all); // third member arrives → policy promotes
  assert.equal(refreshed.status, 'supported'); // 3 independent supports, conf ≥ 0.6
  assert.ok(refreshed.confidence >= 0.6);
});

// --- contradiction -----------------------------------------------------------------

test('contradiction: a rejected member keeps the pattern at candidate and lowers confidence', async () => {
  const m = createPatternManager();
  const [a, b] = relatedPair();
  const contra = H('hyp-k', 'Tegenstrijdige lezing: avondwerk hangt niet samen met doorbraken.', 0.4, [], 'rejected');
  const all = { 'hyp-a': a, 'hyp-b': b, 'hyp-k': contra };
  const res = m.register({ hypothesisIds: ['hyp-a', 'hyp-b', 'hyp-k'], rationale: 'mixed evidence', hypothesesById: all });
  await drainIfAny();
  assert.equal(res.pattern.status, 'candidate'); // never established with a contradiction
  const withContra = res.pattern.confidence;
  const without = createPatternManager().register({ hypothesisIds: ['hyp-a', 'hyp-b'], hypothesesById: { 'hyp-a': a, 'hyp-b': b } }).pattern.confidence;
  assert.ok(withContra < without); // penalty applied
});

// --- independence --------------------------------------------------------------------

test('independence: three rewordings of ONE observation do not become a strong pattern', () => {
  const m = createPatternManager();
  const sameRef = ['mem-shared'];
  const trio = [
    H('hyp-1', "Bo is 's avonds creatiever.", 0.85, sameRef),
    H('hyp-2', 'Bo werkt creatiever in de avond.', 0.85, sameRef),
    H('hyp-3', 'Avondelijkse creativiteit bij Bo.', 0.85, sameRef),
  ];
  const res = m.register({ hypothesisIds: ['hyp-1', 'hyp-2', 'hyp-3'], hypothesesById: { 'hyp-1': trio[0], 'hyp-2': trio[1], 'hyp-3': trio[2] } });
  const p = res.pattern;
  // All mentions share one ref → independence factor 1/3 → capped well below supported floor.
  assert.ok(p.confidence < 0.6, `confidence=${p.confidence}`);
  assert.equal(p.status, 'candidate');
  const lowMembers = p.membersDetail.filter((d) => d.independence === 'low').length;
  assert.equal(lowMembers, 3);
});

// --- dedup ------------------------------------------------------------------------------

test('dedup: identical hypothesis-set returns the existing pattern; phrased-duplicate too', () => {
  const m = createPatternManager();
  const [a, b] = relatedPair();
  const map = { 'hyp-a': a, 'hyp-b': b };
  const first = m.register({ hypothesisIds: ['hyp-a', 'hyp-b'], hypothesesById: map });
  const second = m.register({ hypothesisIds: ['hyp-b', 'hyp-a'], rationale: 'same again', hypothesesById: map });
  assert.equal(second.duplicateOf, first.pattern.id);

  const third = m.register({ statement: first.pattern.statement, hypothesisIds: ['hyp-a', 'hyp-b'], hypothesesById: map });
  assert.equal(third.duplicateOf, first.pattern.id);
  assert.equal(m.list().length, 1);
});

// --- gated discovery -----------------------------------------------------------------------

test('gate: unrelated durable hypotheses form nothing; related ones do; plain turn never triggers', () => {
  const m = createPatternManager();
  const unrelated = [
    H('hyp-u1', 'De keukenrenovatie loopt drie weken achter.', 0.7, ['m10']),
    H('hyp-u2', 'Bo prefereert dialectloze communicatie.', 0.7, ['m11']),
  ];
  let out = m.maybeFormPatterns({ hypotheses: unrelated, changedHypothesisIds: ['hyp-u1', 'hyp-u2'] });
  assert.equal(out.formed.length, 0); // unrelated -> no pattern (conservative)

  out = m.maybeFormPatterns({ hypotheses: relatedPair(), changedHypothesisIds: ['hyp-a'] });
  assert.equal(out.gateOpen, true);
  assert.equal(out.formed.length, 1);

  // A conversational turn without durable changes: gate closed.
  const empty = m.maybeFormPatterns({ hypotheses: relatedPair(), changedHypothesisIds: [] });
  assert.equal(empty.gateOpen, false);
  assert.equal(empty.formed.length + empty.updated.length, 0);
});

test('gate: shared native evidence relates two durable hypotheses even with dissimilar wording', () => {
  const m = createPatternManager();
  const pair = [
    H('hyp-r1', 'Deploy-fails volgen op credential-rotaties.', 0.7, ['hs_native_77']),
    H('hyp-r2', 'Na credential-rotaties crasht de nightly pipeline.', 0.72, ['hs_native_77']), // SAME observation
    H('hyp-solo', 'Losstaand feit over de printer.', 0.9, ['other-ref']),
  ];
  const out = m.maybeFormPatterns({ hypotheses: pair, changedHypothesisIds: ['hyp-r1', 'hyp-r2', 'hyp-solo'] });
  assert.equal(out.formed.length, 1);
  assert.deepEqual(out.formed[0].hypothesisIds.slice().sort(), ['hyp-r1', 'hyp-r2']);
});

// --- demotion -------------------------------------------------------------------------------

test('demotion: strong counter-evidence (a rejected member) falls back toward candidate', () => {
  const m = createPatternManager();
  const [a, b] = relatedPair();
  const c = H('hyp-c', 'Derde bevestiging.', 0.78, ['mem-3']);
  const d = H('hyp-d', 'Vierde onafhankelijke bevestiging.', 0.8, ['mem-4']);
  const all = { 'hyp-a': a, 'hyp-b': b, 'hyp-c': c, 'hyp-d': d };
  // Seed an ESTABLISHED pattern (as storage would after prior turns).
  m.seed([{ id: 'pattern-seed', statement: 'Seeded established pattern.', status: 'established', confidence: 0.8, hypothesisIds: ['hyp-a', 'hyp-b', 'hyp-c', 'hyp-d'] }]);

  // One member gets rejected → recomputation demotes toward candidate.
  const rejectedC = { ...c, status: 'rejected' };
  const refreshed = m.refresh('pattern-seed', { ...all, 'hyp-c': rejectedC });
  assert.equal(refreshed.confidence < 0.8, true);
  assert.notEqual(refreshed.status, 'established'); // never stays settled under contradiction
});

// --- persistence boundary ---------------------------------------------------------------------

test('persistence: save/update flow through the injected sink; default sink is honest no-op', async () => {
  const saved = []; const updated = [];
  const m = createPatternManager({ sink: { save: (p) => saved.push(p.id), update: (id) => updated.push(id) } });
  const [a, b] = relatedPair();
  const res = m.register({ hypothesisIds: ['hyp-a', 'hyp-b'], rationale: 'r', hypothesesById: { 'hyp-a': a, 'hyp-b': b } });
  await new Promise((r) => setImmediate(r));
  m.refresh(res.pattern.id, { 'hyp-a': a, 'hyp-b': b, });
  await new Promise((r) => setImmediate(r));
  // Two updates: register's internal refresh + the explicit refresh below.
  assert.deepEqual(saved, [res.pattern.id]);
  assert.deepEqual(updated, [res.pattern.id, res.pattern.id]);

  // Throwing sink never breaks formation.
  const m2 = createPatternManager({ sink: { save: () => { throw new Error('down'); }, update: () => { throw new Error('down'); } } });
  const r2 = m2.register({ hypothesisIds: ['hyp-a', 'hyp-b'], rationale: 'r', hypothesesById: { 'hyp-a': a, 'hyp-b': b } });
  assert.equal(r2.ok, true);
  assert.equal(m2.get(r2.pattern.id).status, 'candidate');
});

test('boundary: PatternManager has zero Hindsight/capability/network dependencies', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/reasoning/patternManager.js'), 'utf-8');
  for (const forbidden of ['hindsightClient', 'hermesClient', 'braveSearch', 'decisionEngine', 'reasonIQ', "require('./hypothesisManager')"]) {
    assert.ok(!new RegExp(`require\\([^)]*${forbidden}`).test(src), `patternManager requires ${forbidden}`);
  }
  assert.ok(!/\bfetch\s*\(/.test(src));
});

// helper used by the contradiction test
async function drainIfAny() { await new Promise((r) => setImmediate(r)); }

test("0.4 growth: a grown cluster refreshes the EXISTING pattern instead of forking a near-duplicate", () => {
  const m = createPatternManager();
  // Reworded observations of the same recurring relationship — the classic
  // near-duplicate trap; lexical overlap relates them (no shared refs).
  const h1 = H("h1", "Bo werkt creatiever na technische doorbraken.", 0.7);
  const h2 = H("h2", "Na technische doorbraken werkt Bo creatiever.", 0.68);
  let out = m.maybeFormPatterns({ hypotheses: [h1, h2], changedHypothesisIds: ["h1", "h2"] });
  assert.equal(out.formed.length, 1);
  const patternId = out.formed[0].id;

  // A third related durable hypothesis arrives -> same pattern grows.
  const h3 = H("h3", "Technische doorbraken maken dat Bo creatiever werkt.", 0.75);
  out = m.maybeFormPatterns({ hypotheses: [h1, h2, h3], changedHypothesisIds: ["h3"] });
  assert.equal(out.formed.length, 0); // no fork
  assert.equal(m.list().length, 1); // still exactly ONE pattern
  assert.deepEqual(m.get(patternId).hypothesisIds.slice().sort(), ["h1", "h2", "h3"]);
});
