'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, isNativeTurn, mapReasoningLevel, usedContextSources } = require('../src/decision/decisionEngine');
const { ACTIONS, REASONING_LEVELS, validateDecision } = require('../src/decision/decisionSchema');

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

test('decide() selects "native" for conversational turns when native capability is available', () => {
  const cases = [
    { intent: null },
    { intent: { intent: 'converse', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' } },
    { intent: { intent: 'meta.relational', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' } },
    { intent: { intent: 'some.unknown.intent', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' } },
  ];
  for (const c of cases) {
    const decision = decide({ userInput: 'x', ...c, availableCapabilities: [{ id: 'hermes' }, { id: 'native' }] });
    assert.equal(decision.action, 'native');
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

test('decide() routes missing IntentIQ decision (null intent) to native when available', () => {
  const decision = decide({ userInput: 'hello', intent: null, reasoning: null, availableCapabilities: [{ id: 'hermes' }, { id: 'native' }] });
  assert.equal(decision.action, 'native');
});

test('decide() falls back to hermes for missing IntentIQ decision when native is not in availableCapabilities', () => {
  const decision = decide({ userInput: 'hello', intent: null, reasoning: null, availableCapabilities: [{ id: 'hermes' }] });
  assert.equal(decision.action, 'capability');
  assert.equal(decision.capability, 'hermes');
});

test('decide() routes complex intents to hermes even when native is available', () => {
  const decision = decide({
    userInput: 'explain this',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.equal(decision.action, 'capability');
  assert.equal(decision.capability, 'hermes');
});

test('decide() routes deep reasoning to hermes even when native is available', () => {
  const decision = decide({
    userInput: 'hello',
    intent: { intent: 'converse', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    reasoning: { reasoningDepth: 'deep' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.equal(decision.action, 'capability');
  assert.equal(decision.capability, 'hermes');
});

test('isNativeTurn returns true for conversational intents and false for complex ones', () => {
  assert.equal(isNativeTurn(null, null), true);
  assert.equal(isNativeTurn({ intent: 'converse' }, null), true);
  assert.equal(isNativeTurn({ intent: 'meta.relational' }, null), true);
  assert.equal(isNativeTurn({ intent: 'greet' }, null), true);
  assert.equal(isNativeTurn({ intent: 'farewell' }, null), true);
  assert.equal(isNativeTurn({ intent: 'acknowledge' }, null), true);
  assert.equal(isNativeTurn({ sourceOfTruth: 'conversation' }, null), true);
  assert.equal(isNativeTurn({ intent: 'inform.explain', sourceOfTruth: 'external_knowledge' }, null), false);
  assert.equal(isNativeTurn({ intent: 'converse' }, { reasoningDepth: 'deep' }), false);
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
  assert.deepEqual(
    Object.keys(decision).sort(),
    ['action', 'capability', 'capability_candidate', 'capability_execute', 'input', 'reason', 'task', 'context', 'reasoning', 'capabilities'].sort()
  );
});

// --- Architectural invariant: TTS plays no role in the Decision Engine -----

test('decisionEngine.js has no code-level dependency on TTS/speech — voice is presentation-only, never a routing signal', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/decision/decisionEngine.js'), 'utf-8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(!/mimoTts|speech|\btts\b/i.test(codeOnly), 'decisionEngine.js must not reference TTS/speech');
});

// --- decision-as-plan: context / reasoning / capabilities -----------------

test('decisionSchema exposes the three reasoning levels', () => {
  assert.deepEqual(REASONING_LEVELS, ['none', 'light', 'deep']);
});

test('mapReasoningLevel interprets ReasonIQ output without re-classifying it', () => {
  assert.equal(mapReasoningLevel(null), 'none');
  assert.equal(mapReasoningLevel(undefined), 'none');
  assert.equal(mapReasoningLevel({ reasoningDepth: 'shallow' }), 'light');
  assert.equal(mapReasoningLevel({ reasoningDepth: 'deep' }), 'deep');
});

test('usedContextSources reports hindsight only when reflections or mental models are actually non-empty', () => {
  assert.deepEqual(usedContextSources(null), []);
  assert.deepEqual(usedContextSources(undefined), []);
  assert.deepEqual(usedContextSources({}), []);
  assert.deepEqual(usedContextSources({ reflections: [], mentalModels: [] }), []);
  assert.deepEqual(usedContextSources({ reflections: [{ text: 'x' }] }), ['hindsight']);
  assert.deepEqual(usedContextSources({ mentalModels: [{ id: 'm' }] }), ['hindsight']);
});

test('decide() always attaches context/reasoning/capabilities, even on the plainest native turn (test #1: native without context)', () => {
  const decision = decide({
    userInput: 'hi',
    intent: null,
    context: null,
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.equal(decision.action, 'native');
  assert.deepEqual(decision.context, []);
  assert.equal(decision.reasoning, 'none');
  assert.deepEqual(decision.capabilities, []);
});

test('decide() reports context: ["hindsight"] on a native decision when Hindsight actually returned something (test #2: native with Hindsight context)', () => {
  const decision = decide({
    userInput: 'hoi Gaia',
    intent: { intent: 'converse', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    context: { reflections: [{ text: 'Bo prefers async updates' }], mentalModels: [] },
    reasoning: { reasoningDepth: 'shallow' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.equal(decision.action, 'native');
  assert.deepEqual(decision.context, ['hindsight']);
  assert.equal(decision.reasoning, 'light');
  assert.deepEqual(decision.capabilities, []);
});

test('decide() routes a personal-memory-sourced turn to native, not Hermes — Hindsight supplies context, never the answer (test #8)', () => {
  const decision = decide({
    userInput: 'wat weet je nog van mij en Luca?',
    intent: { intent: 'memory.inspect', status: 'accepted', needsClarification: false, sourceOfTruth: 'memory' },
    context: { reflections: [{ text: 'Bo and Luca worked on a project together' }], mentalModels: [] },
    reasoning: { reasoningDepth: 'shallow' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.equal(decision.action, 'native');
  assert.notEqual(decision.action, 'capability');
  assert.deepEqual(decision.context, ['hindsight']);
  assert.deepEqual(decision.capabilities, []);
});

test('decide() combines Hindsight context with a Hermes decision under deep reasoning (test #3 + #9)', () => {
  const decision = decide({
    userInput: 'analyseer mijn Gaia-architectuur op race conditions',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    context: { reflections: [{ text: "Bo's Gaia architecture uses a Decision Engine" }], mentalModels: [] },
    reasoning: { reasoningDepth: 'deep' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.equal(decision.action, 'capability');
  assert.equal(decision.capability, 'hermes');
  assert.deepEqual(decision.context, ['hindsight']);
  assert.equal(decision.reasoning, 'deep');
  assert.deepEqual(decision.capabilities, ['hermes']);
});

test('decide() routes current-external-information turns to the web tool when available (test #4)', () => {
  const decision = decide({
    userInput: 'what is the current OpenAI API documentation?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }, { id: 'web' }],
  });
  assert.equal(decision.action, 'tool');
  assert.equal(decision.capability, 'web');
  assert.deepEqual(decision.capabilities, ['web']);
});

test('decide() falls back to Hermes for external-knowledge turns when no web tool is available (test #7: capability availability)', () => {
  const decision = decide({
    userInput: 'what is the current OpenAI API documentation?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.equal(decision.action, 'capability');
  assert.equal(decision.capability, 'hermes');
});

test('decide() still clarifies ambiguous turns regardless of context/reasoning (test #5)', () => {
  const decision = decide({
    userInput: 'draft it and send it',
    intent: { intent: 'create.generate', status: 'ambiguous', needsClarification: true, sourceOfTruth: 'conversation' },
    context: { reflections: [{ text: 'x' }] },
    reasoning: { reasoningDepth: 'shallow' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.equal(decision.action, 'clarify');
});

test('validateDecision accepts a full plan and rejects malformed context/reasoning/capabilities', () => {
  assert.equal(
    validateDecision({ action: 'native', context: ['hindsight'], reasoning: 'light', capabilities: [] }),
    null
  );
  assert.match(validateDecision({ action: 'native', context: 'hindsight' }), /context must be an array/);
  assert.match(validateDecision({ action: 'native', reasoning: 'medium' }), /reasoning must be one of/);
  assert.match(validateDecision({ action: 'native', capabilities: 'hermes' }), /capabilities must be an array/);
});

// --- v2.2: meta-intent priority (spec §2) --------------------------------

test('decide() routes meta.question to native — no capability invoked', () => {
  const decision = decide({
    userInput: 'waarom koos je voor websearch?',
    intent: { intent: 'meta.question', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'web' }],
  });
  assert.equal(decision.action, 'native');
  assert.equal(decision.capability_candidate, null);
  assert.equal(decision.capability_execute, false);
  assert.match(decision.reason, /meta-intent/);
});

test('decide() routes meta.correction to native — no capability invoked', () => {
  const decision = decide({
    userInput: 'nee, ik bedoel iets anders',
    intent: { intent: 'meta.correction', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'web' }],
  });
  assert.equal(decision.action, 'native');
  assert.equal(decision.capability_candidate, null);
  assert.equal(decision.capability_execute, false);
});

test('decide() routes meta.capability_question to native — no capability invoked', () => {
  const decision = decide({
    userInput: 'waarom gebruikte je hindsight?',
    intent: { intent: 'meta.capability_question', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'web' }],
  });
  assert.equal(decision.action, 'native');
  assert.equal(decision.capability_candidate, null);
  assert.equal(decision.capability_execute, false);
});

// --- v2.2: capability gate (spec §8-9) -----------------------------------

test('decide() sets capability_execute=true for tool/web/capability actions', () => {
  const toolDecision = decide({
    userInput: 'send this to Bo',
    intent: { intent: 'act.perform', status: 'accepted', needsClarification: false, sourceOfTruth: 'tool' },
    availableCapabilities: [{ id: 'tool' }],
  });
  assert.equal(toolDecision.capability_execute, true);
  assert.equal(toolDecision.capability_candidate, 'tool');

  const webDecision = decide({
    userInput: 'what is the weather?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    availableCapabilities: [{ id: 'web' }],
  });
  assert.equal(webDecision.capability_execute, true);
  assert.equal(webDecision.capability_candidate, 'web');

  const hermesDecision = decide({
    userInput: 'explain quantum computing in depth',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    availableCapabilities: [{ id: 'hermes' }],
  });
  assert.equal(hermesDecision.capability_execute, true);
  assert.equal(hermesDecision.capability_candidate, 'hermes');
});

test('decide() sets capability_execute=false for native/clarify actions', () => {
  const nativeDecision = decide({
    userInput: 'hello there',
    intent: { intent: 'converse', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    availableCapabilities: [{ id: 'native' }],
  });
  assert.equal(nativeDecision.capability_execute, false);
  assert.equal(nativeDecision.capability_candidate, null);

  const clarifyDecision = decide({
    userInput: 'draft it and send it',
    intent: { intent: 'create.generate', status: 'ambiguous', needsClarification: true },
    availableCapabilities: [{ id: 'hermes' }],
  });
  assert.equal(clarifyDecision.capability_execute, false);
  assert.equal(clarifyDecision.capability_candidate, null);
});
