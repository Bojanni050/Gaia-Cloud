'use strict';

/**
 * Memoryworthiness 0.1 — deterministic gate between IntentIQ and Hindsight.
 *
 * Spec §17 matrix: greetings/acks discard, explicit requests/preferences/
 * corrections/important facts retain, duplicates downgrade, new info on a
 * known topic retains, contradictions retain, intent is input-not-verdict,
 * clear cases never trigger any LLM.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  evaluateMemoryWorthiness,
  shouldRetainToHindsight,
  metadataForMemoryDecision,
  logMemoryWorthiness,
  ACTIONS,
} = require('../src/memoryWorthiness');

function evaluate(text, extra = {}) {
  return evaluateMemoryWorthiness({ userInput: text, ...extra });
}

// --- §9: three outcomes only --------------------------------------------------

test('exposes exactly the three actions', () => {
  assert.deepEqual(ACTIONS, ['discard', 'retain_low_priority', 'retain']);
});

// --- §17: greeting / acknowledgement / filler ---------------------------------

test('greetings discard', () => {
  assert.equal(evaluate('Hoi Gaia').action, 'discard');
  assert.equal(evaluate('Goedemorgen!').action, 'discard');
});

test('acknowledgements discard', () => {
  assert.equal(evaluate('Oké').action, 'discard');
  assert.equal(evaluate('Ja precies.').action, 'discard');
  assert.equal(evaluate('prima hoor').action, 'discard');
  assert.equal(evaluate('haha mooi gedaan').action, 'discard');
});

test('a longer pure-reaction turn still discards', () => {
  // >12 chars so memoryPolicy's length floor alone would pass it.
  const d = evaluate('Ja dat klopt helemaal precies zo');
  assert.equal(d.action, 'discard');
  assert.ok(
    d.reasons.includes('trivial_or_acknowledgement') || d.reasons.includes('below_retain_threshold'),
    `expected an explicit discard reason, got ${JSON.stringify(d.reasons)}`
  );
});

// --- §17: strong retains --------------------------------------------------------

test('explicit preference retains', () => {
  const d = evaluate('Ik wil voortaan korte antwoorden.');
  assert.equal(d.action, 'retain');
  assert.ok(d.dimensions.explicitRecallRequest >= 2);
  assert.ok(d.reasons.includes('explicit_preference'));
});

test('explicit memory request retains', () => {
  const d = evaluate('Onthoud dat ik maandag altijd laat werk.');
  assert.equal(d.action, 'retain');
  assert.ok(d.reasons.includes('explicit_memory_request'));
});

test('correction retains', () => {
  const d = evaluate('Nee, dat klopt niet meer.');
  assert.equal(d.action, 'retain');
  assert.equal(d.dimensions.correctionValue, 3);
  assert.ok(d.reasons.includes('correction_language'));
});

test('important personal fact retains', () => {
  assert.equal(evaluate('Ik verhuis volgende maand.').action, 'retain');
  assert.equal(evaluate('Ik ben sinds vandaag weer fulltime met Gaia bezig.').action, 'retain');
  assert.equal(evaluate('Mijn dochter begint volgende week op nieuwe school.').action, 'retain');
});

test('temporary context discards or stays low priority', () => {
  assert.notEqual(evaluate('Ik ben even koffie halen.').action, 'retain');
  assert.equal(evaluate('Oké, ik ga even koffie pakken.').action, 'discard');
  assert.ok(evaluate('Ik ben even koffie halen.').dimensions.persistence <= 1);
});

// --- §5: value relative to existing memory --------------------------------------

test('duplicate of existing memory downgrades to low priority', () => {
  const mem = { recalledReflections: [{ text: 'Bo wil graag korte antwoorden' }] };
  const d = evaluate('Ik wil graag korte antwoorden.', { existingMemorySignals: mem });
  assert.equal(d.action, 'retain_low_priority');
  assert.ok(d.reasons.some((r) => r.startsWith('duplicate')));
});

test('near-identical duplicate without other signals discards entirely', () => {
  const mem = { recalledReflections: [{ text: 'Bo werkt aan zijn Melodiq muziekproject in de avonduren' }] };
  const d = evaluate('ik werk aan melodiq', { existingMemorySignals: mem });
  assert.ok(['discard', 'retain_low_priority'].includes(d.action));
});

test('new information on a known topic still retains', () => {
  const mem = { recalledReflections: [{ text: 'Bo werkt in de avonden aan Melodiq' }] };
  const d = evaluate(
    'Vanaf deze week heb ik een vaste studio voor mijn Melodiq werk, elke dinsdag.',
    { existingMemorySignals: mem }
  );
  assert.notEqual(d.action, 'discard');
});

test('contradiction of existing memory retains with high correction value', () => {
  const mem = { recalledReflections: [{ text: 'Bo wil graag korte antwoorden' }] };
  const d = evaluate('Eigenlijk wil ik juist uitgebreidere antwoorden.', { existingMemorySignals: mem });
  assert.equal(d.action, 'retain');
  assert.equal(d.dimensions.correctionValue, 3);
});

test('corrections outrank duplication — a corrected fact is never discarded as duplicate', () => {
  const mem = { recalledReflections: [{ text: 'Bo woont in Utrecht' }] };
  const d = evaluate('Ik woon niet meer in Utrecht, ik ben verhuisd naar Den Bosch.', { existingMemorySignals: mem });
  assert.equal(d.action, 'retain');
});

// --- §6: intent is input, not verdict --------------------------------------------

test('intent separation: intent shifts the judgment without dictating it', () => {
  // (a) memory.correct INTENT alone lifts a neutral-sounding correction
  // above the same text classified as small talk.
  const neutral = 'Dat is anders dan je eerder hebt.';
  const asCorrect = evaluate(neutral, { intent: { intent: 'memory.correct', status: 'accepted', entities: [] } });
  const asConverse = evaluate(neutral, { intent: { intent: 'converse', status: 'accepted', entities: [] } });
  assert.ok(asCorrect.score > asConverse.score, 'memory.correct must raise correction value');
  assert.ok(asCorrect.dimensions.correctionValue >= 2);
  assert.equal(asConverse.dimensions.correctionValue, 0);

  // (b) an inspection INTENT does not manufacture retain-worthiness.
  const inspect = evaluate('Even kijken wat er staat.', { intent: { intent: 'memory.inspect', status: 'accepted', entities: [] } });
  assert.notEqual(inspect.action, 'retain');

  // (c) lexical correction language dominates regardless of weak intents.
  for (const intent of ['converse', 'memory.inspect']) {
    assert.equal(
      evaluate('Nee, dat klopt niet meer.', { intent: { intent, status: 'accepted', entities: [] } }).action,
      'retain'
    );
  }
});

test('inform.explain can still be memory-worthy when it carries a personal fact (§6 example)', () => {
  const d = evaluate('Ik ben sinds vandaag weer fulltime met Gaia bezig.', {
    intent: { intent: 'inform.explain', status: 'accepted', entities: [] },
  });
  assert.equal(d.action, 'retain');
});

test('memory.inspect alone does not force a retain — inspection is read-only', () => {
  const d = evaluate('Wat weet jij nog over mijn projecten?', {
    intent: { intent: 'memory.inspect', status: 'accepted', entities: [] },
  });
  assert.notEqual(d.action, 'retain', 'an inspection question is not itself new memory');
});

// --- structure & metadata ---------------------------------------------------------

test('decisions carry dimensions on the documented 0-3 scale', () => {
  const d = evaluate('Onthoud dat ik verhuis volgende maand en dat mijn baan verandert.');
  for (const v of Object.values(d.dimensions)) {
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 3);
  }
});

test('shouldRetainToHindsight gates only discard', () => {
  assert.equal(shouldRetainToHindsight({ action: 'retain' }), true);
  assert.equal(shouldRetainToHindsight({ action: 'retain_low_priority' }), true);
  assert.equal(shouldRetainToHindsight({ action: 'discard' }), false);
  assert.equal(shouldRetainToHindsight(null), false);
});

test('metadata uses the gaia_memory_* namespace and marks low priority', () => {
  const low = metadataForMemoryDecision({ action: 'retain_low_priority', score: 0.4, reasons: ['duplicate_downgrade'] });
  assert.equal(low.gaia_memory_decision, 'retain_low_priority');
  assert.equal(low.gaia_memory_priority, 'low');
  assert.match(low.gaia_memory_reason, /duplicate_downgrade/);

  const normal = metadataForMemoryDecision({ action: 'retain', score: 0.8, reasons: ['explicit_preference'] });
  assert.equal(normal.gaia_memory_priority, 'normal');
  assert.equal(metadataForMemoryDecision(null), undefined);
});

test('logMemoryWorthiness emits action/score/reasons without user content and survives garbage', () => {
  const lines = [];
  logMemoryWorthiness(evaluate('Onthoud dat ik van houd'), 2, (l) => lines.push(l));
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.kind, 'memory.worthiness');
  assert.ok(typeof parsed.latencyMs === 'number');
  assert.ok(!JSON.stringify(parsed).includes('van houd'));

  assert.doesNotThrow(() => logMemoryWorthiness(null, 0));
});

// --- §10/§16: deterministic by construction, no LLM -------------------------------

test('boundary: the module performs no I/O and loads no model clients', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/memoryWorthiness.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepEqual(required, ['./memoryPolicy'],
    'memoryworthiness must reuse only the existing policy vocabulary — no model client, no hindsight, no fetch');
  assert.ok(!/fetch\(|http|openRouter|intentModelClient/i.test(source));
});

test('clear cases are decided identically across runs (pure determinism)', () => {
  const a = evaluate('Hoi Gaia');
  const b = evaluate('Hoi Gaia');
  assert.deepEqual(a, b);
});

test('evaluation latency is negligible (deterministic, sub-millisecond scale)', () => {
  const start = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) evaluate('Ik wil voortaan korte antwoorden.');
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `1000 evaluations took ${ms}ms`);
});
