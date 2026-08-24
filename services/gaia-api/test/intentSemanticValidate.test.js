'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAndValidateSemanticOutput, MalformedSemanticOutputError } = require('../src/logos/intentSemanticValidate');

test('parseAndValidateSemanticOutput: happy path parses fully', () => {
  const raw = JSON.stringify({
    intent: 'decide.support',
    confidence: 0.87,
    candidates: [{ intent: 'decide.support', confidence: 0.87 }, { intent: 'converse', confidence: 0.09 }],
    sourceOfTruth: 'conversation',
    speechAct: 'advice_request',
    referents: [{ expression: 'dit', resolvedTo: 'the previous topic', confidence: 0.91 }],
    ambiguous: false,
    reason: 'The user is asking for help evaluating a decision.',
  });
  const result = parseAndValidateSemanticOutput(raw);
  assert.equal(result.intent, 'decide.support');
  assert.equal(result.confidence, 0.87);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.sourceOfTruth, 'conversation');
  assert.equal(result.speechAct, 'advice_request');
  assert.deepEqual(result.referents, [
    { expression: 'dit', resolvedTo: 'the previous topic', confidence: 0.91, source: 'conversation' },
  ]);
  assert.equal(result.ambiguous, false);
  assert.equal(result.reason, 'The user is asking for help evaluating a decision.');
});

test('parseAndValidateSemanticOutput: throws on non-JSON', () => {
  assert.throws(() => parseAndValidateSemanticOutput('not json'), MalformedSemanticOutputError);
});

test('parseAndValidateSemanticOutput: throws when top-level output is an array', () => {
  assert.throws(() => parseAndValidateSemanticOutput('[1,2,3]'), MalformedSemanticOutputError);
});

test('parseAndValidateSemanticOutput: an unknown intent id degrades to null, not a throw', () => {
  const result = parseAndValidateSemanticOutput(JSON.stringify({ intent: 'made.up.intent', confidence: 0.9 }));
  assert.equal(result.intent, null);
  assert.equal(result.confidence, 0); // no valid intent -> confidence is meaningless, forced to 0
});

test('parseAndValidateSemanticOutput: missing optional fields default sensibly, never throw', () => {
  const result = parseAndValidateSemanticOutput(JSON.stringify({ intent: 'converse' }));
  assert.equal(result.intent, 'converse');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.sourceOfTruth, 'unknown');
  assert.equal(result.speechAct, null);
  assert.deepEqual(result.referents, []);
  assert.equal(result.ambiguous, false);
  assert.equal(result.reason, null);
});

test('parseAndValidateSemanticOutput: candidates with unknown intent ids are dropped, not thrown', () => {
  const result = parseAndValidateSemanticOutput(JSON.stringify({
    intent: 'converse',
    candidates: [{ intent: 'converse', confidence: 0.9 }, { intent: 'not.a.real.intent', confidence: 0.5 }],
  }));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].intent, 'converse');
});

test('parseAndValidateSemanticOutput: confidence is clamped and never reported as exactly 1', () => {
  const result = parseAndValidateSemanticOutput(JSON.stringify({ intent: 'converse', confidence: 1 }));
  assert.ok(result.confidence <= 0.95);
});

test('parseAndValidateSemanticOutput: an invalid sourceOfTruth/speechAct falls back to a safe default rather than throwing', () => {
  const result = parseAndValidateSemanticOutput(JSON.stringify({
    intent: 'converse',
    sourceOfTruth: 'nonsense',
    speechAct: 'nonsense',
  }));
  assert.equal(result.sourceOfTruth, 'unknown');
  assert.equal(result.speechAct, null);
});

test('parseAndValidateSemanticOutput: malformed referent entries are dropped, not thrown', () => {
  const result = parseAndValidateSemanticOutput(JSON.stringify({
    intent: 'converse',
    referents: [{ expression: 'dit', resolvedTo: 'x' }, { resolvedTo: 'missing expression' }, 'not an object'],
  }));
  assert.equal(result.referents.length, 1);
  assert.equal(result.referents[0].expression, 'dit');
});

// === IntentIQ 2.2: referent resolvedTo/confidence/source =====================

test('parseAndValidateSemanticOutput: resolvedTo: null is a legitimate, honest answer — not dropped, not thrown', () => {
  const result = parseAndValidateSemanticOutput(JSON.stringify({
    intent: 'inform.explain',
    referents: [{ expression: 'deze', resolvedTo: null, confidence: 0.31 }],
  }));
  assert.equal(result.referents.length, 1);
  assert.equal(result.referents[0].expression, 'deze');
  assert.equal(result.referents[0].resolvedTo, null);
  assert.equal(result.referents[0].confidence, 0.31);
  assert.equal(result.referents[0].source, null);
});

test('parseAndValidateSemanticOutput: a resolved referent carries source: conversation and its own confidence', () => {
  const result = parseAndValidateSemanticOutput(JSON.stringify({
    intent: 'inform.explain',
    referents: [{ expression: 'deze', resolvedTo: 'de architectuur die net besproken werd', confidence: 0.91 }],
  }));
  assert.equal(result.referents[0].resolvedTo, 'de architectuur die net besproken werd');
  assert.equal(result.referents[0].confidence, 0.91);
  assert.equal(result.referents[0].source, 'conversation');
});

test('parseAndValidateSemanticOutput: a referent with no stated confidence defaults to 0, not 0.5', () => {
  const result = parseAndValidateSemanticOutput(JSON.stringify({
    intent: 'inform.explain',
    referents: [{ expression: 'deze' }],
  }));
  assert.equal(result.referents[0].confidence, 0);
});
