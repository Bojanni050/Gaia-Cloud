'use strict';

/**
 * Generation Policy 0.1 tests.
 *
 * Covers: native default, Hermes with deep reasoning, Hermes with skill,
 * multi-source synthesis, Hermes+native composition, unnecessary Hermes
 * prevention, capability availability fallback, streaming/non-streaming parity.
 *
 * Core rule: Gaia speaks natively by default. Hermes is a specialized
 * capability that Gaia explicitly chooses when specialized reasoning, a
 * verified skill, or multi-source synthesis requires it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideGenerationMode, isNativeEligible, NATIVE_INTENTS } = require('../src/decision/generationPolicy');
const { decide } = require('../src/decision/decisionEngine');
const { GENERATION_POLICY_MODES, validateDecision } = require('../src/decision/decisionSchema');

const FULL_REGISTRY = [
  { id: 'hermes' }, { id: 'native' }, { id: 'web' },
  { id: 'conversation_search' }, { id: 'hindsight' },
];

// --- decideGenerationMode: unit tests ------------------------------------------

test('generationPolicy exports exactly the three modes', () => {
  assert.deepEqual([...GENERATION_POLICY_MODES], ['native', 'hermes', 'plan']);
});

test('decideGenerationMode returns native for null intent and null reasoning', () => {
  const result = decideGenerationMode({ intent: null, reasoning: null });
  assert.equal(result.mode, 'native');
  assert.ok(typeof result.reason === 'string');
});

test('decideGenerationMode returns hermes for deep reasoning', () => {
  const result = decideGenerationMode({
    intent: { intent: 'inform.explain', sourceOfTruth: 'external_knowledge' },
    reasoning: { reasoningDepth: 'deep' },
  });
  assert.equal(result.mode, 'hermes');
  assert.match(result.reason, /deep reasoning/);
});

test('decideGenerationMode returns hermes when a skill is selected', () => {
  const result = decideGenerationMode({
    intent: null,
    reasoning: null,
    selectedSkill: 'systematic-debugging',
  });
  assert.equal(result.mode, 'hermes');
  assert.match(result.reason, /systematic-debugging/);
});

test('decideGenerationMode returns plan when hasPlan is true', () => {
  const result = decideGenerationMode({ hasPlan: true });
  assert.equal(result.mode, 'plan');
  assert.match(result.reason, /plan/);
});

test('decideGenerationMode returns native for conversational intents', () => {
  for (const intent of ['converse', 'greet', 'farewell', 'acknowledge', 'meta.relational']) {
    const result = decideGenerationMode({
      intent: { intent, sourceOfTruth: 'conversation' },
      reasoning: null,
    });
    assert.equal(result.mode, 'native', `expected native for intent: ${intent}`);
  }
});

test('decideGenerationMode returns native for memory-sourced turns', () => {
  const result = decideGenerationMode({
    intent: { intent: 'memory.inspect', sourceOfTruth: 'memory' },
    reasoning: null,
  });
  assert.equal(result.mode, 'native');
});

test('decideGenerationMode precedence: deep reasoning beats native eligibility', () => {
  const result = decideGenerationMode({
    intent: { intent: 'converse', sourceOfTruth: 'conversation' },
    reasoning: { reasoningDepth: 'deep' },
  });
  assert.equal(result.mode, 'hermes');
});

test('decideGenerationMode precedence: selected skill beats native eligibility', () => {
  const result = decideGenerationMode({
    intent: { intent: 'converse', sourceOfTruth: 'conversation' },
    reasoning: null,
    selectedSkill: 'systematic-debugging',
  });
  assert.equal(result.mode, 'hermes');
});

test('decideGenerationMode precedence: plan beats everything', () => {
  const result = decideGenerationMode({
    intent: { intent: 'converse', sourceOfTruth: 'conversation' },
    reasoning: { reasoningDepth: 'deep' },
    selectedSkill: 'systematic-debugging',
    hasPlan: true,
  });
  assert.equal(result.mode, 'plan');
});

// --- isNativeEligible: unit tests -----------------------------------------------

test('isNativeEligible returns true for null intent', () => {
  assert.equal(isNativeEligible(null, null), true);
});

test('isNativeEligible returns true for unknown status', () => {
  assert.equal(isNativeEligible({ intent: null, status: 'unknown' }, null), true);
});

test('isNativeEligible returns true for conversational intents', () => {
  for (const intent of NATIVE_INTENTS) {
    assert.equal(isNativeEligible({ intent }, null), true, `expected native for: ${intent}`);
  }
});

test('isNativeEligible returns false for deep reasoning', () => {
  assert.equal(isNativeEligible(null, { reasoningDepth: 'deep' }), false);
});

test('isNativeEligible returns true for conversation sourceOfTruth', () => {
  assert.equal(isNativeEligible({ sourceOfTruth: 'conversation' }, null), true);
});

test('isNativeEligible returns true for memory sourceOfTruth', () => {
  assert.equal(isNativeEligible({ sourceOfTruth: 'memory' }, null), true);
});

test('isNativeEligible returns false for non-conversational intent without matching sourceOfTruth', () => {
  assert.equal(isNativeEligible({ intent: 'inform.explain', sourceOfTruth: 'external_knowledge' }, null), false);
});

// --- decide() integration: Generation Policy 0.1 routing ------------------------

test('native default: "Hoi Gaia" → native', () => {
  const d = decide({ userInput: 'Hoi Gaia', intent: null, reasoning: null, availableCapabilities: FULL_REGISTRY });
  assert.equal(d.action, 'native');
  assert.equal(d.generationMode, 'native');
  assert.equal(validateDecision(d), null);
});

test('native default: "Wat vind je hiervan?" → native', () => {
  const d = decide({
    userInput: 'Wat vind je hiervan?',
    intent: { intent: 'converse', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.equal(d.action, 'native');
  assert.equal(d.generationMode, 'native');
});

test('native default: "Hoe gaat het?" → native', () => {
  const d = decide({
    userInput: 'Hoe gaat het?',
    intent: { intent: 'greet', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.equal(d.action, 'native');
  assert.equal(d.generationMode, 'native');
});

test('deep reasoning: complex architecture analysis → Hermes (direct or via plan)', () => {
  const d = decide({
    userInput: 'Analyseer mijn Gaia-architectuur op race conditions',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    reasoning: { reasoningDepth: 'deep' },
    availableCapabilities: FULL_REGISTRY,
  });
  // The input matches the analysisRequest planning signal, so it may become
  // a plan with hermes + native. Both are valid: the key is that hermes IS
  // used for the deep reasoning.
  if (d.action === 'plan') {
    const hermesStep = d.steps.find((s) => s.capability === 'hermes');
    assert.ok(hermesStep, 'plan should include a hermes step for deep reasoning');
    assert.equal(d.generationMode, 'plan');
  } else {
    assert.equal(d.action, 'capability');
    assert.equal(d.capability, 'hermes');
    assert.equal(d.generationMode, 'hermes');
  }
});

test('Hermes skill: systematic debugging → Hermes + skill', () => {
  const d = decide({
    userInput: 'Waarom crasht mijn applicatie steeds?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  // The plan builder detects the skill task and creates a plan
  if (d.action === 'plan') {
    const hermesStep = d.steps.find((s) => s.capability === 'hermes');
    assert.ok(hermesStep, 'plan should include a hermes step');
    assert.equal(hermesStep.skill, 'systematic-debugging');
    assert.equal(d.generationMode, 'plan');
  } else {
    // Fallback: direct hermes with skill
    assert.equal(d.action, 'capability');
    assert.equal(d.capability, 'hermes');
    assert.equal(d.generationMode, 'hermes');
  }
});

test('deep reasoning + Gaia voice: complex analysis → Hermes reasoning + native generation', () => {
  const d = decide({
    userInput: 'Analyseer deze codebase op architectuurproblemen en leg het daarna eenvoudig uit.',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    reasoning: { reasoningDepth: 'deep' },
    availableCapabilities: FULL_REGISTRY,
  });
  // Deep reasoning goes to hermes — either directly or via a plan that
  // includes hermes reasoning followed by native generation.
  if (d.action === 'plan') {
    const hermesStep = d.steps.find((s) => s.capability === 'hermes');
    assert.ok(hermesStep, 'plan should include a hermes step for deep reasoning');
    const lastStep = d.steps[d.steps.length - 1];
    assert.equal(lastStep.type, 'generation');
    assert.equal(lastStep.mode, 'native');
    assert.equal(d.generationMode, 'plan');
  } else {
    assert.equal(d.action, 'capability');
    assert.equal(d.capability, 'hermes');
    assert.equal(d.generationMode, 'hermes');
    assert.equal(d.reasoning, 'deep');
  }
});

test('multi-source synthesis: conversation_search + hindsight → plan with native final', () => {
  const d = decide({
    userInput: 'Wat weet je nog van mijn Gaia-plannen en wat zei ik daar vorige maand precies over?',
    intent: null,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.equal(d.action, 'plan');
  assert.equal(d.generationMode, 'plan');
  // Final step should be native
  const lastStep = d.steps[d.steps.length - 1];
  assert.equal(lastStep.type, 'generation');
  assert.equal(lastStep.mode, 'native');
});

test('native should win: turns where Hermes is available but no specialized reasoning required → native', () => {
  const cases = [
    { userInput: 'Hallo daar', intent: null },
    { userInput: 'Wat is jouw mening?', intent: { intent: 'converse', sourceOfTruth: 'conversation' } },
    { userInput: 'Bedankt!', intent: { intent: 'acknowledge', sourceOfTruth: 'conversation' } },
    { userInput: 'Tot ziens', intent: { intent: 'farewell', sourceOfTruth: 'conversation' } },
    { userInput: 'Wat weet je nog van mij?', intent: { intent: 'memory.inspect', sourceOfTruth: 'memory' } },
  ];
  for (const c of cases) {
    const d = decide({ ...c, reasoning: null, availableCapabilities: FULL_REGISTRY });
    assert.equal(d.action, 'native', `expected native for: ${c.userInput}`);
    assert.equal(d.generationMode, 'native', `expected native mode for: ${c.userInput}`);
  }
});

test('Hermes unavailable: deep reasoning when hermes is not registered → clarify', () => {
  const d = decide({
    userInput: 'Analyseer dit diepgaand',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    reasoning: { reasoningDepth: 'deep' },
    availableCapabilities: [{ id: 'native' }],
  });
  // Without hermes, deep reasoning can't be fulfilled → clarify
  // (Generation Policy 0.1: hermes required but not available → clarify)
  assert.equal(d.action, 'clarify');
  assert.match(d.reason, /Hermes required/);
});

test('Hermes unavailable: native is still the default when hermes is not registered', () => {
  const d = decide({
    userInput: 'Hallo Gaia',
    intent: null,
    reasoning: null,
    availableCapabilities: [{ id: 'native' }],
  });
  assert.equal(d.action, 'native');
  assert.equal(d.generationMode, 'native');
});

test('existing capabilities: web routing unchanged', () => {
  const d = decide({
    userInput: 'what is the weather today?',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.equal(d.action, 'tool');
  assert.equal(d.capability, 'web');
});

test('existing capabilities: conversation_search routing unchanged', () => {
  const d = decide({
    userInput: 'wat was er in juni ook alweer?',
    intent: {
      schemaVersion: 'intentiq.v1', intent: null, status: 'unknown',
      sourceOfTruth: 'memory',
      referents: [{ expression: 'juni', resolvedTo: 'previous_assistant_turn:juni', confidence: 0.6, source: 'previous_assistant_turn' }],
      meta: { reason: 'assistant_anchored_follow_up_unresolved_intent' },
    },
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.equal(d.action, 'capability');
  assert.equal(d.capability, 'conversation_search');
});

test('existing capabilities: tool routing unchanged', () => {
  const d = decide({
    userInput: 'send this to Bo',
    intent: { intent: 'act.perform', status: 'accepted', needsClarification: false, sourceOfTruth: 'tool', entities: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }, { id: 'tool' }],
  });
  assert.equal(d.action, 'tool');
  assert.equal(d.capability, 'tool');
});

test('streaming/non-streaming parity: same decision for identical input', () => {
  // The generation policy is pure and deterministic — same inputs always
  // produce the same output, regardless of transport.
  const inputs = {
    userInput: 'Wat vind je hiervan?',
    intent: { intent: 'converse', status: 'accepted', needsClarification: false, sourceOfTruth: 'conversation' },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  };
  const d1 = decide(inputs);
  const d2 = decide(inputs);
  assert.deepEqual(d1, d2);
});

test('generationMode is always present on every decision', () => {
  const cases = [
    { userInput: 'hi', intent: null, reasoning: null },
    { userInput: 'hello', intent: { intent: 'converse', sourceOfTruth: 'conversation' }, reasoning: null },
    { userInput: 'explain this', intent: { intent: 'inform.explain', sourceOfTruth: 'external_knowledge' }, reasoning: null },
    { userInput: 'deep analysis', intent: { intent: 'inform.explain', sourceOfTruth: 'external_knowledge' }, reasoning: { reasoningDepth: 'deep' } },
  ];
  for (const c of cases) {
    const d = decide({ ...c, availableCapabilities: FULL_REGISTRY });
    assert.ok(d.generationMode !== undefined, `generationMode must be present for: ${c.userInput}`);
    assert.ok(GENERATION_POLICY_MODES.includes(d.generationMode), `invalid generationMode for: ${c.userInput}`);
    assert.equal(validateDecision(d), null, `invalid decision for: ${c.userInput}`);
  }
});

test('unnecessary Hermes rate is zero: no turn goes to Hermes without an explicit reason', () => {
  // Every turn that goes to Hermes must have either deep reasoning or a skill
  const turns = [
    { userInput: 'Hallo', intent: null, reasoning: null },
    { userInput: 'Wat vind je?', intent: { intent: 'converse', sourceOfTruth: 'conversation' }, reasoning: null },
    { userInput: 'Hoe gaat het?', intent: { intent: 'greet', sourceOfTruth: 'conversation' }, reasoning: null },
    { userInput: 'Bedankt', intent: { intent: 'acknowledge', sourceOfTruth: 'conversation' }, reasoning: null },
    { userInput: 'Wat weet je nog?', intent: { intent: 'memory.inspect', sourceOfTruth: 'memory' }, reasoning: null },
    { userInput: 'Leg dit uit', intent: { intent: 'inform.explain', sourceOfTruth: 'external_knowledge' }, reasoning: null },
  ];
  for (const t of turns) {
    const d = decide({ ...t, availableCapabilities: FULL_REGISTRY });
    if (d.generationMode === 'hermes') {
      // If hermes is selected, there must be an explicit reason
      const hasDeepReasoning = t.reasoning && t.reasoning.reasoningDepth === 'deep';
      const hasSkill = d.steps
        ? d.steps.some((s) => s.skill)
        : false;
      assert.ok(
        hasDeepReasoning || hasSkill,
        `unnecessary Hermes for: ${t.userInput} (reason: ${d.reason})`
      );
    }
  }
});
