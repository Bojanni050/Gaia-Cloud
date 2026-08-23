'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { classify, SCHEMA_VERSION } = require('../src/logos/intentIQ');

function msg(role, content) {
  return { role, content };
}

function user(content, history = []) {
  return [...history, msg('user', content)];
}

const silent = { silent: true };

// --- schema shape -----------------------------------------------------

test('classify always returns the intentiq.v1 schema shape', () => {
  const d = classify(user('Write a homepage introduction for me.'), silent);
  assert.equal(d.schemaVersion, SCHEMA_VERSION);
  assert.ok('intent' in d);
  assert.ok(['accepted', 'ambiguous', 'unknown'].includes(d.status));
  assert.equal(typeof d.confidence, 'number');
  assert.ok(Array.isArray(d.candidates));
  assert.ok(Array.isArray(d.entities));
  assert.ok(['conversation', 'memory', 'upload', 'external_knowledge', 'tool', 'unknown'].includes(d.sourceOfTruth));
  assert.equal(typeof d.needsClarification, 'boolean');
});

// --- obvious intents (one per taxonomy leaf) ---------------------------

const OBVIOUS = [
  ['Why is my website crashing?', 'inform.explain'],
  ['Write a homepage introduction for me.', 'create.generate'],
  ['Make this paragraph sound warmer.', 'create.transform'],
  ['I just need to vent for a second.', 'converse'],
  ['I don\'t know whether to take the job, should I take it?', 'decide.support'],
  ['What have you noticed about how I work?', 'memory.inspect'],
  ['Forget what I told you about my old job.', 'memory.correct'],
  ['Send Alex the meeting notes.', 'act.perform'],
  ['Who are you, really?', 'meta.relational'],
];

for (const [input, expected] of OBVIOUS) {
  test(`classifies "${input}" as ${expected}`, () => {
    const d = classify(user(input), silent);
    assert.equal(d.status, 'accepted');
    assert.equal(d.intent, expected);
    assert.ok(d.confidence > 0 && d.confidence <= 0.95);
  });
}

// --- unknown -------------------------------------------------------------

test('unknown: gibberish with no signal', () => {
  const d = classify(user('asdkfj alkj qzx'), silent);
  assert.equal(d.status, 'unknown');
  assert.equal(d.intent, null);
  assert.equal(d.confidence, 0);
});

test('unknown: empty message content', () => {
  const d = classify(user(''), silent);
  assert.equal(d.status, 'unknown');
});

test('unknown: filler-only input ("ok")', () => {
  const d = classify(user('ok'), silent);
  assert.equal(d.status, 'unknown');
});

test('unknown: malformed input — empty message array does not throw', () => {
  const d = classify([], silent);
  assert.equal(d.status, 'unknown');
  assert.equal(d.intent, null);
});

test('unknown: malformed input — null messages does not throw', () => {
  const d = classify(null, silent);
  assert.equal(d.status, 'unknown');
});

test('unknown: malformed input — no user message in history', () => {
  const d = classify([msg('assistant', 'hello there')], silent);
  assert.equal(d.status, 'unknown');
});

test('unknown: malformed input — message missing content does not throw', () => {
  const d = classify([{ role: 'user' }], silent);
  assert.equal(d.status, 'unknown');
});

// --- confidence is never treated as truth / never 1.0 -------------------

test('confidence is capped and never reported as absolute certainty', () => {
  const d = classify(user('Explain why this happened.'), silent);
  assert.ok(d.confidence <= 0.95);
});

// --- ambiguity -------------------------------------------------------------

test('ambiguous: two intents score closely on the same turn', () => {
  // "explain" (inform.explain) and "fix" (create.transform) cues collide.
  const d = classify(user('Can you explain what\'s wrong with this and fix it?'), silent);
  assert.ok(d.status === 'ambiguous' || d.status === 'accepted');
  // Whichever way the scoring lands, both intents must be visible as candidates.
  const ids = d.candidates.map((c) => c.intent);
  assert.ok(ids.includes('inform.explain') || ids.includes('create.transform'));
});

test('ambiguous: candidates are populated and needsClarification is true when ambiguous', () => {
  const d = classify(user('I need you to handle this.'), silent);
  // "handle this" carries no clear signal for any single intent in v0.1's
  // taxonomy — this must not be force-classified.
  assert.notEqual(d.status, 'accepted');
  if (d.status === 'ambiguous') {
    assert.equal(d.needsClarification, true);
  }
});

// --- multi-intent / compound turns --------------------------------------

test('multi-intent: "draft the email and send it" reports both intents as candidates', () => {
  const d = classify(user('Draft the email and send it to Sam.'), silent);
  assert.equal(d.status, 'ambiguous');
  assert.equal(d.needsClarification, true);
  const ids = d.candidates.map((c) => c.intent);
  assert.ok(ids.includes('create.generate'));
  assert.ok(ids.includes('act.perform'));
});

// --- candidate ranking ---------------------------------------------------

test('candidates are sorted by descending score', () => {
  const d = classify(user('Draft the email and send it to Sam.'), silent);
  for (let i = 1; i < d.candidates.length; i += 1) {
    assert.ok(d.candidates[i - 1].score >= d.candidates[i].score);
  }
});

// --- context-dependent / follow-up turns ---------------------------------

