'use strict';

/**
 * Decision Engine 3.0 planning evaluation — deterministic, no model (spec §30).
 *
 * Usage: node eval/run-planning.js  (or: npm run eval:planning)
 *
 * Measures plan accuracy, unnecessary-capability rate, missing-capability
 * rate and average plan length. The headline metric:
 *
 *   > Did Gaia use the MINIMUM SUFFICIENT set of capabilities?
 *
 * Expected shapes are capability SETS (order-insensitive) plus the action;
 * 'native-with-context' means the existing single native path with automatic
 * pre-decide Hindsight recall — NOT a plan (spec §17 duplicate-retrieval
 * avoidance; documented deviation from the raw §25 sketch).
 */

const { buildPlan, decide } = require('../src/decision/decisionEngine');

const FULL_REGISTRY = [
  { id: 'hermes' }, { id: 'native' }, { id: 'web' },
  { id: 'conversation_search' }, { id: 'hindsight' },
];

// expected.plan = ordered step capabilities/modes ('no-plan' when the turn
// must NOT become a plan); expected.action for no-plan cases.
const CASES = [
  // --- native only ---
  { id: 'p-01', cat: 'native only', input: 'Hoi Gaia', intent: null, expected: { plan: false, action: 'native', caps: [] } },
  { id: 'p-02', cat: 'native only', input: 'Ik ben blij dat je er bent vandaag.', intent: { intent: 'converse', status: 'accepted', sourceOfTruth: 'conversation' }, expected: { plan: false, action: 'native', caps: [] } },
  { id: 'p-03', cat: 'clarify', input: 'stuur het naar hem en herschrijf het ook', intent: { intent: null, status: 'ambiguous', needsClarification: true }, expected: { plan: false, action: 'clarify', caps: [] } },

  // --- hindsight only (existing path, NO plan) ---
  { id: 'p-04', cat: 'hindsight only', input: 'Wat weet je nog van mijn voorkeuren?', intent: { intent: 'memory.inspect', status: 'accepted', sourceOfTruth: 'memory' }, expected: { plan: false, action: 'native', caps: [] } },
  { id: 'p-05', cat: 'hindsight only', input: 'Wat weet je nog over mijn projecten?', intent: { intent: 'memory.inspect', status: 'accepted', sourceOfTruth: 'memory' }, expected: { plan: false, action: 'native', caps: [] } },

  // --- conversation search only → minimal [cs → native] plan ---
  { id: 'p-06', cat: 'conversation search only', input: 'Wat zei ik vorige maand letterlijk over Gaia?', intent: null, expected: { plan: true, caps: ['conversation_search', 'native'] } },
  { id: 'p-07', cat: 'conversation search only', input: 'Wat zei ik precies over de migratie?', intent: null, expected: { plan: true, caps: ['conversation_search', 'native'] } },

  // --- both retrieval sources ---
  { id: 'p-08', cat: 'both retrieval sources', input: 'Wat weet je nog van mijn Gaia-plannen en wat zei ik daar vorige maand precies over?', intent: null, expected: { plan: true, caps: ['conversation_search', 'hindsight', 'native'] } },

  // --- retrieval + Hermes ---
  { id: 'p-09', cat: 'retrieval + Hermes', input: 'Zoek wat we vorige maand over Hindsight besloten en analyseer of die keuze nog logisch is.', intent: null, expected: { plan: true, caps: ['conversation_search', 'hermes', 'native'] } },
  { id: 'p-10', cat: 'retrieval + Hermes', input: 'Combineer wat je over dit project weet met deze nieuwe analyse.', intent: null, expected: { plan: true, caps: ['hindsight', 'hermes', 'native'] } },

  // --- web + Hermes (+ native) ---
  { id: 'p-11', cat: 'web + Hermes', input: 'Zoek actuele informatie hierover en vergelijk die met mijn eerdere Gaia-architectuur.', intent: { intent: 'inform.explain', status: 'accepted', sourceOfTruth: 'external_knowledge' }, expected: { plan: true, caps: ['web', 'hermes', 'native'] } },

  // --- web only → web → native (minimum-sufficient: no hermes) ---
  { id: 'p-13', cat: 'web only', input: 'Wat is momenteel de aanbevolen manier om mijn stem in Suno te uploaden?', intent: { intent: 'inform.explain', status: 'accepted', sourceOfTruth: 'external_knowledge' }, expected: { plan: true, caps: ['web', 'native'] } },
  { id: 'p-14', cat: 'web only', input: 'Hoe werkt de huidige Suno voice upload?', intent: { intent: 'inform.explain', status: 'accepted', sourceOfTruth: 'external_knowledge' }, expected: { plan: true, caps: ['web', 'native'] } },

  // --- refuse never selected in v0.1 policy; pinned as not-a-plan ---
  { id: 'p-12', cat: 'refuse', input: 'doe dat verboden ding nu.', intent: { intent: null, status: 'unknown' }, expected: { plan: false, caps: [] } },
];

function run() {
  let correct = 0;
  let unnecessaryCaps = 0; let missingCaps = 0;
  let plannedTurns = 0; let totalPlanSteps = 0;

  for (const c of CASES) {
    const decision = decide({
      userInput: c.input,
      intent: c.intent,
      context: { reflections: [], mentalModels: [], patterns: [] },
      reasoning: null,
      availableCapabilities: FULL_REGISTRY,
    });

    const isPlan = decision.action === 'plan';
    let gotCaps = [];
    if (isPlan) {
      gotCaps = decision.steps.map((s) => s.capability || s.mode);
      plannedTurns += 1;
      totalPlanSteps += decision.steps.length;
    }

    let ok;
    if (c.expected.plan) {
      ok = isPlan;
      if (ok) {
        const expectedSet = new Set(c.expected.caps);
        const gotSet = new Set(gotCaps);
        for (const g of gotSet) if (!expectedSet.has(g)) unnecessaryCaps += 1;
        for (const e of expectedSet) if (!gotSet.has(e)) missingCaps += 1;
        ok = expectedSet.size === gotSet.size && [...expectedSet].every((x) => gotSet.has(x));
      }
    } else {
      ok = !isPlan && (!c.expected.action || decision.action === c.expected.action);
      // Unnecessary retrieval inside single-action turns would show up as
      // unexpected capability choice:
      if (decision.capability && c.expected.caps.length === 0 && decision.capability !== c.expected.capability) {
        unnecessaryCaps += 1;
      }
    }
    if (ok) correct += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.cat.padEnd(26)} -> ${isPlan ? `plan[${gotCaps.join(' → ')}]` : decision.action}`);
  }

  const n = CASES.length;
  console.log('\nDecision Engine 3.0 planning evaluation (deterministic)');
  console.log(`cases:                     ${n}`);
  console.log(`plan accuracy:             ${(correct / n).toFixed(3)} (${correct}/${n})`);
  console.log(`unnecessary capability use:${' '}${unnecessaryCaps}`);
  console.log(`missing capability rate:   ${(missingCaps / n).toFixed(3)}`);
  console.log(`average plan steps:        ${plannedTurns ? (totalPlanSteps / plannedTurns).toFixed(2) : '0.00'} (planned turns: ${plannedTurns})`);
  console.log('headline metric:           minimum sufficient set — unnecessary=0 required');
  return correct === n ? 0 : 1;
}

process.exitCode = run();
