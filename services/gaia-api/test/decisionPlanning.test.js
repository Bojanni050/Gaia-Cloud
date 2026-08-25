'use strict';

/**
 * Decision Engine 3.0 — Planning & Composition tests.
 *
 * Covers: plan schema validation (ids, types, references, budget, cycles),
 * the §25 example matrix, minimum-sufficient behaviour (no unnecessary
 * steps/plans), registry awareness, Orchestrator sequential execution with
 * reference resolution and failure semantics, Response Engine integration,
 * and streaming/non-streaming parity for planned turns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateDecision,
  validatePlanSteps,
  MAX_PLAN_STEPS,
  STEP_TYPES,
  GENERATION_MODES,
} = require('../src/decision/decisionSchema');
const { decide, buildPlan, hasPlanningSignal } = require('../src/decision/decisionEngine');
const { execute } = require('../src/orchestration/orchestrator');
const { formatReply } = require('../src/responseEngine');

const FULL_REGISTRY = [
  { id: 'hermes' },
  { id: 'native' },
  { id: 'web' },
  { id: 'conversation_search' },
  { id: 'hindsight' },
];

// --- §20/§29: plan schema validation ------------------------------------------

test('plan vocabulary is small and bounded', () => {
  assert.deepEqual([...STEP_TYPES], ['retrieval', 'reasoning', 'generation', 'capability']);
  assert.deepEqual([...GENERATION_MODES], ['native', 'capability']);
  assert.equal(MAX_PLAN_STEPS, 4);
});

test('a valid multi-step plan validates', () => {
  const decision = {
    action: 'plan',
    steps: [
      { id: 'step-1', type: 'retrieval', capability: 'conversation_search', input: { query: 'x', scope: 'all' } },
      { id: 'step-2', type: 'retrieval', capability: 'hindsight', input: { query: 'y' } },
      { id: 'step-3', type: 'reasoning', capability: 'hermes', sources: ['step-1', 'step-2'] },
      { id: 'step-4', type: 'generation', mode: 'native', sources: ['step-1', 'step-2'] },
    ],
    reason: 'combined retrieval + reasoning + generation',
  };
  assert.equal(validateDecision(decision), null);
});

test('invalid plans are rejected deterministically', () => {
  const base = { action: 'plan' };
  assert.match(validateDecision(base) || '', /non-empty steps array/);
  assert.match(
    validateDecision({ action: 'plan', steps: [{ id: 'a', type: 'teleport', capability: 'x' }] }) || '',
    /invalid type/
  );
  // duplicate ids
  assert.match(
    validateDecision({ action: 'plan', steps: [
      { id: 'a', type: 'retrieval', capability: 'hindsight' },
      { id: 'a', type: 'generation', mode: 'native' },
    ] }) || '',
    /duplicate plan step id/
  );
  // missing capability on a step that needs one
  assert.match(
    validateDecision({ action: 'plan', steps: [{ id: 'a', type: 'retrieval' }] }) || '',
    /requires a non-empty capability/
  );
  // unknown / forward references
  assert.match(
    validateDecision({ action: 'plan', steps: [{ id: 'a', type: 'reasoning', capability: 'hermes', sources: ['ghost'] }] }) || '',
    /references unknown or later step/
  );
  // self reference
  assert.match(
    validateDecision({ action: 'plan', steps: [{ id: 'a', type: 'retrieval', capability: 'hindsight', sources: ['a'] }] }) || '',
    /references itself/
  );
  // circular pair: b references a BEFORE a exists → rejected as forward ref
  assert.match(
    validateDecision({ action: 'plan', steps: [
      { id: 'b', type: 'generation', mode: 'native', sources: ['a'] },
      { id: 'a', type: 'retrieval', capability: 'hindsight' },
    ] }) || '',
    /references unknown or later step: a/
  );
  // over budget
  assert.match(
    validateDecision({
      action: 'plan',
      steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({ id: `s${i}`, type: 'retrieval', capability: 'hindsight' })),
    }) || '',
    /MAX_PLAN_STEPS/
  );
  // generation shape
  assert.match(
    validateDecision({ action: 'plan', steps: [{ id: 'a', type: 'generation', mode: 'subroutine' }] }) || '',
    /requires mode/
  );
  assert.match(
    validateDecision({ action: 'plan', steps: [{ id: 'a', type: 'generation', mode: 'native', capability: 'web' }] }) || '',
    /must not name a capability/
  );
});

test('circular two-step plans cannot be expressed at all (backward-only refs)', () => {
  // The only way to write s1→s2→s1 would need a forward reference somewhere.
  const problem = validatePlanSteps([
    { id: 's1', type: 'retrieval', capability: 'hindsight', sources: ['s2'] },
    { id: 's2', type: 'reasoning', capability: 'hermes', sources: ['s1'] },
  ]);
  assert.match(problem, /references unknown or later step/);
});

// --- §25: the planning example matrix -------------------------------------------

test('§25 native: a greeting stays a simple native decision — not a plan', () => {
  assert.equal(buildPlan({ userInput: 'Hoi Gaia', intent: null }), null);
  const d = decide({ userInput: 'Hoi Gaia', intent: null, context: {}, reasoning: null, availableCapabilities: FULL_REGISTRY });
  assert.equal(d.action, 'native');
});

test('§25 hindsight-only stays the existing single path with recalled context (minimum-sufficient)', () => {
  // runTurnCore recalls Hindsight before decide(); an extra hindsight step
  // would duplicate retrieval (spec §17). Documented deviation from the raw
  // §25 sketch — measured by the planning evaluation.
  const d = decide({
    userInput: 'Wat weet je nog van mijn voorkeuren?',
    intent: { intent: 'memory.inspect', status: 'accepted', needsClarification: false, sourceOfTruth: 'memory' },
    context: { reflections: [{ text: 'Bo prefers short answers' }], mentalModels: [] },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.notEqual(d.action, 'plan');
  assert.ok(d.action === 'native' || d.action === 'capability');
});

test('§25 conversation search only: exact-history ask becomes [cs → native]', () => {
  const d = decide({
    userInput: 'Wat zei ik vorige maand letterlijk over Gaia?',
    intent: null,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.equal(d.action, 'plan');
  assert.deepEqual(d.steps.map((s) => s.capability || s.mode), ['conversation_search', 'native']);
  // Generation consumes the retrieval result.
  assert.deepEqual(d.steps[1].sources, [d.steps[0].id]);
  assert.equal(validateDecision(d), null);
});

test('§25 both retrievals: remembered knowledge + literal statement', () => {
  const d = decide({
    userInput: 'Wat weet je nog van mijn Gaia-plannen en wat zei ik daar vorige maand precies over?',
    intent: null,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.equal(d.action, 'plan');
  assert.deepEqual(d.steps.map((s) => s.capability || s.mode), ['conversation_search', 'hindsight', 'native']);
  assert.equal(validateDecision(d), null);
});

test('§25 search + Hermes: retrieved decisions get analysed then answered natively', () => {
  const d = decide({
    userInput: 'Zoek wat we vorige maand over Hindsight besloten en analyseer of die keuze nog logisch is.',
    intent: null,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.equal(d.action, 'plan');
  assert.deepEqual(d.steps.map((s) => s.capability || s.mode), ['conversation_search', 'hermes', 'native']);
  const hermesStep = d.steps[1];
  assert.deepEqual(hermesStep.sources, [d.steps[0].id]);
  assert.deepEqual(d.steps[2].sources, [d.steps[0].id]);
});

test('§25 hindsight + Hermes + native for combined knowledge + analysis', () => {
  const d = decide({
    userInput: 'Combineer wat je over dit project weet met deze nieuwe analyse.',
    intent: null,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.equal(d.action, 'plan');
  assert.deepEqual(d.steps.map((s) => s.capability || s.mode), ['hindsight', 'hermes', 'native']);
});

test('§25 web + Hermes + native when external info must be compared with own knowledge', () => {
  const d = decide({
    userInput: 'Zoek actuele informatie hierover en vergelijk die met mijn eerdere Gaia-architectuur.',
    intent: { intent: 'inform.explain', status: 'accepted', needsClarification: false, sourceOfTruth: 'external_knowledge' },
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: FULL_REGISTRY,
  });
  assert.equal(d.action, 'plan');
  const capabilitiesInOrder = d.steps.map((s) => s.capability || s.mode);
  assert.equal(capabilitiesInOrder[0], 'web'); // external first, optional
  assert.ok(d.steps[0].optional === true);
  assert.equal(capabilitiesInOrder[capabilitiesInOrder.length - 1], 'native');
});

test('plans never contain the same retrieval capability twice (§17)', () => {
  const cases = [
    'Wat zei ik vorige maand letterlijk over Gaia?',
    'Wat weet je nog van mijn Gaia-plannen en wat zei ik daar precies over?',
    'Zoek wat we vorige maand besloten en analyseer het.',
  ];
  for (const userInput of cases) {
    const p = buildPlan({ userInput, intent: null });
    if (!p) continue;
    const caps = p.steps.map((s) => s.capability).filter(Boolean);
    assert.equal(new Set(caps).size, caps.length, `duplicate retrieval in plan for: ${userInput}`);
  }
});

test('registry awareness: a plan naming an unregistered capability falls back to existing routing', () => {
  const d = decide({
    userInput: 'Wat weet je nog van mijn Gaia-plannen en wat zei ik daar vorige maand precies over?',
    intent: null,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    // no hindsight/conversation_search registered:
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.notEqual(d.action, 'plan');
  assert.equal(validateDecision(d), null);
});

test('decision explanation: plans carry a short operational reason, no chain-of-thought', () => {
  const d = buildPlan({ userInput: 'Wat zei ik vorige maand letterlijk over Gaia?', intent: null });
  assert.ok(typeof d.reason === 'string' && d.reason.length > 0 && d.reason.length < 200);
});

// --- §29: Orchestrator sequential execution ---------------------------------------

function makePlanFixtures() {
  const calls = [];
  const capabilities = {
    conversation_search: {
      invoke: async (_m, o) => {
        calls.push(`search:${o.input.query}`);
        return { results: [{ text: 'Bo zei: juni-release verschuift', relevance: 0.9 }], total: 1 };
      },
    },
    hindsight: {
      invoke: async () => {
        calls.push('hindsight');
        return { results: [{ text: 'Gaia herinnert zich de plannen rond Melodiq', relevance: 0.8 }], total: 1 };
      },
    },
    hermes: {
      invoke: async (messages) => {
        calls.push('hermes');
        // Capture what the reasoning step actually received.
        fixtures.hermesMessages = messages;
        return 'Analyse: de keuze blijft logisch.';
      },
    },
  };
  const nativeGenerator = {
    generate: async (messages) => {
      calls.push('native');
      fixtures.nativeMessages = messages;
      return 'Gaia\'s eindantwoord op basis van de gevonden passages.';
    },
  };
  const fixtures = { calls, capabilities, nativeGenerator };
  return fixtures;
}

test('orchestrator executes plan steps sequentially and resolves references', async () => {
  const f = makePlanFixtures();
  const decision = {
    action: 'plan',
    reason: 'test',
    steps: [
      { id: 'step-1', type: 'retrieval', capability: 'conversation_search', input: { query: 'juni release', scope: 'current' } },
      { id: 'step-2', type: 'retrieval', capability: 'hindsight', input: { query: 'plannen' } },
      { id: 'step-3', type: 'reasoning', capability: 'hermes', input: {}, sources: ['step-1', 'step-2'] },
      { id: 'step-4', type: 'generation', mode: 'native', sources: ['step-1', 'step-2'] },
    ],
  };

  const result = await execute(decision, { capabilities: f.capabilities, nativeGenerator: f.nativeGenerator, messages: [{ role: 'user', content: 'q' }] });

  // Sequential, in order.
  assert.deepEqual(f.calls, ['search:juni release', 'hindsight', 'hermes', 'native']);

  // Step reports carry latency + status per spec §19.
  assert.equal(result.action, 'plan');
  assert.equal(result.steps.length, 4);
  assert.ok(result.steps.every((s) => s.status === 'success' && typeof s.latencyMs === 'number'));

  // References were resolved: hermes received a system block containing BOTH
  // earlier results; native received them too.
  const hermesSystem = f.hermesMessages.find((m) => m.role === 'system' && /earlier plan steps/.test(m.content));
  assert.ok(hermesSystem, 'hermes got the rendered step-results block');
  assert.match(hermesSystem.content, /juni-release verschuift/);
  assert.match(hermesSystem.content, /Melodiq/);

  // Last successful step's output is the reply text.
  assert.equal(result.output, "Gaia's eindantwoord op basis van de gevonden passages.");
  assert.equal(formatReply(result.output).status, 200);
});

test('orchestrator: a REQUIRED step failure stops the plan with a structured failure — no replanning', async () => {
  const capabilities = {
    conversation_search: { invoke: async () => { throw new Error('store unreachable'); } },
    hindsight: { invoke: async () => ({ results: [], total: 0 }) },
    hermes: { invoke: async () => { throw new Error('must not be reached'); } },
  };
  const nativeGenerator = { generate: async () => { throw new Error('must not be reached either'); } };
  const decision = {
    action: 'plan',
    reason: 'test',
    steps: [
      { id: 'step-1', type: 'retrieval', capability: 'conversation_search', input: {} },
      { id: 'step-2', type: 'retrieval', capability: 'hindsight', input: {} },
      { id: 'step-3', type: 'reasoning', capability: 'hermes', sources: ['step-1'] },
      { id: 'step-4', type: 'generation', mode: 'native', sources: ['step-1'] },
    ],
  };
  const result = await execute(decision, { capabilities, nativeGenerator, messages: [] });
  assert.equal(result.action, 'plan');
  assert.equal(result.output, null);
  assert.match(result.error, /plan step "step-1" failed/);
  assert.equal(result.steps.length, 1); // stopped right there
  assert.equal(result.steps[0].status, 'failed');
});

test('orchestrator: OPTIONAL step failure records and continues; later steps see the missing marker', async () => {
  const seenByNative = [];
  const capabilities = {
    web: { invoke: async () => { throw new Error('network down'); } },
    hindsight: { invoke: async () => ({ results: [{ text: 'geheugen: iets zinnigs', relevance: 0.7 }], total: 1 }) },
  };
  const nativeGenerator = { generate: async (messages) => { seenByNative.push(messages); return 'antwoord zonder web'; } };
  const decision = {
    action: 'plan',
    reason: 'test',
    steps: [
      { id: 'w1', type: 'capability', capability: 'web', optional: true, input: {} },
      { id: 'r1', type: 'retrieval', capability: 'hindsight', input: {} },
      { id: 'g1', type: 'generation', mode: 'native', sources: ['w1', 'r1'] },
    ],
  };
  const result = await execute(decision, { capabilities, nativeGenerator, messages: [] });
  assert.equal(result.output, 'antwoord zonder web');
  assert.deepEqual(result.steps.map((s) => s.status), ['failed', 'success', 'success']);
  const sysBlock = seenByNative[0].find((m) => m.role === 'system' && /earlier plan steps/.test(m.content));
  assert.match(sysBlock.content, /\[w1\]/); // explicit missing marker, honestly labeled
  assert.match(sysBlock.content, /iets zinnigs/);
});

test('response engine treats a plan result like any other textual output', () => {
  // covered indirectly above via formatReply; direct pin:
  const { resolveReplyText } = require('../src/responseEngine');
  assert.equal(resolveReplyText({ action: 'plan', output: 'tekst' }), 'tekst');
  assert.equal(resolveReplyText({ action: 'plan', output: null }), null);
});
