'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectSignals, matchesSignal, SIGNAL_NAMES } = require('../src/logos/intentSignals');
const { interpret } = require('../src/logos/intentIQ');
const { decide, buildPlan, shouldUseConversationSearch } = require('../src/decision/decisionEngine');
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

const CAPS = [{ id: 'hermes' }, { id: 'native' }, { id: 'conversation_search' }, { id: 'hindsight' }];
const ANCHORED = { meta: { reason: 'assistant_anchored_follow_up_unresolved_intent' } };
const stepCaps = (plan) => (plan ? plan.steps.map((st) => st.capability || st.mode) : []);

test('the engine defines no wording patterns of its own any more', () => {
  const engine = require('../src/decision/decisionEngine');
  assert.equal(engine.PLANNING_SIGNALS, undefined);
  assert.equal(engine.hasPlanningSignal, undefined);
});

test('engine follows intent.signals, not the raw text: a published signal plans a search the text alone would not', () => {
  const text = 'graag even terug naar dat ding van toen'; // no regex cue in the wording
  assert.equal(detectSignals(text).exactHistory, false);
  const plan = buildPlan({ userInput: text, intent: { intent: null, status: 'unknown', signals: { exactHistory: true } } });
  assert.ok(plan, 'a plan is built from the published signal');
  assert.ok(stepCaps(plan).includes('conversation_search'));
});

test('engine follows intent.signals, not the raw text: a published "false" wins over wording that would match', () => {
  const text = 'wat zei ik daar precies over?'; // the detector would say exactHistory
  assert.equal(detectSignals(text).exactHistory, true);
  const plan = buildPlan({ userInput: text, intent: { intent: null, status: 'unknown', signals: { exactHistory: false } } });
  assert.equal(plan, null);
});

test('conversation search follows the published lookup signal for anchored turns', () => {
  assert.equal(shouldUseConversationSearch({ ...ANCHORED, signals: { lookup: true } }, 'het is tijd dat ik eerst chronicle afmaak'), true);
  assert.equal(shouldUseConversationSearch({ ...ANCHORED, signals: { lookup: false } }, 'wat was er in juni ook alweer?'), false);
});

test('without published signals (IntentIQ did not run) the engine asks the IntentIQ detector — same answers as before', () => {
  assert.equal(shouldUseConversationSearch(ANCHORED, 'wat was er in juni ook alweer?'), true);
  assert.equal(shouldUseConversationSearch(ANCHORED, 'nu weer bezig met de ontwikkeling van chronicle en jou'), false);
  const plan = buildPlan({ userInput: 'wat zei ik daar precies over?', intent: null });
  assert.ok(plan && stepCaps(plan).includes('conversation_search'));
  assert.equal(decide({ userInput: 'hoi', intent: null, availableCapabilities: CAPS }).action, 'native');
});

test('end to end: interpret() then decide() — the engine consumes what IntentIQ published', async () => {
  const intent = await interpret(
    [{ role: 'user', content: 'wat zei ik daar precies over?' }],
    { silent: true, model: NO_MODEL },
  );
  assert.equal(intent.signals.exactHistory, true);
  const decision = decide({ userInput: 'wat zei ik daar precies over?', intent, availableCapabilities: CAPS });
  assert.equal(decision.action, 'plan');
  assert.ok(stepCaps(decision).includes('conversation_search'));
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
