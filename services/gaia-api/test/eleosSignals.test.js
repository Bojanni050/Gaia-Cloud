'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectEleosSignals, matchesEleosSignal } = require('../src/reasoning/eleosSignals');

test('detects voiced distress in Dutch and English', () => {
  assert.equal(detectEleosSignals('ik voel me echt rot vandaag').any, true);
  assert.equal(detectEleosSignals('ik ben best wel gestrest over werk').any, true);
  assert.equal(detectEleosSignals("honestly I'm feeling pretty sad lately").any, true);
  assert.equal(detectEleosSignals('een beetje bang voor morgen').any, true);
});

test('detects named life events', () => {
  assert.equal(detectEleosSignals('morgen heb ik mijn sollicitatiegesprek').any, true);
  assert.equal(detectEleosSignals('mijn oma is overleden').any, true);
  assert.equal(detectEleosSignals('I have a surgery scheduled next week').any, true);
});

test('stays quiet on ordinary turns', () => {
  assert.equal(detectEleosSignals('wat is de hoofdstad van Frankrijk?').any, false);
  assert.equal(detectEleosSignals('kun je deze code refactoren?').any, false);
  assert.equal(detectEleosSignals('').any, false);
  assert.equal(detectEleosSignals(null).any, false);
});

test('reports which signal groups matched', () => {
  const s = detectEleosSignals('ik ben verdrietig en ik heb morgen een examen');
  assert.deepEqual(s.kinds.sort(), ['distress', 'lifeEvent']);
  assert.equal(matchesEleosSignal('ik ben verdrietig', 'distress'), true);
  assert.equal(matchesEleosSignal('ik ben verdrietig', 'lifeEvent'), false);
});

test('word-boundary matching does not fire on substrings', () => {
  // "bange" inside an unrelated word must not trip the "bang" signal.
  assert.equal(detectEleosSignals('de aanbangconstructie is klaar').any, false);
});
