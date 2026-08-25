'use strict';

/**
 * Generation Policy 0.1 evaluation — deterministic, no model.
 *
 * Usage: node eval/run-generation-policy.js  (or: npm run eval:genpolicy)
 *
 * Measures:
 *   - native_default_rate: how often native is the default
 *   - unnecessary_hermes_rate: Hermes used without an explicit reason (MUST be 0)
 *   - missing_hermes_rate: deep reasoning/skill not routed to Hermes
 *   - plan_accuracy: plans use the minimum sufficient set
 *
 * Headline metric: unnecessary_hermes_rate must be 0.
 */

const { decide } = require('../src/decision/decisionEngine');

const FULL_REGISTRY = [
  { id: 'hermes' }, { id: 'native' }, { id: 'web' },
  { id: 'conversation_search' }, { id: 'hindsight' },
];

/**
 * Evaluation cases organized by category.
 * expected.generationMode: what the generation policy should choose
 * expected.action: what the decision engine should do (optional, for plan cases)
 * expected.caps: ordered capabilities in plan steps (optional, for plan cases)
 */
const CASES = [
  // --- native_only: simple conversational turns ---
  { id: 'gp-01', cat: 'native_only', input: 'Hoi Gaia', intent: null, expected: { generationMode: 'native', action: 'native' } },
  { id: 'gp-02', cat: 'native_only', input: 'Ik ben blij dat je er bent vandaag.', intent: { intent: 'converse', status: 'accepted', sourceOfTruth: 'conversation' }, expected: { generationMode: 'native', action: 'native' } },
  { id: 'gp-03', cat: 'native_only', input: 'Hoe gaat het met je?', intent: { intent: 'greet', status: 'accepted', sourceOfTruth: 'conversation' }, expected: { generationMode: 'native', action: 'native' } },
  { id: 'gp-04', cat: 'native_only', input: 'Bedankt voor je hulp!', intent: { intent: 'acknowledge', status: 'accepted', sourceOfTruth: 'conversation' }, expected: { generationMode: 'native', action: 'native' } },
  { id: 'gp-05', cat: 'native_only', input: 'Tot ziens!', intent: { intent: 'farewell', status: 'accepted', sourceOfTruth: 'conversation' }, expected: { generationMode: 'native', action: 'native' } },
  { id: 'gp-06', cat: 'native_only', input: 'Wat vind je hiervan?', intent: { intent: 'converse', status: 'accepted', sourceOfTruth: 'conversation' }, expected: { generationMode: 'native', action: 'native' } },
  { id: 'gp-07', cat: 'native_only', input: 'Kun je dit uitleggen?', intent: { intent: 'converse', status: 'accepted', sourceOfTruth: 'conversation' }, expected: { generationMode: 'native', action: 'native' } },
  { id: 'gp-08', cat: 'native_only', input: 'Wat weet je nog van mij?', intent: { intent: 'memory.inspect', status: 'accepted', sourceOfTruth: 'memory' }, expected: { generationMode: 'native', action: 'native' } },

  // --- deep_reasoning: turns requiring Hermes ---
  { id: 'gp-09', cat: 'deep_reasoning', input: 'analyseer deze race condition', intent: { intent: 'inform.explain', sourceOfTruth: 'external_knowledge' }, reasoning: { reasoningDepth: 'deep' }, expected: { generationMode: 'plan', caps: ['web', 'hermes', 'native'] } },
  { id: 'gp-10', cat: 'deep_reasoning', input: 'diepgaande architectuuranalyse', intent: { intent: 'inform.explain', sourceOfTruth: 'conversation' }, reasoning: { reasoningDepth: 'deep' }, caps: [{ id: 'hermes' }, { id: 'native' }], expected: { generationMode: 'hermes', action: 'capability', cap: 'hermes' } },

  // --- specific_skill: Hermes skill tasks ---
  { id: 'gp-11', cat: 'specific_skill', input: 'Waarom crasht mijn applicatie steeds?', intent: { intent: 'inform.explain', sourceOfTruth: 'external_knowledge' }, expected: { generationMode: 'plan', caps: ['web', 'hermes', 'native'] } },

  // --- multi_source_synthesis: plans with multiple retrievals ---
  { id: 'gp-12', cat: 'multi_source_synthesis', input: 'Wat weet je nog van mijn Gaia-plannen en wat zei ik daar vorige maand precies over?', intent: null, expected: { generationMode: 'plan', caps: ['conversation_search', 'hindsight', 'native'] } },
  { id: 'gp-13', cat: 'multi_source_synthesis', input: 'Zoek wat we vorige maand over Hindsight besloten en analyseer of die keuze nog logisch is.', intent: null, expected: { generationMode: 'plan', caps: ['conversation_search', 'hermes', 'native'] } },

  // --- hermes_plus_native: Hermes reasoning + native generation ---
  { id: 'gp-14', cat: 'hermes_plus_native', input: 'Combineer wat je over dit project weet met deze nieuwe analyse.', intent: null, expected: { generationMode: 'plan', caps: ['hindsight', 'hermes', 'native'] } },

  // --- clarify: ambiguous turns ---
  { id: 'gp-15', cat: 'clarify', input: 'stuur het naar hem en herschrijf het ook', intent: { intent: null, status: 'ambiguous', needsClarification: true }, expected: { generationMode: 'native', action: 'clarify' } },

  // --- capability_unavailable: hermes not available ---
  { id: 'gp-16', cat: 'capability_unavailable', input: 'diepgaande analyse', intent: { intent: 'inform.explain', sourceOfTruth: 'external_knowledge' }, reasoning: { reasoningDepth: 'deep' }, caps: [{ id: 'native' }], expected: { generationMode: 'hermes', action: 'clarify' } },

  // --- meta-intents: always native ---
  { id: 'gp-17', cat: 'native_only', input: 'waarom koos je voor websearch?', intent: { intent: 'meta.question', sourceOfTruth: 'conversation' }, expected: { generationMode: 'native', action: 'native' } },
  { id: 'gp-18', cat: 'native_only', input: 'nee, ik bedoel iets anders', intent: { intent: 'meta.correction', sourceOfTruth: 'conversation' }, expected: { generationMode: 'native', action: 'native' } },
];

