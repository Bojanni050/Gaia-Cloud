'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, isNativeTurn, mapReasoningLevel, usedContextSources, shouldUseConversationSearch } = require('../src/decision/decisionEngine');
const { matchRequiredSkills } = require('../src/decision/skillMatching');
const { ACTIONS, REASONING_LEVELS, PATTERN_USAGE_MODES, validateDecision } = require('../src/decision/decisionSchema');

test('decisionSchema exposes exactly the allowed actions — five originals plus the 3.0 plan action', () => {
  assert.deepEqual(ACTIONS, ['native', 'capability', 'tool', 'clarify', 'refuse', 'plan']);
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

test('decide() routes complex intents to native when native is available (Generation Policy 0.1: native is default)', () => {
  const decision = decide({
    userInput: 'explain this',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.equal(decision.action, 'native');
  assert.equal(decision.generationMode, 'native');
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
    ['action', 'capabilities', 'capability', 'capability_candidate', 'capability_execute', 'context', 'expected_outcome', 'generationMode', 'input', 'reason', 'reasoning', 'task'].sort()
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

test('decide() routes current-external-information turns to a web→native plan (test #4)', () => {
  const decision = decide({
    userInput: 'what is the current OpenAI API documentation?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }, { id: 'web' }],
  });
  assert.equal(decision.action, 'plan');
  const caps = decision.steps.map((s) => s.capability || s.mode);
  assert.ok(caps.includes('web'), 'plan must include a web retrieval step');
  assert.ok(caps.includes('native'), 'plan must end with native generation');
  assert.equal(validateDecision(decision), null);
});

test('decide() falls back to native for external-knowledge turns when no web tool is available (Generation Policy 0.1: native is default)', () => {
  const decision = decide({
    userInput: 'what is the current OpenAI API documentation?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.equal(decision.action, 'native');
  assert.equal(decision.generationMode, 'native');
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

// --- Pattern Awareness 0.1: patternUsage schema + decision ownership ---------

const ESTABLISHED_PATTERN = {
  id: 'pattern-1',
  statement: 'Bo lijkt vaker langdurig creatief te werken na technische doorbraken.',
  status: 'established',
  confidence: 0.85,
  hypothesisIds: ['hyp-a', 'hyp-b'],
  persistence: 'durable',
  sourceRef: 'ptf_1',
  relevance: 0.88,
};

test('patternUsage modes are exactly the three the spec names', () => {
  assert.deepEqual(PATTERN_USAGE_MODES, ['ignore', 'use_as_context', 'mention_as_observation']);
});

test('decide() judges offered patterns itself — established + relevant becomes usable context', () => {
  const decision = decide({
    userInput: 'ik ga zo weer creatief werken aan Melodiq',
    intent: { intent: 'converse', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    context: { reflections: [], mentalModels: [], patterns: [ESTABLISHED_PATTERN] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.ok(decision.patternUsage, 'the decision owns pattern usage');
  assert.notEqual(decision.patternUsage.mode, 'ignore');
  assert.deepEqual(decision.patternUsage.patterns, ['pattern-1']); // provenance preserved
  assert.equal(validateDecision(decision), null);
});

test('decide() never lets a candidate pattern become user-facing — default is ignore', () => {
  const decision = decide({
    userInput: 'vertel over mijn creatieve werkritme aub',
    intent: { intent: 'converse', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    context: { reflections: [], mentalModels: [], patterns: [{ ...ESTABLISHED_PATTERN, status: 'candidate' }] },
    reasoning: null,
    availableCapabilities: [{ id: 'native' }],
  });
  assert.equal(decision.patternUsage.mode, 'ignore');
  assert.deepEqual(decision.patternUsage.mentions, []);
});

test('mention_as_observation requires the engine to choose it — never implied by retrieval alone', () => {
  const decision = decide({
    userInput: 'zag je hoe ik werk na doorbraken?',
    intent: null,
    context: { reflections: [], mentalModels: [], patterns: [ESTABLISHED_PATTERN] },
    reasoning: null,
    availableCapabilities: [{ id: 'native' }],
  });
  const usage = decision.patternUsage;
  if (usage.mode === 'mention_as_observation') {
    assert.equal(usage.mentions.length, 1);
    assert.equal(usage.mentions[0].phrasing, 'tentative');
    assert.deepEqual(usage.patterns, [usage.mentions[0].patternId]);
  } else {
    // use_as_context is the safe floor; mention must have been withheld deliberately
    assert.equal(usage.mode, 'use_as_context');
  }
  assert.equal(validateDecision(decision), null);
});

test('validateDecision rejects malformed patternUsage shapes', () => {
  assert.match(validateDecision({ action: 'native', patternUsage: 'nope' }), /patternUsage must be an object/);
  assert.match(validateDecision({ action: 'native', patternUsage: { mode: 'shout' } }), /mode must be one of/);
  assert.match(validateDecision({ action: 'native', patternUsage: { mode: 'ignore', patterns: 'x' } }), /patterns must be an array/);
  assert.match(
    validateDecision({ action: 'native', patternUsage: { mode: 'ignore', patterns: [], mentions: [{}] } }),
    /mentions entry requires/
  );
  assert.match(
    validateDecision({ action: 'native', patternUsage: { mode: 'ignore', patterns: [], decisions: [{ patternId: 'p' }] } }),
    /decisions entry requires/
  );
  assert.equal(
    validateDecision({ action: 'native', patternUsage: { mode: 'use_as_context', patterns: ['pattern-1'], contextPatternIds: ['pattern-1'], mentions: [], decisions: [] } }),
    null
  );
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

  // web now routes to a plan [web→native]; capability_execute=false (plan)
  const webDecision = decide({
    userInput: 'what is the weather?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }, { id: 'web' }],
  });
  assert.equal(webDecision.action, 'plan');
  assert.equal(webDecision.capability_execute, false);
  assert.ok(webDecision.steps.some((s) => s.capability === 'web'), 'plan must include web step');

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

// --- conversation_search: Decision Engine routing (v0.1, deliberately narrow) --

const ANCHORED_INTENT = {
  schemaVersion: 'intentiq.v1',
  intent: null,
  status: 'unknown',
  sourceOfTruth: 'memory',
  referents: [{ expression: 'juni', resolvedTo: 'previous_assistant_turn:juni', confidence: 0.6, source: 'previous_assistant_turn' }],
  meta: { reason: 'assistant_anchored_follow_up_unresolved_intent' },
};

test('conversation_search policy fires only on assistant-anchored follow-up reasons', () => {
  assert.equal(shouldUseConversationSearch(ANCHORED_INTENT), true);
  assert.equal(shouldUseConversationSearch({
    intent: 'memory.inspect', status: 'accepted', sourceOfTruth: 'memory',
    meta: { reason: 'direct_signal' },
  }), false);
  assert.equal(shouldUseConversationSearch({ intent: null, status: 'unknown' }), false);
  assert.equal(shouldUseConversationSearch(null), false);
});

test('Decision Engine 3.1 exposes requiredSkills separately from capabilities', () => {
  const decision = decide({
    userInput: 'Zoek uit waarom deze race condition optreedt.',
    intent: null,
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.deepEqual(decision.requiredSkills, ['systematic-debugging']);
  assert.equal(decision.steps[0].capability, 'hermes');
  assert.equal(decision.steps[0].skill, 'systematic-debugging');
  assert.deepEqual(decision.requiredCapabilities, ['hermes']);
});

test('required skill matching uses registry routing flags and does not route explanations', () => {
  const available = [{ id: 'hermes' }, { id: 'native' }];
  assert.equal(matchRequiredSkills({ task: 'Wat betekent systematic-debugging?', availableCapabilities: available }).confidence, 'none');
  assert.deepEqual(matchRequiredSkills({ task: 'Maak een teststrategie voor deze wijziging.', availableCapabilities: available }).requiredSkills, ['test-driven-development']);
  assert.deepEqual(matchRequiredSkills({ task: 'Help mij met grounded citations voor dit antwoord.', availableCapabilities: available }).requiredSkills, []);
});

test('decide() routes an anchored follow-up to a conversation_search → native plan', () => {
  const decision = decide({
    userInput: 'wat was er in juni ook alweer?',
    intent: ANCHORED_INTENT,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }, { id: 'conversation_search' }],
  });
  assert.equal(decision.action, 'plan');
  // The plan must always end with native generation — conversation_search
  // is retrieval PRESENTATION, not answer generation.
  const stepTypes = decision.steps.map((s) => s.type);
  const stepCaps = decision.steps.map((s) => s.capability || s.mode);
  assert.ok(stepTypes.includes('retrieval'), 'plan must include a retrieval step');
  assert.ok(stepTypes.includes('generation'), 'plan must include a generation step');
  assert.ok(stepCaps.includes('conversation_search'), 'retrieval step must use conversation_search');
  assert.ok(stepCaps.includes('native'), 'generation step must use native');
  // Last step must be generation (Gaia speaks, not raw passages)
  assert.equal(decision.steps[decision.steps.length - 1].type, 'generation');
  assert.equal(decision.steps[decision.steps.length - 1].mode, 'native');
  assert.equal(validateDecision(decision), null);
});

test('decide() falls back to existing routing when conversation_search is not registered', () => {
  const decision = decide({
    userInput: 'wat was er in juni ook alweer?',
    intent: ANCHORED_INTENT,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.notEqual(decision.capability, 'conversation_search');
  assert.equal(validateDecision(decision), null);
});

test('decide() keeps ordinary memory.inspect turns on their existing routing', () => {
  const decision = decide({
    userInput: 'What have you noticed about how I work?',
    intent: { intent: 'memory.inspect', status: 'accepted', needsClarification: false, sourceOfTruth: 'memory' },
    context: { reflections: [{ text: 'Bo prefers async updates' }], mentalModels: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }, { id: 'conversation_search' }],
  });
  assert.notEqual(decision.capability, 'conversation_search');
});

// --- conversation_search composition: always ends with native generation ---

test('conversation_search plan always ends with native generation (architectural invariant)', () => {
  const anchored = {
    schemaVersion: 'intentiq.v1', intent: null, status: 'unknown',
    sourceOfTruth: 'memory',
    referents: [{ expression: 'juni', resolvedTo: 'previous_assistant_turn:juni', confidence: 0.6, source: 'previous_assistant_turn' }],
    meta: { reason: 'assistant_anchored_follow_up_unresolved_intent' },
  };
  const d = decide({
    userInput: 'wat was er in juni ook alweer?',
    intent: anchored,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }, { id: 'conversation_search' }],
  });
  assert.equal(d.action, 'plan');
  const lastStep = d.steps[d.steps.length - 1];
  assert.equal(lastStep.type, 'generation');
  assert.equal(lastStep.mode, 'native');
  // Raw conversation_search output must never be the final user-facing answer
  assert.notEqual(d.steps[d.steps.length - 1].capability, 'conversation_search');
});

test('conversation_search plan includes retrieval step with correct scope', () => {
  const anchored = {
    schemaVersion: 'intentiq.v1', intent: null, status: 'unknown',
    sourceOfTruth: 'memory',
    referents: [{ expression: 'juni', resolvedTo: 'previous_assistant_turn:juni', confidence: 0.6, source: 'previous_assistant_turn' }],
    meta: { reason: 'assistant_anchored_follow_up_inherited' },
  };
  const d = decide({
    userInput: 'wat was er in juni ook alweer?',
    intent: anchored,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }, { id: 'conversation_search' }],
  });
  const csStep = d.steps.find((s) => s.capability === 'conversation_search');
  assert.ok(csStep, 'plan must include conversation_search step');
  assert.equal(csStep.type, 'retrieval');
  // Anchored follow-ups pin scope to 'current' — the anchor is from THIS conversation
  assert.equal(csStep.input.scope, 'current');
  assert.match(csStep.input.query, /juni/);
});

test('conversation_search fallback: when conversation_search is not registered, routes to native', () => {
  const anchored = {
    schemaVersion: 'intentiq.v1', intent: null, status: 'unknown',
    sourceOfTruth: 'memory',
    referents: [],
    meta: { reason: 'assistant_anchored_follow_up_unresolved_intent' },
  };
  const d = decide({
    userInput: 'wat was er in juni ook alweer?',
    intent: anchored,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  // Without conversation_search registered, falls through to native
  assert.equal(d.action, 'native');
});

test('raw conversation_search output is never returned as final user-facing answer', () => {
  // This is the architectural invariant: conversation_search retrieves,
  // native generates. The user never sees raw passages.
  const anchored = {
    schemaVersion: 'intentiq.v1', intent: null, status: 'unknown',
    sourceOfTruth: 'memory',
    referents: [{ expression: 'juni', resolvedTo: 'previous_assistant_turn:juni', confidence: 0.6, source: 'previous_assistant_turn' }],
    meta: { reason: 'assistant_anchored_follow_up_inherited' },
  };
  const d = decide({
    userInput: 'wat was er in juni ook alweer?',
    intent: anchored,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }, { id: 'conversation_search' }],
  });
  // The plan's last step must be generation, not a capability
  const lastStep = d.steps[d.steps.length - 1];
  assert.equal(lastStep.type, 'generation');
  assert.equal(lastStep.mode, 'native');
});