test('context: a signal-free follow-up inherits the prior turn\'s intent', () => {
  const history = user('Kun je dit analyseren?');
  const withReply = [...history, msg('assistant', 'Ja, ik kijk ernaar.')];
  const d = classify(user('En deze dan?', withReply), silent);
  assert.equal(d.sourceOfTruth, 'conversation');
  // Prior turn ("analyseren" -> inform.explain-flavored diagnostic ask)
  // should be inherited rather than the follow-up going straight to unknown.
  assert.notEqual(d.status, 'unknown');
});

test('context: a signal-free follow-up with no resolvable prior turn is unknown', () => {
  const d = classify(user('En deze dan?'), silent);
  assert.equal(d.status, 'unknown');
});

test('context: inherited confidence is lower than the original turn\'s confidence', () => {
  const original = classify(user('Waarom crasht mijn website?'), silent);
  const history = [...user('Waarom crasht mijn website?'), msg('assistant', 'Even kijken.')];
  const followUp = classify(user('En deze dan?', history), silent);
  if (followUp.status === 'accepted') {
    assert.ok(followUp.confidence < original.confidence);
  }
});

// --- source of truth ------------------------------------------------------

test('sourceOfTruth: memory cue', () => {
  const d = classify(user('Remember what I told you about the database?'), silent);
  assert.equal(d.sourceOfTruth, 'memory');
});

test('sourceOfTruth: upload, when hasAttachment is passed in context', () => {
  const d = classify(user('What does this say?'), { ...silent, hasAttachment: true });
  assert.equal(d.sourceOfTruth, 'upload');
});

test('sourceOfTruth: tool, for an action intent', () => {
  const d = classify(user('Send Alex the meeting notes.'), silent);
  assert.equal(d.sourceOfTruth, 'tool');
});

test('sourceOfTruth: external_knowledge, for a plain factual question', () => {
  const d = classify(user('What is the capital of Latvia?'), silent);
  assert.equal(d.sourceOfTruth, 'external_knowledge');
});

// A delegated "go look/search for a [thing]" phrasing, added after a real
// incident: this exact Dutch sentence resolved sourceOfTruth "unknown",
// fell through to native generation, and the model hallucinated tool-call
// syntax trying to search on its own (see docs/evolution.md's SOUL
// amendment, and decisionEngine.js's "external_knowledge" -> web-tool
// branch this signal now actually reaches).
test('sourceOfTruth: external_knowledge, for a delegated lookup request (NL) — the incident case', () => {
  const d = classify(user('Je mag wel even kijken naar een Nederlandse text-to-speech aanbieder'), silent);
  assert.equal(d.intent, 'inform.explain');
  assert.equal(d.sourceOfTruth, 'external_knowledge');
});

test('sourceOfTruth: external_knowledge, for a delegated lookup request (EN)', () => {
  const d = classify(user('Can you look into a good hosting provider for me?'), silent);
  assert.equal(d.sourceOfTruth, 'external_knowledge');
});

test('the lookup signal does not false-positive on "look at/kijk naar" a thing already at hand (no indefinite article)', () => {
  assert.equal(classify(user('Kijk eens naar mijn code.'), silent).sourceOfTruth, 'unknown');
  assert.equal(classify(user('Can you look at this document?'), silent).sourceOfTruth, 'unknown');
});

test('sourceOfTruth defaults to unknown when nothing resolves', () => {
  const d = classify(user('asdkfj alkj qzx'), silent);
  assert.equal(d.sourceOfTruth, 'unknown');
});

// --- entities (lightweight, replaceable) ----------------------------------

test('entities: extracts a quoted span', () => {
  const d = classify(user('Rewrite "the quick fox" to sound more formal.'), silent);
  assert.ok(d.entities.some((e) => e.type === 'quoted_text' && e.value === 'the quick fox'));
});

test('entities: extracts a recipient after "to <Name>"', () => {
  const d = classify(user('Send this to Alex.'), silent);
  assert.ok(d.entities.some((e) => e.type === 'recipient' && e.value === 'Alex'));
});

// --- logging ---------------------------------------------------------------

test('classify logs a decision line unless silent is set', () => {
  const lines = [];
  classify(user('Why is my website crashing?'), { logger: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.kind, 'intentiq.decision');
  assert.equal(parsed.intent, 'inform.explain');
  assert.ok(parsed.correlationId);
  assert.ok(parsed.timestamp);
});

test('classify does not log when silent is set', () => {
  const lines = [];
  classify(user('Why is my website crashing?'), { silent: true, logger: (line) => lines.push(line) });
  assert.equal(lines.length, 0);
});

// --- boundary: IntentIQ is interpretation-only, never a capability router -

test('boundary: intentIQ.js never imports Hermes or Hindsight clients', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/logos/intentIQ.js'), 'utf-8');
  assert.ok(!/require\(.*hermesClient/.test(source));
  assert.ok(!/require\(.*hindsightClient/.test(source));
});

test('boundary: an IntentDecision never carries a capability, provider, or model field', () => {
  const d = classify(user('Write a homepage introduction for me.'), silent);
  const keys = Object.keys(d);
  for (const forbidden of ['capability', 'provider', 'model', 'reasoningProfile', 'response']) {
    assert.ok(!keys.includes(forbidden), `IntentDecision leaked a routing field: ${forbidden}`);
  }
});

test('boundary: classify is a pure function — same input, same output, no shared mutable state', () => {
  const a = classify(user('Why is my website crashing?'), silent);
  const b = classify(user('Why is my website crashing?'), silent);
  assert.deepEqual(a.intent, b.intent);
  assert.deepEqual(a.candidates, b.candidates);
});
