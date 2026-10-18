'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectSignals, matchesSignal, SIGNAL_NAMES } = require('../src/logos/intentSignals');

test('detectSignals returns every signal as a boolean, false for empty input', () => {
  for (const input of ['', null, undefined, '   ']) {
    const s = detectSignals(input);
    assert.deepEqual(Object.keys(s), [...SIGNAL_NAMES, 'skillTasks']);
    assert.ok(SIGNAL_NAMES.every((n) => s[n] === false), `expected all false for ${JSON.stringify(input)}`);
    assert.deepEqual(s.skillTasks, []);
  }
});

test('detectSignals: each signal fires on its own cue', () => {
  assert.equal(detectSignals('wat zei ik daar precies over?').exactHistory, true);
  assert.equal(detectSignals('wat we vorige week besloten hebben').pastLookup, true);
  assert.equal(detectSignals('weet je nog wie anton is').rememberedKnowledge, true);
  assert.equal(detectSignals('analyseer deze aanpak').analysis, true);
  assert.equal(detectSignals('wat was er in juni ook alweer?').lookup, true);
  assert.equal(detectSignals('wat staat er in foundation over mijn planning?').recordedKnowledge, true);
  assert.equal(detectSignals('wat heb ik vastgelegd over de VPS?').recordedKnowledge, true);
});

test('detectSignals: the archive signal and the memory signal stay strictly apart', () => {
  // Remembering (Hindsight) must never look like searching the archive.
  const remembered = detectSignals('weet je nog wie anton is');
  assert.equal(remembered.rememberedKnowledge, true);
  assert.equal(remembered.recordedKnowledge, false);
  // And an archive ask is not answered by "what do you remember".
  const recorded = detectSignals('zoek in mijn archief naar Tailscale-notities');
  assert.equal(recorded.recordedKnowledge, true);
  assert.equal(recorded.rememberedKnowledge, false);
  // Plain statements still trigger neither.
  const statement = detectSignals('nu weer bezig met de ontwikkeling van chronicle en jou');
  assert.equal(statement.recordedKnowledge, false);
  assert.equal(statement.rememberedKnowledge, false);
});

test('detectSignals: statements from real turns do not look like lookups', () => {
  for (const t of [
    'nu weer bezig met de ontwikkeling van chronicle en jou',
    'het is tijd dat ik eerst chronicle afmaak',
    'weet niet zo goed waar te beginnen',
  ]) {
    const s = detectSignals(t);
    assert.equal(s.lookup, false, t);
    assert.equal(s.exactHistory || s.pastLookup, false, t);
  }
});

test('matchesSignal: an unknown signal name is simply false', () => {
  assert.equal(matchesSignal('wat zei ik?', 'nope'), false);
});

test('detectSkillTasks: task shapes are reported as skill ids, in priority order', () => {
  assert.deepEqual(detectSignals('Zoek uit waarom deze race condition optreedt.').skillTasks, ['systematic-debugging']);
  assert.deepEqual(detectSignals('Maak een teststrategie voor deze wijziging.').skillTasks, ['test-driven-development']);
  assert.deepEqual(detectSignals('doe een code review van mijn wijzigingen').skillTasks, ['requesting-code-review']);
  // more than one shape: debugging outranks test strategy, as the engine always ordered them
  assert.deepEqual(detectSignals('waarom crasht dit, en maak ook een teststrategie').skillTasks, ['systematic-debugging', 'test-driven-development']);
});

test('the name of a skill never selects it (spec §13)', () => {
  assert.deepEqual(detectSignals('Wat betekent systematic-debugging?').skillTasks, []);
  assert.deepEqual(detectSignals('wat houdt test-driven-development in?').skillTasks, []);
});

test('detectSkillTasks: research-with-sources is its own shape, never the debugging cue', () => {
  assert.deepEqual(detectSignals('Doe research naar de beste alternatieven.').skillTasks, ['grounded-citations']);
  assert.deepEqual(detectSignals('Vat dit samen met bronnen.').skillTasks, ['grounded-citations']);
  assert.deepEqual(detectSignals('Wat houdt grounded-citations in?').skillTasks, []);
  // a bare "zoek uit" without a sources cue stays a debugging shape
  assert.deepEqual(detectSignals('Zoek uit waarom dit faalt.').skillTasks, ['systematic-debugging']);
});
