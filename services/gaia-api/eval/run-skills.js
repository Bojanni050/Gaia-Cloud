'use strict';

/**
 * Skill-aware planning evaluation — deterministic, no model (spec §19).
 *
 * Usage: node eval/run-skills.js  (or: npm run eval:skills)
 *
 * Measures skill selection accuracy, invalid skill rate and unnecessary
 * skill rate. Headline invariant:
 *
 *   > A skill is NEVER selected because its name happens to appear in the
 *   > user prompt; it is selected because the TASK SHAPE matches.
 */

const { decide, matchSkillTask } = require('../src/decision/decisionEngine');
const { validateDecision } = require('../src/decision/decisionSchema');

const REGISTRY = [
  { id: 'hermes' }, { id: 'native' }, { id: 'web' },
  { id: 'conversation_search' }, { id: 'hindsight' },
];

// expected.skill: the skill id the hermes step must carry, null when hermes
// must appear WITHOUT a skill, 'none' when no hermes step may exist at all.
// expected.action: for non-plan expectations.
const CASES = [
  { id: 'sk-01', cat: 'debugging', input: 'Zoek uit waarom deze race condition optreedt.', intent: null, expected: { plan: true, skill: 'systematic-debugging' } },
  { id: 'sk-02', cat: 'debugging', input: 'Waardoor breekt de stream nu steeds?', intent: null, expected: { plan: true, skill: 'systematic-debugging' } },
  { id: 'sk-03', cat: 'test strategy', input: 'Maak een goede teststrategie voor deze wijziging.', intent: null, expected: { plan: true, skill: 'test-driven-development' } },
  { id: 'sk-04', cat: 'code review', input: 'Kun je mijn code reviewen voor ik hem commit?', intent: null, expected: { plan: true, skill: 'requesting-code-review' } },
  { id: 'sk-05', cat: 'generic analysis', input: 'Analyseer deze architectuur op basis van de vorige bevindingen.', intent: { intent: 'inform.explain', status: 'accepted', sourceOfTruth: 'external_knowledge' }, registry: [{ id: 'hermes' }, { id: 'native' }, { id: 'conversation_search' }, { id: 'hindsight' }], expected: { plan: false, action: 'capability', capability: 'hermes', skill: null } },
  { id: 'sk-06', cat: 'name-mention invariant', input: 'Leg uit wat de skill systematic-debugging inhoudt.', intent: null, expected: { plan: false, skill: 'none' } },
  { id: 'sk-07', cat: 'name-mention invariant', input: 'wat houdt test-driven-development in?', intent: null, expected: { plan: false, skill: 'none' } },
  { id: 'sk-08', cat: 'web research', input: 'Zoek de actuele prijzen van dit component op.', intent: { intent: 'inform.explain', status: 'accepted', sourceOfTruth: 'external_knowledge' }, expected: { plan: false, action: 'tool', skill: 'none' } },
  { id: 'sk-09', cat: 'conversation search', input: 'wat was er in juni ook alweer?', intent: { intent: null, status: 'unknown', sourceOfTruth: 'memory', meta: { reason: 'assistant_anchored_follow_up_unresolved_intent' } }, expected: { plan: false, action: 'capability', capability: 'conversation_search' } },
  { id: 'sk-10', cat: 'memory question', input: 'Wat weet je nog van mijn voorkeuren?', intent: { intent: 'memory.inspect', status: 'accepted', sourceOfTruth: 'memory' }, expected: { plan: false, action: 'native', skill: 'none' } },
];

function run() {
  let correct = 0;
  let skillSelectionCorrect = 0;
  let skillSelectionTotal = 0;
  let invalidSkill = 0;
  let unnecessarySkill = 0;
  let missingSkill = 0;

  for (const c of CASES) {
    const decision = decide({
      userInput: c.input,
      intent: c.intent,
      context: { reflections: [], mentalModels: [], patterns: [] },
      reasoning: null,
      availableCapabilities: c.registry || REGISTRY,
    });

    // Invalid-skill rate: any decision carrying a skill must pass registry
    // validation (schema already rejects unknown combos — belt and braces).
    if (decision.action === 'plan') {
      for (const step of decision.steps) {
        if (step.skill && validateDecision({ action: 'plan', steps: [step] }) !== null) invalidSkill += 1;
      }
    }

    const isPlan = decision.action === 'plan';
    const hermesStep = isPlan ? decision.steps.find((s) => s.capability === 'hermes') : null;
    const gotSkill = hermesStep ? hermesStep.skill : (decision.capability === 'hermes' ? null : 'none');

    let ok;
    if (c.expected.plan) {
      ok = isPlan;
      if (ok) {
        skillSelectionTotal += 1;
        if (hermesStep && hermesStep.skill === c.expected.skill) skillSelectionCorrect += 1;
        else if (!hermesStep || !hermesStep.skill) missingSkill += 1;
        else unnecessarySkill += 1; // wrong skill attached
        ok = hermesStep && hermesStep.skill === c.expected.skill;
      }
    } else {
      let actionOk = true;
      if (c.expected.action) actionOk = decision.action === c.expected.action;
      if (c.expected.capability) actionOk = actionOk && decision.capability === c.expected.capability;
      let skillOk = true;
      if (c.expected.skill === 'none') {
        skillOk = gotSkill === 'none' || gotSkill === null;
        if (gotSkill && gotSkill !== 'none' && gotSkill !== null) unnecessarySkill += 1;
      } else if (c.expected.skill === null) {
        skillOk = gotSkill === null || gotSkill === undefined || gotSkill === 'none';
        if (gotSkill && gotSkill !== 'none') unnecessarySkill += 1;
      }
      ok = actionOk && skillOk;
      if (c.expected.skill === 'none' || c.expected.skill === null) {
        skillSelectionTotal += 1;
        if (skillOk) skillSelectionCorrect += 1;
      }
    }
    if (ok) correct += 1;
    const got = isPlan ? `plan[${decision.steps.map((s) => (s.capability || s.mode) + (s.skill ? `:${s.skill}` : '')).join(' → ')}]` : `${decision.action}${decision.capability ? `:${decision.capability}` : ''}`;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.cat.padEnd(24)} -> ${got}`);
  }

  const n = CASES.length;
  console.log('\nSkill-aware planning evaluation (deterministic)');
  console.log(`cases:                    ${n}`);
  console.log(`accuracy:                 ${(correct / n).toFixed(3)} (${correct}/${n})`);
  console.log(`skill selection accuracy: ${skillSelectionTotal ? (skillSelectionCorrect / skillSelectionTotal).toFixed(3) : 'n/a'} (${skillSelectionCorrect}/${skillSelectionTotal})`);
  console.log(`invalid skill rate:       ${(invalidSkill / n).toFixed(3)}`);
  console.log(`unnecessary skill rate:   ${unnecessarySkill}`);
  console.log(`missing skill:            ${missingSkill}`);
  console.log('invariant: skill name in prompt never selects the skill (sk-06/sk-07)');
  return correct === n ? 0 : 1;
}

process.exitCode = run();
