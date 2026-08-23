'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../src/decision/decisionEngine');
const { ACTIONS, validateDecision } = require('../src/decision/decisionSchema');

test('decisionSchema exposes exactly the five allowed actions', () => {
  assert.deepEqual(ACTIONS, ['native', 'capability', 'tool', 'clarify', 'refuse']);
});

test('validateDecision rejects an unknown action', () => {
  assert.match(validateDecision({ action: 'wizardry' }), /must be one of/);
});

test('validateDecision requires a capability id for capability/tool actions', () => {
  assert.match(validateDecision({ action: 'capability' }), /requires a non-empty decision\.capability/);
  assert.match(validateDecision({ action: 'tool' }), /requires a non-empty decision\.capability/);
  assert.equal(validateDecision({ action: 'capability', capability: 'hermes' }), null);
});

test('validateDecision accepts native/clarify/refuse with no capability field', () => {
  assert.equal(validateDecision({ action: 'native' }), null);
  assert.equal(validateDecision({ action: 'clarify' }), null);
  assert.equal(validateDecision({ action: 'refuse' }), null);
});

test('decide() routes to clarify when IntentIQ flagged the turn as needing clarification', () => {
  const decision = decide({
    userInput: 'draft it and send it',
    intent: { intent: 'create.generate', status: 'ambiguous', needsClarification: true, sourceOfTruth: 'conversation' },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }],
  });
  assert.equal(decision.action, 'clarify');
  assert.equal(validateDecision(decision), null);
});

test('decide() routes to the tool capability when IntentIQ resolved sourceOfTruth to "tool" and one is available', () => {
  const decision = decide({
    userInput: 'send this to Bo',
    intent: { intent: 'act.perform', status: 'accepted', needsClarification: false, sourceOfTruth: 'tool', entities: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'tool' }],
  });
  assert.equal(decision.action, 'tool');
  assert.equal(decision.capability, 'tool');
  assert.equal(validateDecision(decision), null);
});

test('decide() falls back to the hermes capability when sourceOfTruth is "tool" but no tool capability is available', () => {
  const decision = decide({
    userInput: 'send this to Bo',
    intent: { intent: 'act.perform', status: 'accepted', needsClarification: false, sourceOfTruth: 'tool', entities: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }],
  });
  assert.equal(decision.action, 'capability');
  assert.equal(decision.capability, 'hermes');
});

test('decide() routes accepted, non-tool turns to the hermes capability', () => {
  const decision = decide({
    userInput: 'why is my website crashing?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    reasoning: { reasoningDepth: 'shallow' },
    availableCapabilities: [{ id: 'hermes' }],
  });
  assert.equal(decision.action, 'capability');
  assert.equal(decision.capability, 'hermes');
  assert.equal(decision.task, 'inform.explain');
});

test('decide() never selects "native" — no non-Hermes generator exists in this codebase yet', () => {
  // A broad sweep of plausible inputs — none of them should ever produce
  // `native`, since Response Engine has nothing to generate native text
  // with today. See decisionEngine.js's module note.
  const cases = [
    { intent: null },
    { intent: { status: 'unknown', needsClarification: false, sourceOfTruth: 'unknown' } },
    { intent: { intent: 'converse', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' } },
    { intent: { intent: 'meta.relational', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' } },
  ];
  for (const c of cases) {
    const decision = decide({ userInput: 'x', ...c, availableCapabilities: [{ id: 'hermes' }] });
    assert.notEqual(decision.action, 'native');
  }
});

test('decide() never selects "refuse" in v0.1 — no policy/safety signal feeds it yet', () => {
  const decision = decide({
    userInput: 'anything at all',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    availableCapabilities: [{ id: 'hermes' }],
  });
  assert.notEqual(decision.action, 'refuse');
});

test('decide() treats a missing IntentIQ decision (null intent) as a safe default to the hermes capability', () => {
  const decision = decide({ userInput: 'hello', intent: null, reasoning: null, availableCapabilities: [{ id: 'hermes' }] });
  assert.equal(decision.action, 'capability');
  assert.equal(decision.capability, 'hermes');
});

test('decide() clarifies when no capability at all can answer the turn', () => {
  const decision = decide({
    userInput: 'hello',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    availableCapabilities: [],
  });
  assert.equal(decision.action, 'clarify');
});

test('decide() never produces a "useHermes"-shaped flag — only the schema\'s fields', () => {
  const decision = decide({
    userInput: 'why is my website crashing?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    availableCapabilities: [{ id: 'hermes' }],
  });
  assert.ok(!('useHermes' in decision));
  assert.deepEqual(Object.keys(decision).sort(), ['action', 'capability', 'input', 'reason', 'task'].sort());
});