function run() {
  let correct = 0;
  let unnecessaryHermes = 0;
  let missingHermes = 0;
  let nativeCount = 0;
  let hermesCount = 0;
  let planCount = 0;
  let totalPlannedSteps = 0;

  for (const c of CASES) {
    const availableCaps = c.caps || FULL_REGISTRY;
    const decision = decide({
      userInput: c.input,
      intent: c.intent || null,
      context: { reflections: [], mentalModels: [], patterns: [] },
      reasoning: c.reasoning || null,
      availableCapabilities: availableCaps,
    });

    const mode = decision.generationMode;
    const isPlan = decision.action === 'plan';

    if (mode === 'native') nativeCount += 1;
    else if (mode === 'hermes') hermesCount += 1;
    else if (mode === 'plan') { planCount += 1; totalPlannedSteps += (decision.steps || []).length; }

    let ok = true;

    // Check generation mode
    if (mode !== c.expected.generationMode) {
      ok = false;
      // Track unnecessary Hermes
      if (mode === 'hermes' && c.expected.generationMode === 'native') {
        unnecessaryHermes += 1;
      }
      // Track missing Hermes
      if (mode === 'native' && c.expected.generationMode === 'hermes') {
        missingHermes += 1;
      }
    }

    // Check action (when specified)
    if (ok && c.expected.action && decision.action !== c.expected.action) {
      ok = false;
    }

    // Check plan caps (when specified)
    if (ok && c.expected.caps && isPlan) {
      const gotCaps = decision.steps.map((s) => s.capability || s.mode);
      const expectedSet = new Set(c.expected.caps);
      const gotSet = new Set(gotCaps);
      if (expectedSet.size !== gotSet.size || ![...expectedSet].every((x) => gotSet.has(x))) {
        ok = false;
      }
    }

    // Check single cap (when specified)
    if (ok && c.expected.cap && decision.capability !== c.expected.cap) {
      ok = false;
    }

    if (ok) correct += 1;

    const status = ok ? 'PASS' : 'FAIL';
    const detail = isPlan
      ? `plan[${decision.steps.map((s) => s.capability || s.mode).join(' → ')}]`
      : `${decision.action} (mode: ${mode})`;
    console.log(`  ${status}  ${c.id}  ${c.cat.padEnd(24)} -> ${detail}`);
  }

  const n = CASES.length;
  console.log('\nGeneration Policy 0.1 evaluation (deterministic)');
  console.log(`cases:                     ${n}`);
  console.log(`plan accuracy:             ${(correct / n).toFixed(3)} (${correct}/${n})`);
  console.log(`unnecessary hermes rate:    ${unnecessaryHermes} / ${n} (${(unnecessaryHermes / n).toFixed(3)})`);
  console.log(`missing hermes rate:        ${missingHermes} / ${n} (${(missingHermes / n).toFixed(3)})`);
  console.log(`native default rate:        ${nativeCount} / ${n}`);
  console.log(`hermes direct rate:         ${hermesCount} / ${n}`);
  console.log(`plan rate:                  ${planCount} / ${n}`);
  console.log(`avg plan steps:             ${planCount ? (totalPlannedSteps / planCount).toFixed(2) : '0.00'}`);
  console.log('headline metric:           unnecessary_hermes_rate must be 0');
  return unnecessaryHermes === 0 && correct === n ? 0 : 1;
}

process.exitCode = run();
