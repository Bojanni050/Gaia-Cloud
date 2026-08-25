'use strict';

/**
 * Capability Registry 1.0 — skill-aware capabilities tests.
 *
 * Covers: registry contents (official Hermes catalog names, routing flags,
 * no duplicates), skill/capability validation in schema and orchestrator,
 * registry-driven awareness rendering, Hermes adapter skill forwarding
 * (and untouched payload without a skill), Decision Engine skill selection
 * with the no-name-matching invariant, and the registry's own boundary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  CAPABILITY_REGISTRY,
  getCapabilityProfile,
  listCapabilityIds,
  hasSkill,
  getSkill,
  validateCapabilitySkill,
  routingSkills,
} = require('../src/capabilityRegistry');
const { renderCapabilityAwareness } = require('../src/capabilityAwareness');
const { validateDecision } = require('../src/decision/decisionSchema');
const { buildPlan, matchSkillTask, decide } = require('../src/decision/decisionEngine');
const { execute } = require('../src/orchestration/orchestrator');

// --- §18 Registry --------------------------------------------------------------

test('hermes is ONE capability with a skill inventory — not one capability per skill', () => {
  const hermes = getCapabilityProfile('hermes');
  assert.ok(hermes);
  assert.equal(hermes.type, 'generation');
  assert.ok(hermes.skills.length >= 3);
  // The audit-verified baseline is recorded as metadata.
  assert.equal(hermes.baseline.id, 'identity_grounded_conversation');
  assert.equal(hermes.baseline.routing, false);
});

test('skill ids are the OFFICIAL Hermes Bundled Skills Catalog names', () => {
  const hermes = getCapabilityProfile('hermes');
  const officialCatalogNames = new Set([
    'systematic-debugging', 'test-driven-development', 'requesting-code-review',
    'grounded-citations', 'plan',
  ]);
  for (const s of hermes.skills) {
    assert.ok(officialCatalogNames.has(s.id), `non-catalog skill id: ${s.id}`);
  }
  // The spec's two named examples are present with routing:true.
  assert.equal(getSkill('hermes', 'systematic-debugging').routing, true);
  assert.equal(getSkill('hermes', 'test-driven-development').routing, true);
  assert.equal(getSkill('hermes', 'systematic-debugging').category, 'development');
});

test('routing flags: only selection-relevant skills are routing targets', () => {
  const routing = routingSkills('hermes').map((s) => s.id).sort();
  assert.deepEqual(routing, ['requesting-code-review', 'systematic-debugging', 'test-driven-development']);
  // Non-routing metadata exists but is flagged honestly.
  assert.equal(getSkill('hermes', 'plan').routing, false);
  assert.equal(getSkill('hermes', 'grounded-citations').routing, false);
});

test('no duplicate skill ids within any capability; every skill has category + description', () => {
  for (const id of listCapabilityIds()) {
    const profile = getCapabilityProfile(id);
    const ids = profile.skills.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate skill in ${id}`);
    for (const s of profile.skills) {
      assert.ok(s.category && s.description && typeof s.routing === 'boolean', `${id}/${s.id} incomplete`);
    }
  }
});

test('other Gaia capabilities carry their function modes as non-routing skills', () => {
  assert.ok(hasSkill('conversation_search', 'current-conversation-search'));
  assert.ok(hasSkill('conversation_search', 'saved-conversation-search'));
  assert.ok(hasSkill('hindsight', 'memory-retrieval'));
  assert.ok(hasSkill('hindsight', 'pattern-retrieval'));
  assert.ok(hasSkill('web', 'web-search'));
  // None of these are routing targets — scope/source selection is Decision input.
  for (const s of routingSkills('conversation_search').concat(routingSkills('hindsight')).concat(routingSkills('web'))) {
    assert.fail(`no retrieval capability skill should be routing:true: ${s.id}`);
  }
});

// --- §10/§18: skill + capability validation -------------------------------------

test('validateCapabilitySkill: known combo valid; unknown skill / unknown capability invalid', () => {
  assert.equal(validateCapabilitySkill('hermes', 'systematic-debugging'), null);
  assert.match(validateCapabilitySkill('hermes', 'made-up-skill'), /does not expose skill/);
  assert.match(validateCapabilitySkill('nonexistent', 'systematic-debugging'), /not registered/);
  assert.equal(validateCapabilitySkill('hermes', null), null); // no skill claimed
});

test('schema: hermes + known skill → valid plan; hermes + unknown skill → rejected before execution', () => {
  const valid = {
    action: 'plan',
    steps: [
      { id: 'step-1', type: 'reasoning', capability: 'hermes', skill: 'systematic-debugging', input: {} },
      { id: 'step-2', type: 'generation', mode: 'native' },
    ],
    reason: 'debug task',
  };
  assert.equal(validateDecision(valid), null);

  const invalid = {
    action: 'plan',
    steps: [
      { id: 'step-1', type: 'reasoning', capability: 'hermes', skill: 'totally-fake-skill', input: {} },
      { id: 'step-2', type: 'generation', mode: 'native' },
    ],
    reason: 'bad',
  };
  assert.match(validateDecision(invalid), /does not expose skill/);
});

test('schema: a skill without a capability on the same step is rejected', () => {
  const invalid = {
    action: 'plan',
    steps: [
      { id: 'step-1', type: 'reasoning', skill: 'systematic-debugging' },
      { id: 'step-2', type: 'generation', mode: 'native' },
    ],
  };
  // The generic capability requirement fires first — either way the step is
  // rejected before execution.
  assert.match(validateDecision(invalid), /requires a non-empty capability/);
});

test('schema: a plain hermes step without a skill stays valid (spec §13)', () => {
  const plain = {
    action: 'plan',
    steps: [
      { id: 'step-1', type: 'reasoning', capability: 'hermes' },
      { id: 'step-2', type: 'generation', mode: 'native' },
    ],
  };
  assert.equal(validateDecision(plain), null);
});

// --- §18: Awareness is registry-driven (no hardcoding) ----------------------------

test('awareness renders skills dynamically from the registry, compactly', () => {
  const block = renderCapabilityAwareness([{ id: 'hermes' }, { id: 'conversation_search' }]);
  assert.match(block, /Capabilities you genuinely have THIS turn/);
  assert.match(block, /- hermes: deeper reasoning/);
  // Skill line is derived from the registry, verbatim ids, comma-joined.
  const expectedSkillLine = `  skills: ${getCapabilityProfile('hermes').skills.map((s) => s.id).join(', ')}`;
  assert.ok(block.includes(expectedSkillLine), 'skill line must come from the registry');
  assert.match(block, /skills: current-conversation-search, saved-conversation-search, all-sources-search/);
  // Compact: no skill descriptions in the prompt block.
  assert.ok(!block.includes('4-phase root cause debugging'));
});

test('awareness: unregistered capability ids are never claimed', () => {
  const block = renderCapabilityAwareness([{ id: 'hermes' }, { id: 'mystery_capability' }]);
  assert.ok(!block.includes('mystery_capability'));
});

// --- §18: Hermes adapter forwards the selected skill -------------------------------

test('orchestrator forwards step.skill to the capability invoke options', async () => {
  const seenOptions = [];
  const capabilities = {
    hermes: { invoke: async (_m, o) => { seenOptions.push(o); return 'analyse klaar'; } },
  };
  const decision = {
    action: 'plan',
    reason: 'debug',
    steps: [
      { id: 'step-1', type: 'reasoning', capability: 'hermes', skill: 'systematic-debugging', input: {} },
      { id: 'step-2', type: 'generation', mode: 'native', sources: ['step-1'] },
    ],
  };
  const result = await execute(decision, {
    capabilities,
    nativeGenerator: { generate: async () => 'antwoord' },
    messages: [],
  });
  assert.equal(seenOptions[0].skill, 'systematic-debugging');
  assert.equal(result.output, 'antwoord');
});

test('orchestrator: a plain hermes step forwards NO skill (never a forced instruction)', async () => {
  const seenOptions = [];
  const capabilities = {
    hermes: { invoke: async (_m, o) => { seenOptions.push(o); return 'ok'; } },
  };
  await execute({
    action: 'plan',
    steps: [
      { id: 'step-1', type: 'reasoning', capability: 'hermes' },
      { id: 'step-2', type: 'generation', mode: 'native' },
    ],
  }, { capabilities, nativeGenerator: { generate: async () => 'x' }, messages: [] });
  assert.equal(seenOptions[0].skill, undefined);
});

test('orchestrator rejects an injected plan with an invalid skill combo before any invoke', async () => {
  let invoked = 0;
  const capabilities = { hermes: { invoke: async () => { invoked += 1; return 'x'; } } };
  await assert.rejects(
    () => execute({
      action: 'plan',
      steps: [
        { id: 'step-1', type: 'reasoning', capability: 'hermes', skill: 'not-a-real-skill' },
        { id: 'step-2', type: 'generation', mode: 'native' },
      ],
    }, { capabilities, nativeGenerator: { generate: async () => 'x' }, messages: [] }),
    /does not expose skill/
  );
  assert.equal(invoked, 0);
});

test('hermes adapter: selected skill becomes an explicit instruction; no skill leaves the payload untouched', async () => {
  // Exercise the adapter exactly as runTurnCore wires it, via a minimal
  // performStreamingTurn with a plan decision injected.
  const { performStreamingTurn } = require('../src/turn');
  const seen = [];
  const hermes = {
    stream: async (messages, { onDelta } = {}) => {
      seen.push(messages);
      if (onDelta) onDelta('klaar', false);
      return 'klaar';
    },
  };
  const res = { writeHead() {}, write() {}, end() {}, status() { return this; }, json() {} };
  const planDecision = {
    action: 'plan',
    steps: [
      { id: 'step-1', type: 'reasoning', capability: 'hermes', skill: 'systematic-debugging', input: {} },
      { id: 'step-2', type: 'generation', mode: 'native', sources: ['step-1'] },
    ],
    reason: 'debug',
  };

  // With skill: an explicit instruction system message is present.
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'waarom faalt dit?' }],
    documents: { 'soul.md': 'S', 'principles.md': 'P', 'lexicon.md': 'L' },
    hermes,
    hindsight: { recall: async () => [], reflect: async () => {} },
    res,
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: null, status: 'unknown' }),
    reasonIQ: async () => ({}),
    decisionEngine: () => planDecision,
    orchestrate: async (decision, ctx) => {
      ctx.nativeGenerator = { generate: async () => 'antwoord' };
      const { execute } = require('../src/orchestration/orchestrator');
      return execute(decision, ctx);
    },
  });
  const withSkill = seen[0];
  const instruction = withSkill.find((m) => m.role === 'system' && /Use the Hermes skill "systematic-debugging"/.test(m.content));
  assert.ok(instruction, 'explicit skill instruction reaches Hermes');
  assert.match(instruction.content, /Load and execute that skill yourself/);

  // Without skill: payload untouched — no skill instruction anywhere.
  seen.length = 0;
  await performStreamingTurn({
    messages: [{ role: 'user', content: 'analyseer dit even' }],
    documents: { 'soul.md': 'S', 'principles.md': 'P', 'lexicon.md': 'L' },
    hermes,
    hindsight: { recall: async () => [], reflect: async () => {} },
    res: { writeHead() {}, write() {}, end() {}, status() { return this; }, json() {} },
    intentIQ: () => ({ schemaVersion: 'intentiq.v1', intent: null, status: 'unknown' }),
    reasonIQ: async () => ({}),
    decisionEngine: () => ({
      action: 'plan',
      steps: [
        { id: 'step-1', type: 'reasoning', capability: 'hermes' },
        { id: 'step-2', type: 'generation', mode: 'native', sources: ['step-1'] },
      ],
      reason: 'plain',
    }),
    orchestrate: async (decision, ctx) => {
      ctx.nativeGenerator = { generate: async () => 'antwoord' };
      const { execute } = require('../src/orchestration/orchestrator');
      return execute(decision, ctx);
    },
  });
  assert.ok(!seen[0].some((m) => /Use the Hermes skill/.test(m.content)), 'no forced skill instruction without selection');
});

// --- §14/§16/§19: Decision Engine skill selection -----------------------------------

test('skill selection: debugging task shape attaches systematic-debugging', () => {
  const p = buildPlan({ userInput: 'Zoek uit waarom deze race condition optreedt.', intent: null });
  assert.equal(p.action, 'plan');
  const hermesStep = p.steps.find((s) => s.capability === 'hermes');
  assert.equal(hermesStep.skill, 'systematic-debugging');
  assert.equal(validateDecision(p), null);
});

test('skill selection: test-strategy task shape attaches test-driven-development', () => {
  const p = buildPlan({ userInput: 'Maak een goede teststrategie voor deze wijziging.', intent: null });
  const hermesStep = p.steps.find((s) => s.capability === 'hermes');
  assert.equal(hermesStep.skill, 'test-driven-development');
});

test('skill selection: code review task shape attaches requesting-code-review', () => {
  const p = buildPlan({ userInput: 'Kun je mijn code reviewen voor ik hem commit?', intent: null });
  const hermesStep = p.steps.find((s) => s.capability === 'hermes');
  assert.equal(hermesStep.skill, 'requesting-code-review');
});

test('no skill for generic analysis — Hermes without skill stays the norm (spec §13/§14)', () => {
  const p = buildPlan({ userInput: 'Analyseer deze architectuur op basis van de vorige bevindingen.', intent: null });
  if (p) {
    const hermesStep = p.steps.find((s) => s.capability === 'hermes');
    if (hermesStep) assert.equal(hermesStep.skill, undefined);
  }
  assert.equal(matchSkillTask('Analyseer deze architectuur.'), null);
});

test('INVARIANT: a skill NAME in the prompt never selects the skill', () => {
  assert.equal(matchSkillTask('Leg uit wat de skill systematic-debugging doet.'), null);
  assert.equal(matchSkillTask('wat houdt test-driven-development in?'), null);
  const p = buildPlan({ userInput: 'Leg uit wat de skill systematic-debugging inhoudt.', intent: null });
  if (p) {
    const hermesStep = p.steps.find((s) => s.capability === 'hermes');
    if (hermesStep) assert.equal(hermesStep.skill, undefined);
  }
});

test('decision integration: skill plan survives decide() with the full registry available', () => {
  const d = decide({
    userInput: 'Zoek uit waarom deze race condition optreedt.',
    intent: null,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }, { id: 'web' }, { id: 'conversation_search' }, { id: 'hindsight' }],
  });
  assert.equal(d.action, 'plan');
  assert.equal(d.steps.find((s) => s.capability === 'hermes').skill, 'systematic-debugging');
  assert.equal(validateDecision(d), null);
});

// --- Boundary ------------------------------------------------------------------------

test('boundary: the registry is pure frozen data — zero requires, zero I/O', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/capabilityRegistry.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepEqual(required, []);
  // No I/O patterns. (Capability/skill NAMES like "hindsight" are registry
  // DATA here, not module references.)
  assert.ok(!/fetch\(|https?:\/\/|require\(/i.test(source));
  // Frozen at every level: profiles and skills cannot be mutated.
  const hermes = getCapabilityProfile('hermes');
  assert.equal(Object.isFrozen(hermes), true);
  assert.equal(Object.isFrozen(hermes.skills), true);
});

test('boundary: awareness renders only from the registry', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/capabilityAwareness.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepEqual(required, ['./capabilityRegistry']);
  assert.ok(!/hindsight|web|brave|mcp|decisionEngine/i.test(source));
});
