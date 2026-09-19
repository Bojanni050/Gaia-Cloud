'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectSignals, matchesSignal, SIGNAL_PATTERNS, SIGNAL_NAMES } = require('../src/logos/intentSignals');
const { interpret } = require('../src/logos/intentIQ');
const { PLANNING_SIGNALS, hasPlanningSignal, shouldUseConversationSearch } = require('../src/decision/decisionEngine');
const { logIntentDecision } = require('../src/logos/intentLog');

const NO_MODEL = { chat: async () => { throw new Error('no semantic model in this test'); } };

test('detectSignals returns every signal as a boolean, false for empty input', () => {
  for (const input of ['', null, undefined, '   ']) {
    const s = detectSignals(input);
    assert.deepEqual(Object.keys(s), [...SIGNAL_NAMES]);
    assert.ok(Object.values(s).every((v) => v === false), `expected all false for ${JSON.stringify(input)}`);
  }
});

test('detectSignals: each signal fires on its own cue', () => {
  assert.equal(detectSignals('wat zei ik daar precies over?').exactHistory, true);
  assert.equal(detectSignals('wat we vorige week besloten hebben').pastLookup, true);
  assert.equal(detectSignals('weet je nog wie anton is').rememberedKnowledge, true);
  assert.equal(detectSignals('analyseer deze aanpak').analysis, true);
  assert.equal(detectSignals('wat was er in juni ook alweer?').lookup, true);
});

test('detectSignals: statements from real turns do not look like lookups', () => {
  for (const t of [
    'nu weer bezig met de ontwikkeling van chronicle en jou',
    'het is tijd dat ik eerst chronicle afmaak',
    'weet niet zo goed waar te beginnen',
  ]) {
    const s = detectSignals(t);
    assert.equal(s.lookup, false, t);
    assert.equal(s.exactHistory || s.pastLookup, false, t);
  }
});

test('matchesSignal: an unknown signal name is simply false', () => {
  assert.equal(matchesSignal('wat zei ik?', 'nope'), false);
});

test('single source of truth: the engine re-exposes IntentIQ\'s exact pattern arrays', () => {
  assert.equal(PLANNING_SIGNALS.exactHistoryRequest, SIGNAL_PATTERNS.exactHistory);
  assert.equal(PLANNING_SIGNALS.pastConversationLookup, SIGNAL_PATTERNS.pastLookup);
  assert.equal(PLANNING_SIGNALS.rememberedKnowledgeRequest, SIGNAL_PATTERNS.rememberedKnowledge);
  assert.equal(PLANNING_SIGNALS.analysisRequest, SIGNAL_PATTERNS.analysis);
});

test('parity: the engine\'s view of a turn equals IntentIQ\'s published signals', () => {
  const anchored = { meta: { reason: 'assistant_anchored_follow_up_unresolved_intent' } };
  const turns = [
    'wat zei ik daar precies over?', 'wat we vorige week besloten hebben', 'weet je nog wie anton is',
    'analyseer deze aanpak', 'wat was er in juni ook alweer?', 'hoi Gaia', 'het is tijd dat ik eerst chronicle afmaak',
  ];
  for (const t of turns) {
    const s = detectSignals(t);
    assert.equal(hasPlanningSignal(t, 'exactHistoryRequest'), s.exactHistory, t);
    assert.equal(hasPlanningSignal(t, 'pastConversationLookup'), s.pastLookup, t);
    assert.equal(hasPlanningSignal(t, 'rememberedKnowledgeRequest'), s.rememberedKnowledge, t);
    assert.equal(hasPlanningSignal(t, 'analysisRequest'), s.analysis, t);
    assert.equal(shouldUseConversationSearch(anchored, t), s.lookup, t);
  }
});

test('interpret() publishes signals on the final IntentDecision', async () => {
  const decision = await interpret(
    [{ role: 'user', content: 'wat was er in juni ook alweer?' }],
    { silent: true, model: NO_MODEL },
  );
  assert.ok(decision.signals, 'decision.signals must be present');
  assert.equal(decision.signals.lookup, true);
  assert.equal(decision.signals.exactHistory, false);
});

test('interpret() signals do not depend on which tier decided (unknown, empty input)', async () => {
  const decision = await interpret([{ role: 'user', content: '' }], { silent: true, model: NO_MODEL });
  assert.deepEqual(decision.signals, detectSignals(''));
});

test('the intentiq.decision log carries the signals as booleans only', () => {
  const lines = [];
  const decision = { schemaVersion: 'intentiq.v1', intent: null, status: 'unknown', confidence: 0, candidates: [], signals: detectSignals('wat zei ik?') };
  logIntentDecision({ decision, input: 'wat zei ik?', classifierVersion: 'test' }, (l) => lines.push(l));
  const rec = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(rec.signals), [...SIGNAL_NAMES]);
  assert.ok(Object.values(rec.signals).every((v) => typeof v === 'boolean'));
});
