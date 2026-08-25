'use strict';

/**
 * Pattern Awareness 0.1 — consumption/decision policy tests.
 *
 * Covers the spec's test matrix: greeting gate, established/candidate/low-
 * confidence/irrelevant handling, memory-vs-pattern semantics, explicit
 * mention requirement, silent use_as_context, multiple-pattern ranking &
 * caps, provenance preservation, and the Decision Engine boundary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  DEFAULT_PATTERN_AWARENESS_POLICY,
  shouldAttemptPatternRetrieval,
  evaluatePatternUsage,
  decidePatternAction,
  normalizeCandidate,
  restatementOverlap,
  certaintyLabel,
  renderPatternContextBlock,
  logPatternAwareness,
} = require('../src/reasoning/patternAwareness');
const { decide } = require('../src/decision/decisionEngine');
const { validateDecision, PATTERN_USAGE_MODES } = require('../src/decision/decisionSchema');

function candidate(overrides = {}) {
  return {
    id: 'pattern-1',
    statement: 'Bo lijkt vaker langdurig creatief te werken na technische doorbraken.',
    status: 'established',
    confidence: 0.85,
    hypothesisIds: ['hyp-a', 'hyp-b'],
    persistence: 'durable',
    sourceRef: 'ptf_1',
    relevance: 0.88,
    ...overrides,
  };
}

// --- §4: the cheap gate ------------------------------------------------------

test('gate: a plain greeting never opens pattern retrieval', () => {
  assert.equal(shouldAttemptPatternRetrieval('Hoi Gaia', { intent: 'greet', status: 'accepted' }), false);
  assert.equal(shouldAttemptPatternRetrieval('Hoi Gaia', { intent: 'converse', status: 'accepted' }), false); // trivial length
  assert.equal(shouldAttemptPatternRetrieval('Hoi Gaia', null), false);
});

test('gate: pure social ritual intents are skipped even when long enough', () => {
  assert.equal(shouldAttemptPatternRetrieval('Doei tot morgen Gaia, fijne avond nog!', { intent: 'farewell', status: 'accepted' }), false);
  assert.equal(shouldAttemptPatternRetrieval('Prima, dank je wel daarvoor hoor', { intent: 'acknowledge', status: 'accepted' }), false);
});

test('gate: meta-intents about Gaia herself are skipped', () => {
  assert.equal(
    shouldAttemptPatternRetrieval('waarom koos je eerder voor websearch bij die vraag?', { intent: 'meta.question', status: 'accepted' }),
    false
  );
});

test('gate: an unresolved turn with no topic and no entities is skipped', () => {
  const intentDecision = { intent: null, status: 'unknown', entities: [], sourceOfTruth: 'unknown' };
  assert.equal(shouldAttemptPatternRetrieval('mmjaah eigenlijk weet ik het niet echt meer', intentDecision), false);
});

test('gate: topical turns open retrieval', () => {
  assert.equal(shouldAttemptPatternRetrieval('Ik wil vanavond weer aan Melodiq werken', { intent: 'converse', status: 'accepted' }), true);
  assert.equal(shouldAttemptPatternRetrieval('helpt dit patroon bij mijn project?', null), true);
  // entities alone give an unresolved turn a topic
  assert.equal(
    shouldAttemptPatternRetrieval('vertel eens wat daarvan waar is', { intent: null, status: 'unknown', entities: [{ type: 'project', value: 'Melodiq' }], sourceOfTruth: 'unknown' }),
    true
  );
});

// --- relevance != confidence --------------------------------------------------

test('policy invariants: every documented threshold exists and orders sanely', () => {
  assert.ok(DEFAULT_PATTERN_AWARENESS_POLICY.minRelevanceForMention > DEFAULT_PATTERN_AWARENESS_POLICY.minRelevanceForContext);
  assert.ok(DEFAULT_PATTERN_AWARENESS_POLICY.minConfidenceForMention >= DEFAULT_PATTERN_AWARENESS_POLICY.minConfidence);
  assert.deepEqual([...DEFAULT_PATTERN_AWARENESS_POLICY.contextEligibleStatuses].sort(), ['established', 'supported']);
  assert.deepEqual(DEFAULT_PATTERN_AWARENESS_POLICY.mentionEligibleStatuses, ['established']);
  assert.equal(PATTERN_USAGE_MODES.length, 3);
});

test('relevance and confidence are judged independently — high relevance cannot rescue low confidence', () => {
  const verdict = decidePatternAction(normalizeCandidate(candidate({ status: 'established', confidence: 0.3, relevance: 0.99 })), {});
  assert.equal(verdict.action, 'ignore');
  assert.match(verdict.reason, /confidence/);
});

test('high confidence cannot rescue weak retrieval relevance', () => {
  const verdict = decidePatternAction(normalizeCandidate(candidate({ status: 'established', confidence: 0.9, relevance: 0.2 })), {});
  assert.equal(verdict.action, 'ignore');
  assert.match(verdict.reason, /relevance/);
});

// --- §5/§12/§8: status & confidence policy -------------------------------------

test('candidate pattern defaults to ignore — never user-facing, not even silently', () => {
  const usage = evaluatePatternUsage([candidate({ status: 'candidate', confidence: 0.9, relevance: 0.95 })], { userInput: 'creatief werk' });
  assert.equal(usage.mode, 'ignore');
  assert.deepEqual(usage.patterns, []);
  assert.deepEqual(usage.contextPatternIds, []);
  assert.deepEqual(usage.mentions, []);
  assert.match(usage.decisions[0].reason, /candidate|not eligible/i);
});

test('low-confidence supported pattern is ignored', () => {
  const usage = evaluatePatternUsage([candidate({ status: 'supported', confidence: 0.4 })], { userInput: 'creatief werk vanavond' });
  assert.equal(usage.mode, 'ignore');
});

test('relevant established pattern earns use_as_context or mention; relevant supported stays context-only', () => {
  const established = evaluatePatternUsage([candidate()], { userInput: 'ik ga zo weer creatief werken aan Melodiq' });
  assert.ok(['use_as_context', 'mention_as_observation'].includes(established.mode));

  const supported = evaluatePatternUsage(
    [candidate({ id: 'pattern-2', status: 'supported', confidence: 0.7, relevance: 0.9 })],
    { userInput: 'ik ga zo weer creatief werken aan Melodiq' }
  );
  assert.equal(supported.mode, 'use_as_context'); // never mention at this tier
});

// --- §15: decision integration ---------------------------------------------

test('decide() attaches patternUsage when patterns were offered and it validates', () => {
  const decision = decide({
    userInput: 'ik ga zo weer creatief werken aan Melodiq',
    intent: { intent: 'converse', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    context: { reflections: [], mentalModels: [], patterns: [candidate()] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.ok(decision.patternUsage);
  assert.ok(PATTERN_USAGE_MODES.includes(decision.patternUsage.mode));
  assert.equal(validateDecision(decision), null);
});

test('decide() attaches NO patternUsage when no patterns were offered — additive absence', () => {
  const decision = decide({
    userInput: 'hoi',
    intent: null,
    context: { reflections: [], mentalModels: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'native' }],
  });
  assert.equal(decision.patternUsage, undefined);
});

test('ignore-mode patternUsage still rides on the decision when irrelevant patterns were seen', () => {
  const decision = decide({
    userInput: 'wat is de hoofdstad van Bolivia?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    context: { reflections: [], mentalModels: [], patterns: [candidate({ relevance: 0.1 })] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }],
  });
  assert.equal(decision.patternUsage.mode, 'ignore');
  assert.deepEqual(decision.context, []); // seeing and setting aside is not drawing on Hindsight
});

test('usedContextSources reports hindsight only for actually-used patterns', () => {
  const decisionUsed = decide({
    userInput: 'weer creatief aan de slag met Melodiq vanavond',
    intent: null,
    context: { reflections: [], mentalModels: [], patterns: [candidate()] },
    reasoning: null,
    availableCapabilities: [{ id: 'native' }],
  });
  assert.deepEqual(decisionUsed.context, ['hindsight']);

  const decisionIgnored = decide({
    userInput: 'weer creatief aan de slag met Melodiq vanavond',
    intent: null,
    context: { reflections: [], mentalModels: [], patterns: [candidate({ status: 'candidate' })] },
    reasoning: null,
    availableCapabilities: [{ id: 'native' }],
  });
  assert.deepEqual(decisionIgnored.context, []);
});

// --- §10/§17: mention guidance & Response Engine boundary ----------------------

test('mention requires the explicit mode choice and always carries tentative phrasing guidance', () => {
  const usage = evaluatePatternUsage([candidate()], { userInput: 'vertel, zie jij patronen in mijn creatieve werk?' });
  if (usage.mode === 'mention_as_observation') {
    assert.equal(usage.mentions.length, 1);
    assert.equal(usage.mentions[0].phrasing, 'tentative');
    assert.equal(usage.mentions[0].patternId, 'pattern-1');
  } else {
    assert.equal(usage.mode, 'use_as_context');
    assert.deepEqual(usage.mentions, []);
  }
});

test('renderPatternContextBlock returns null for ignore/absent usage — nothing leaks into the prompt', () => {
  const candidatesById = new Map([['pattern-1', normalizeCandidate(candidate())]]);
  assert.equal(renderPatternContextBlock(null, candidatesById), null);
  assert.equal(renderPatternContextBlock({ mode: 'ignore', patterns: [], contextPatternIds: [], mentions: [] }, candidatesById), null);
});

test('renderPatternContextBlock frames patterns as derived observations, never facts (memory vs pattern)', () => {
  const c = normalizeCandidate(candidate());
  const candidatesById = new Map([[c.id, c]]);
  const block = renderPatternContextBlock({
    mode: 'use_as_context',
    patterns: [c.id],
    contextPatternIds: [c.id],
    mentions: [],
  }, candidatesById);
  assert.match(block, /NOT confirmed facts/);
  assert.match(block, /knowledgeType: pattern/);
  assert.match(block, new RegExp(c.statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('mention guidance demands impression phrasing ("indruk"), forbids fact phrasing', () => {
  const c = normalizeCandidate(candidate());
  const candidatesById = new Map([[c.id, c]]);
  const block = renderPatternContextBlock({
    mode: 'mention_as_observation',
    patterns: [c.id],
    contextPatternIds: [],
    mentions: [{ patternId: c.id, phrasing: 'tentative' }],
  }, candidatesById);
  assert.match(block, /Ik krijg de indruk/i);
  assert.match(block, /NEVER as a statement of fact/i);
  assert.match(block, /Jij bent iemand die/i);
});

// --- §19: multiple patterns — ranking & caps -----------------------------------

test('multiple eligible patterns are ranked by relevance and capped to avoid overload', () => {
  const usage = evaluatePatternUsage([
    candidate({ id: 'p-low', status: 'supported', confidence: 0.7, relevance: 0.6 }),
    candidate({ id: 'p-high', statement: 'Anders patroon over werkritme en focus.', status: 'supported', confidence: 0.7, relevance: 0.92 }),
    candidate({ id: 'p-mid', statement: 'Nog een ander patroon over communicatie.', status: 'supported', confidence: 0.7, relevance: 0.75 }),
    candidate({ id: 'p-extra', statement: 'Vierde patroon over planning.', status: 'supported', confidence: 0.7, relevance: 0.58 }),
  ], { userInput: 'hoe zit dat met mijn werkwijze de laatste tijd?' });

  assert.equal(usage.mode, 'use_as_context');
  assert.deepEqual(usage.contextPatternIds, ['p-high', 'p-mid']); // ranked, capped at 2
  const dropped = usage.decisions.find((d) => d.patternId === 'p-extra' || d.patternId === 'p-low');
  assert.ok(dropped.action === 'ignore');
  assert.ok(usage.decisions.some((d) => /budget/.test(d.reason)));
});

test('only one pattern may be mentioned per turn, even when several qualify', () => {
  const usage = evaluatePatternUsage([
    candidate({ id: 'p-1', relevance: 0.95 }),
    candidate({ id: 'p-2', statement: 'Tweeds gevestigd patroon over avondwerk.', relevance: 0.9 }),
  ], { userInput: 'zag je dat ik vaak laat doorwerk?' });
  assert.equal(usage.mode, 'mention_as_observation');
  assert.equal(usage.mentions.length, DEFAULT_PATTERN_AWARENESS_POLICY.maxMentionsPerTurn);
});

// --- §18: suppression ---------------------------------------------------------

test('a pattern that merely restates the current turn is suppressed from mentioning', () => {
  // The user voices (almost exactly) what the pattern already says.
  const turn = 'ik denk dat ik vaker langdurig creatief kan werken na technische doorbraken';
  assert.ok(restatementOverlap(candidate().statement, turn) >= DEFAULT_PATTERN_AWARENESS_POLICY.restatementOverlapForMentionSuppression);
  const verdict = decidePatternAction(normalizeCandidate(candidate()), { userInput: turn, mentionsBudgetLeft: 1 });
  assert.equal(verdict.action, 'use_as_context');
  assert.match(verdict.reason, /restates/);
});

test('sensitive topics need clearly higher relevance before being voiced', () => {
  const sensitive = candidate({ id: 'p-sens', statement: 'Bo lijkt slaap en gezondheid vaker te verwaarlozen tijdens projecten.', relevance: 0.8 });
  const verdict = decidePatternAction(normalizeCandidate(sensitive), { userInput: 'vertel over mijn gezondheid', mentionsBudgetLeft: 1 });
  assert.equal(verdict.action, 'use_as_context'); // usable quietly…
  assert.match(verdict.reason, /sensitive/);      // …but not voiced at 0.8 < 0.85
});

// --- §14/§16: provenance & boundaries ------------------------------------------

test('pattern provenance survives: ids stay intact through normalization and decisions', () => {
  const c = candidate({ id: 'pattern-42', hypothesisIds: ['hyp-1', 'hyp-2'], sourceRef: 'ptf_9' });
  const normalized = normalizeCandidate(c);
  assert.equal(normalized.id, 'pattern-42');
  assert.deepEqual(normalized.hypothesisIds, ['hyp-1', 'hyp-2']); // visible, never reconstructed further
  assert.equal(normalized.sourceRef, 'ptf_9');

  const usage = evaluatePatternUsage([c], { userInput: 'creatief werk na doorbraak' });
  assert.ok(usage.decisions.every((d) => d.patternId.startsWith('pattern-')));
  assert.ok(usage.candidatesById.get('pattern-42'));
});

test('corrupt recall entries are dropped, never fabricated', () => {
  assert.equal(normalizeCandidate(null), null);
  assert.equal(normalizeCandidate({}), null);
  assert.equal(normalizeCandidate({ id: 'x' }), null);
  assert.equal(normalizeCandidate({ id: 'x', statement: '   ' }), null);
  const unscored = normalizeCandidate({ id: 'x', statement: 'iets zinnigs hier' });
  assert.equal(unscored.relevance, 0); // absent score can never pass a floor
  assert.equal(unscored.confidence, 0);
});

test('boundary: the Decision Engine imports no Hindsight/PatternManager/Hermes/Web/MCP module', () => {
  const engineSource = fs.readFileSync(path.resolve(__dirname, '../src/decision/decisionEngine.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  // Routing on capability ids ("hermes", "web") is the engine's job; calling
  // into their modules would cross the context/persistence boundary.
  const requiredModules = [...engineSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepEqual(requiredModules, ['./decisionSchema', '../reasoning/patternAwareness'],
    'decisionEngine.js may only require its schema and the pure pattern policy');

  // The policy module it imports must be equally I/O-free.
  const awarenessSource = fs.readFileSync(path.resolve(__dirname, '../src/reasoning/patternAwareness.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const awarenessRequires = [...awarenessSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.ok(awarenessRequires.every((m) => !/hindsight|patternManager|hermes|braveSearch|mcp|http/i.test(m)),
    'patternAwareness.js must be pure policy — retrieval lives in turn.js via the existing adapter');
});

// --- observability --------------------------------------------------------------

test('logPatternAwareness emits ids/scores/usage/reason without user content', () => {
  const lines = [];
  const raw = [candidate()];
  const usage = evaluatePatternUsage(raw, { userInput: 'gebruikersinhoud die nooit gelogd mag worden' });
  logPatternAwareness(raw, usage, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.kind, 'pattern.awareness');
  assert.equal(parsed.candidates, 1);
  assert.equal(parsed.selected[0].patternId, 'pattern-1');
  assert.equal(parsed.selected[0].relevance, 0.88);
  assert.equal(parsed.selected[0].confidence, 0.85);
  assert.equal(parsed.selected[0].status, 'established');
  assert.ok(parsed.selected[0].reason);
  assert.ok(!JSON.stringify(parsed).includes('gebruikersinhoud'));
  assert.ok(!JSON.stringify(parsed).includes(candidate().statement));
});

test('logPatternAwareness survives garbage input without throwing', () => {
  assert.doesNotThrow(() => logPatternAwareness(null, null));
  assert.doesNotThrow(() => logPatternAwareness([undefined, {}], { mode: 'ignore', decisions: [{ patternId: 'x', action: 'ignore', reason: 'r' }] }, () => {}));
});

// --- certainty labels ------------------------------------------------------------

test('certainty labels stay honest and never claim certainty', () => {
  assert.equal(certaintyLabel(0.4), 'low');
  assert.equal(certaintyLabel(0.65), 'moderate');
  assert.equal(certaintyLabel(0.85), 'high');
  assert.equal(certaintyLabel(null), 'low');
  assert.notEqual(certaintyLabel(0.99), 'certain');
});
