'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { classify, interpret, classifySemantic, combineConsensus, SCHEMA_VERSION } = require('../src/logos/intentIQ');

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

test('boundary: intentIQ.js never imports Hermes, Hindsight, the Decision Engine, the Orchestrator, or any capability', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/logos/intentIQ.js'), 'utf-8');
  assert.ok(!/require\(.*hermesClient/.test(source));
  assert.ok(!/require\(.*hindsightClient/.test(source));
  assert.ok(!/require\(.*decisionEngine/.test(source));
  assert.ok(!/require\(.*orchestrat/i.test(source));
  assert.ok(!/require\(.*gaiaGenerator/.test(source));
  assert.ok(!/require\(.*braveSearch/.test(source));
  assert.ok(!/require\(.*mimoTts/.test(source));
  assert.ok(!/require\(.*responseEngine/.test(source));
});

test('boundary: IntentIQ 2.0 (interpret/classifySemantic) never calls Hermes, Web, or any capability, and never resolves a capability itself', async () => {
  // A semantic model that returns an intent is still just interpretation —
  // combineConsensus/interpret must never turn that into a capability call
  // or a resolved routing decision. This is IntentIQ's own boundary, not
  // the Decision Engine's (which is tested separately, in
  // test/decisionEngine.test.js).
  const model = { chat: async () => JSON.stringify({ intent: 'inform.explain', confidence: 0.9, sourceOfTruth: 'external_knowledge' }) };
  const d = await interpret(user('kun je dit even nakijken'), { silent: true, model });
  const keys = Object.keys(d);
  for (const forbidden of ['capability', 'provider', 'response', 'action', 'toolCall']) {
    assert.ok(!keys.includes(forbidden), `interpret() leaked a routing field: ${forbidden}`);
  }
  // sourceOfTruth is a description, never an instruction to call anything.
  assert.equal(typeof d.sourceOfTruth, 'string');
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

// === IntentIQ 2.0: classifySemantic (the semantic tier) =====================

test('classifySemantic: no model configured or injected -> not attempted, result null', async () => {
  const result = await classifySemantic('hello', {}, {});
  assert.equal(result.attempted, false);
  assert.equal(result.result, null);
});

test('classifySemantic: an injected model is called with a prompt built from text/context, and its output is validated', async () => {
  let seenMessages;
  const model = {
    chat: async (messages) => {
      seenMessages = messages;
      return JSON.stringify({
        intent: 'decide.support',
        confidence: 0.87,
        candidates: [{ intent: 'decide.support', confidence: 0.87 }, { intent: 'converse', confidence: 0.09 }],
        reason: 'The user is asking for help evaluating a decision.',
      });
    },
  };
  const result = await classifySemantic('Wat moet ik hiermee?', { recentTurns: [], heuristicResult: null }, { model });
  assert.equal(result.attempted, true);
  assert.equal(result.result.intent, 'decide.support');
  assert.equal(result.result.confidence, 0.87);
  assert.match(seenMessages[1].content, /Wat moet ik hiermee\?/);
});

test('classifySemantic: degrades to attempted:true, result:null when the model rejects — never throws', async () => {
  const model = { chat: async () => { throw new Error('provider exploded, key=xyz'); } };
  const result = await classifySemantic('hello', {}, { model });
  assert.equal(result.attempted, true);
  assert.equal(result.result, null);
});

test('classifySemantic: degrades to attempted:true, result:null on malformed (non-JSON) model output — never throws', async () => {
  const model = { chat: async () => 'not json at all' };
  const result = await classifySemantic('hello', {}, { model });
  assert.equal(result.attempted, true);
  assert.equal(result.result, null);
});

// === IntentIQ 2.0: combineConsensus ==========================================

test('combineConsensus: no semantic result -> heuristic decision returned unchanged (byte-compatible with v0.1)', () => {
  const heuristic = classify(user('Why is my website crashing?'), silent);
  const combined = combineConsensus(heuristic, null);
  assert.deepEqual(combined, heuristic);
});

test('combineConsensus: agreement between heuristic and semantic raises confidence and is never ambiguous', () => {
  const heuristic = { intent: 'inform.explain', status: 'accepted', confidence: 0.82, candidates: [{ intent: 'inform.explain', score: 0.82 }], sourceOfTruth: 'external_knowledge', meta: {} };
  const semantic = { intent: 'inform.explain', confidence: 0.93, candidates: [{ intent: 'inform.explain', confidence: 0.93 }], sourceOfTruth: 'external_knowledge', speechAct: 'question', referents: [], ambiguous: false, reason: 'clear factual question' };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.intent, 'inform.explain');
  assert.equal(combined.confidence, 0.93);
  assert.equal(combined.ambiguous, false);
  assert.equal(combined.needsClarification, false);
});

test('combineConsensus: conflict between heuristic and semantic is reported honestly as ambiguous — the brief\'s own example', () => {
  // heuristic: inform.explain @ 0.78; semantic: decide.support @ 0.84 -> decide.support wins, ambiguous: true.
  const heuristic = { intent: 'inform.explain', status: 'accepted', confidence: 0.78, candidates: [{ intent: 'inform.explain', score: 0.78 }], sourceOfTruth: 'conversation', meta: {} };
  const semantic = { intent: 'decide.support', confidence: 0.84, candidates: [{ intent: 'decide.support', confidence: 0.84 }], sourceOfTruth: 'conversation', speechAct: 'advice_request', referents: [], ambiguous: false, reason: 'sounds like weighing a choice' };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.intent, 'decide.support');
  assert.equal(combined.confidence, 0.84);
  assert.equal(combined.ambiguous, true);
  assert.equal(combined.needsClarification, true);
});

test('combineConsensus: heuristic found nothing, semantic did -> semantic result is used', () => {
  const heuristic = classify(user('asdkfj alkj qzx'), silent); // unknown
  const semantic = { intent: 'converse', confidence: 0.7, candidates: [{ intent: 'converse', confidence: 0.7 }], sourceOfTruth: 'conversation', speechAct: 'statement', referents: [], ambiguous: false, reason: 'reads as presence-seeking' };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.intent, 'converse');
  assert.equal(combined.status, 'accepted');
  assert.equal(combined.ambiguous, false);
});

test('combineConsensus: heuristic found something, semantic found nothing -> heuristic is kept', () => {
  const heuristic = classify(user('Why is my website crashing?'), silent);
  const semantic = { intent: null, confidence: 0, candidates: [], sourceOfTruth: 'unknown', speechAct: null, referents: [], ambiguous: false, reason: null };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.intent, 'inform.explain');
  assert.equal(combined.status, 'accepted');
});

test('combineConsensus: neither tier has an opinion -> unknown', () => {
  const heuristic = classify(user('asdkfj alkj qzx'), silent);
  const semantic = { intent: null, confidence: 0, candidates: [], sourceOfTruth: 'unknown', speechAct: null, referents: [], ambiguous: false, reason: null };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.intent, null);
  assert.equal(combined.status, 'unknown');
});

// Found live in production: a real semantic model call returned intent:
// null (no single confident winner) alongside a populated candidates list
// — genuine model uncertainty expressed as "here are plausible options,
// I won't commit to one", distinct from "I have no opinion at all". The
// previous version of this branch discarded those candidates entirely,
// reporting status:'unknown'/ambiguous:false even though real signal
// existed and needsClarification was already true — an inconsistent
// result (candidates populated, yet "no opinion").
test('combineConsensus: neither tier commits to a top intent, but real candidates exist -> best guess reported, honestly ambiguous', () => {
  const heuristic = classify(user('Ik weet niet goed wat ik hiermee aan moet, kun jij me helpen dit uit te zoeken?'), silent);
  const semantic = {
    intent: null,
    confidence: 0,
    candidates: [{ intent: 'inform.explain', confidence: 0.4 }, { intent: 'decide.support', confidence: 0.3 }],
    sourceOfTruth: 'unknown',
    speechAct: 'request',
    referents: [],
    ambiguous: true,
    reason: null,
  };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.intent, 'inform.explain'); // highest-scoring merged candidate
  assert.equal(combined.confidence, 0.4);
  assert.equal(combined.status, 'ambiguous');
  assert.equal(combined.ambiguous, true);
  assert.equal(combined.needsClarification, true);
});

test('combineConsensus: sourceOfTruth prefers the heuristic\'s own rule-based judgment when it resolved to anything specific', () => {
  const heuristic = { intent: 'act.perform', status: 'accepted', confidence: 0.9, candidates: [{ intent: 'act.perform', score: 0.9 }], sourceOfTruth: 'tool', meta: {} };
  const semantic = { intent: 'act.perform', confidence: 0.9, candidates: [], sourceOfTruth: 'external_knowledge', speechAct: 'request', referents: [], ambiguous: false, reason: null };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.sourceOfTruth, 'tool'); // heuristic's own resolution wins, not semantic's
});

// --- ambiguity calibration: margin overrides a reported ambiguous flag ----------
//
// A turn is ambiguous only when the competing interpretations are genuinely
// close. A model-reported `ambiguous: true` is reconciled against the
// semantic candidates' margin: a clear winner is accepted even when the model
// hedged, and only a genuinely close candidate pair keeps the turn ambiguous.

test('ambiguity calibration: a clear winner (0.85 vs 0.60) is accepted despite a reported ambiguous flag', () => {
  const heuristic = classify(user('dank je, je bent nog slimmer als het goed is'), silent); // unknown
  const semantic = {
    intent: 'converse', confidence: 0.85,
    candidates: [
      { intent: 'converse', confidence: 0.85 },
      { intent: 'meta.relational', confidence: 0.60 },
      { intent: 'meta.correction', confidence: 0.30 },
    ],
    sourceOfTruth: 'conversation', speechAct: 'statement', referents: [], ambiguous: true, reason: 'hedged',
  };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.intent, 'converse');
  assert.equal(combined.status, 'accepted');
  assert.equal(combined.ambiguous, false);
  assert.equal(combined.needsClarification, false);
  assert.equal(combined.confidence, 0.85);
  assert.equal(combined.speechAct, 'statement');
});

test('ambiguity calibration: a moderate winner (0.70 vs 0.60) is accepted, referent provenance preserved', () => {
  const heuristic = classify(user('i said you must be smarter now if i did it right'), silent); // unknown
  const semantic = {
    intent: 'converse', confidence: 0.70,
    candidates: [
      { intent: 'converse', confidence: 0.70 },
      { intent: 'meta.relational', confidence: 0.60 },
    ],
    sourceOfTruth: 'conversation', speechAct: 'statement',
    referents: [{ expression: 'it', resolvedTo: 'presumably an action the user took to make Gaia smarter', confidence: 0.6, source: 'conversation' }],
    ambiguous: true, reason: 'hedged',
  };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.intent, 'converse');
  assert.equal(combined.status, 'accepted');
  assert.equal(combined.ambiguous, false);
  assert.equal(combined.needsClarification, false);
  // Referent provenance survives even though the turn itself is accepted.
  assert.equal(combined.referents.length, 1);
  assert.equal(combined.referents[0].expression, 'it');
  assert.equal(combined.referents[0].confidence, 0.6);
});

test('ambiguity calibration: genuinely close candidates (0.50 vs 0.48) stay ambiguous', () => {
  const heuristic = classify(user('I need you to handle this.'), silent);
  const semantic = {
    intent: 'converse', confidence: 0.50,
    candidates: [
      { intent: 'converse', confidence: 0.50 },
      { intent: 'decide.support', confidence: 0.48 },
    ],
    sourceOfTruth: 'conversation', speechAct: 'statement', referents: [], ambiguous: true, reason: 'genuinely close',
  };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.status, 'ambiguous');
  assert.equal(combined.ambiguous, true);
  assert.equal(combined.needsClarification, true);
});

test('ambiguity calibration: a single candidate overrides a reported ambiguous flag', () => {
  const heuristic = classify(user('hello there friend'), silent);
  const semantic = {
    intent: 'converse', confidence: 0.7,
    candidates: [{ intent: 'converse', confidence: 0.7 }],
    sourceOfTruth: 'conversation', speechAct: 'statement', referents: [], ambiguous: true, reason: 'hedged with single candidate',
  };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.status, 'accepted');
  assert.equal(combined.ambiguous, false);
});

test('ambiguity calibration: a non-ambiguous semantic result stays accepted', () => {
  const heuristic = classify(user('hello there friend'), silent);
  const semantic = {
    intent: 'converse', confidence: 0.7,
    candidates: [{ intent: 'converse', confidence: 0.7 }],
    sourceOfTruth: 'conversation', speechAct: 'statement', referents: [], ambiguous: false, reason: null,
  };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.status, 'accepted');
  assert.equal(combined.ambiguous, false);
});

test('ambiguity calibration: the semantic margin helper reports top and margin correctly', () => {
  const { semanticTopAndMargin, semanticIsAmbiguous } = require('../src/logos/intentIQ').__internals;
  const res = semanticTopAndMargin({ candidates: [{ intent: 'a', confidence: 0.8 }, { intent: 'b', confidence: 0.5 }] });
  assert.equal(res.top.intent, 'a');
  assert.equal(res.top.confidence, 0.8);
  assert.ok(Math.abs(res.margin - 0.3) < 1e-9, `expected margin ~0.3, got ${res.margin}`);
  // Single candidate: margin Infinity (no genuine competition), never ambiguous.
  assert.equal(semanticTopAndMargin({ candidates: [{ intent: 'a', confidence: 0.8 }] }).margin, Infinity);
  assert.equal(semanticIsAmbiguous({ ambiguous: true, candidates: [{ intent: 'a', confidence: 0.8 }] }), false);
  assert.equal(semanticIsAmbiguous({ ambiguous: false, candidates: [] }), false);
});

test('combineConsensus: sourceOfTruth falls back to the semantic tier\'s judgment when the heuristic genuinely could not tell', () => {
  const heuristic = classify(user('asdkfj alkj qzx'), silent); // sourceOfTruth: unknown
  const semantic = { intent: null, confidence: 0, candidates: [], sourceOfTruth: 'memory', speechAct: null, referents: [], ambiguous: false, reason: null };
  const combined = combineConsensus(heuristic, semantic);
  assert.equal(combined.sourceOfTruth, 'memory');
});

// === IntentIQ 2.0: interpret() (the cascade — heuristic first, semantic only when needed) ===

test('interpret(): a strong heuristic match never calls the semantic model — test #1: simple native, no unnecessary semantic call', async () => {
  const model = { chat: async () => { throw new Error('semantic model must not be called for a strong heuristic match'); } };
  const d = await interpret(user('Hoi Gaia'), { silent: true, model });
  assert.equal(d.intent, 'converse');
  assert.ok(d.confidence > 0.9);
});

test('interpret(): without any semantic model configured or injected, behaves exactly like classify() (heuristic-only, backward compatible)', async () => {
  const messages = user('Why is my website crashing?');
  const viaClassify = classify(messages, silent);
  const viaInterpret = await interpret(messages, silent);
  assert.equal(viaInterpret.intent, viaClassify.intent);
  assert.equal(viaInterpret.status, viaClassify.status);
  assert.equal(viaInterpret.confidence, viaClassify.confidence);
});

test('interpret(): a weak/unknown heuristic result escalates to the semantic model when one is configured', async () => {
  let called = false;
  const model = {
    chat: async () => {
      called = true;
      return JSON.stringify({ intent: 'decide.support', confidence: 0.8, sourceOfTruth: 'conversation' });
    },
  };
  const d = await interpret(user('Kun je deze ook doen?'), { silent: true, model });
  assert.equal(called, true);
  assert.equal(d.intent, 'decide.support');
});

test('interpret(): ambiguity without enough context is not force-classified — test #7: ambiguity', async () => {
  // No semantic model configured: a signal-free, context-free turn must
  // not confidently resolve to an arbitrary intent.
  const d = await interpret(user('Kun je deze ook doen?'), silent);
  assert.notEqual(d.status, 'accepted');
});

test('interpret(): never throws even if the semantic model rejects', async () => {
  const model = { chat: async () => { throw new Error('boom'); } };
  const d = await interpret(user('Kun je deze ook doen?'), { silent: true, model });
  assert.equal(d.status, 'unknown'); // degrades to the heuristic's own (unknown) result
});

test('interpret(): logs whether the semantic classifier was actually called', async () => {
  const lines = [];
  await interpret(user('Hoi Gaia'), { logger: (line) => lines.push(line) });
  const strong = JSON.parse(lines[0]);
  assert.equal(strong.semanticCalled, false);

  lines.length = 0;
  const model = { chat: async () => JSON.stringify({ intent: 'converse', confidence: 0.6 }) };
  await interpret(user('Kun je deze ook doen?'), { logger: (line) => lines.push(line), model });
  const weak = JSON.parse(lines[0]);
  assert.equal(weak.semanticCalled, true);
});

// === IntentIQ 2.0: section 14 test scenarios (concrete turns from the brief) ===

test('scenario: "Wat weet je nog van mijn voorkeuren?" -> memory.inspect, sourceOfTruth memory', () => {
  const d = classify(user('Wat weet je nog van mijn voorkeuren?'), silent);
  assert.equal(d.intent, 'memory.inspect');
  assert.equal(d.sourceOfTruth, 'memory');
});

test('scenario: "Waarom werkt dit zo?" -> inform.explain', () => {
  const d = classify(user('Waarom werkt dit zo?'), silent);
  assert.equal(d.intent, 'inform.explain');
});

test('scenario: "Schrijf een liedje hierover." -> create.generate', () => {
  const d = classify(user('Schrijf een liedje hierover.'), silent);
  assert.equal(d.intent, 'create.generate');
});

test('scenario: "Herschrijf dit wat scherper." -> create.transform', () => {
  const d = classify(user('Herschrijf dit wat scherper.'), silent);
  assert.equal(d.intent, 'create.transform');
});

// Found during live validation: the infinitive/conjugated forms of these
// Dutch verbs weren't covered by the imperative-stem-only patterns above,
// because Dutch's own open/closed-syllable spelling rules change the
// stem's last letter(s) in the infinitive (not just append a suffix).
test('scenario: "Kun je dit herschrijven?" -> create.transform (infinitive form, not just the imperative stem)', () => {
  assert.equal(classify(user('Kun je dit herschrijven?'), silent).intent, 'create.transform');
});

test('scenario: "Kun je dit vertalen naar het Engels?" -> create.transform (vertaal -> vertalen spelling alternation)', () => {
  assert.equal(classify(user('Kun je dit vertalen naar het Engels?'), silent).intent, 'create.transform');
});

test('scenario: "Kun je dit verbeteren?" -> create.transform', () => {
  assert.equal(classify(user('Kun je dit verbeteren?'), silent).intent, 'create.transform');
});

test('scenario: "Wat denk je dat ik hiermee moet doen?" -> decide.support', () => {
  const d = classify(user('Wat denk je dat ik hiermee moet doen?'), silent);
  assert.equal(d.intent, 'decide.support');
});

test('scenario: follow-up — "Analyseer deze architectuur." then "En deze dan?" resolves via inheritance/reference', () => {
  const history = user('Analyseer deze architectuur.');
  const withReply = [...history, msg('assistant', 'Ik zie een paar dingen die opvallen.')];
  const first = classify(user('Analyseer deze architectuur.'), silent);
  const followUp = classify(user('En deze dan?', withReply), silent);
  assert.equal(first.intent, 'inform.explain');
  assert.notEqual(followUp.status, 'unknown'); // inherited, not a hard failure
});

test('scenario: "Kun je deze ook doen?" without context does not get a confident arbitrary intent', () => {
  const d = classify(user('Kun je deze ook doen?'), silent);
  assert.notEqual(d.status, 'accepted');
});

test('scenario: capability separation — IntentIQ never calls Hermes, Web/Brave, or any other capability, at either tier', async () => {
  const model = { chat: async () => JSON.stringify({ intent: 'inform.explain', confidence: 0.9, sourceOfTruth: 'external_knowledge' }) };
  // If IntentIQ ever called a capability, these would be the modules
  // involved — asserting their absence from require.cache after a full
  // interpret() call is a stronger runtime check than the static source
  // scan above.
  const before = new Set(Object.keys(require.cache));
  await interpret(user('what is the current OpenAI API documentation?'), { silent: true, model });
  const after = Object.keys(require.cache).filter((k) => !before.has(k));
  for (const modulePath of after) {
    assert.ok(!/hermesClient|braveSearch|gaiaGenerator|mimoTts/i.test(modulePath), `interpret() loaded a capability module: ${modulePath}`);
  }
});

// === IntentIQ 2.2: needsSemanticCheck — a confident heuristic match is no ===
// === longer automatically safe to trust without verification. ==============

test('2.2 #1 strong safe heuristic: "Hoi Gaia" is accepted, needsSemanticCheck is false, and interpret() never calls the semantic model', async () => {
  const d = classify(user('Hoi Gaia'), silent);
  assert.equal(d.status, 'accepted');
  assert.equal(d.needsSemanticCheck, false);
  assert.equal(d.interpretationStatus, 'resolved');

  const model = { chat: async () => { throw new Error('semantic model must not be called for a strong, unambiguous heuristic match'); } };
  const resolved = await interpret(user('Hoi Gaia'), { silent: true, model });
  assert.equal(resolved.intent, 'converse');
  assert.equal(resolved.status, 'accepted');
});

test('2.2 #2 strong but overlapping: two intents both carry real signal on one turn — accepted, but needsSemanticCheck escalates to the semantic tier', async () => {
  // inform.explain scores twice ("waarom", "uitleggen"), create.transform
  // scores once ("verbeter...") — inform.explain dominates by share
  // (2/3 >= 0.6) so decideStatus() still calls this 'accepted', but two
  // distinct intents genuinely fired, which is exactly the "strong but
  // overlapping signals" case the 2.2 brief asks to no longer wave through
  // unverified.
  const input = 'Waarom werkt dit niet? Kun je uitleggen wat er mis is? Verbeter het ook.';
  const heuristic = classify(user(input), silent);
  assert.equal(heuristic.status, 'accepted');
  assert.ok(heuristic.candidates.length > 1);
  assert.equal(heuristic.needsSemanticCheck, true);

  let called = false;
  const model = {
    chat: async () => {
      called = true;
      return JSON.stringify({ intent: 'inform.explain', confidence: 0.8, sourceOfTruth: 'external_knowledge' });
    },
  };
  await interpret(user(input), { silent: true, model });
  assert.equal(called, true);
});

test('2.2 #2b strong but overlapping (spec phrasing): "Leg uit welke keuze ik volgens jou moet maken." triggers a semantic call', async () => {
  let called = false;
  const model = {
    chat: async () => {
      called = true;
      return JSON.stringify({
        intent: null,
        confidence: 0,
        candidates: [{ intent: 'inform.explain', confidence: 0.45 }, { intent: 'decide.support', confidence: 0.4 }],
        ambiguous: true,
      });
    },
  };
  const d = await interpret(user('Kun je uitleggen welke keuze ik moet maken?'), { silent: true, model });
  assert.equal(called, true);
  assert.equal(d.ambiguous, true);
});

test('2.2 #3 wrong-looking heuristic: a bare keyword match on the wrong intent is flagged and escalated, not trusted', async () => {
  // "draft" fires create.generate's bare boundary('draft') cue even though
  // this sentence has nothing to do with creating anything — a concrete
  // false-positive-prone single-weak-match case.
  const input = "I'm not a fan of this new NBA draft process.";
  const heuristic = classify(user(input), silent);
  assert.equal(heuristic.status, 'accepted');
  assert.equal(heuristic.intent, 'create.generate'); // confidently, and wrongly
  assert.equal(heuristic.candidates.length, 1);
  assert.equal(heuristic.needsSemanticCheck, true); // the fix: flagged despite being the sole candidate

  let called = false;
  const model = {
    chat: async () => {
      called = true;
      return JSON.stringify({ intent: 'converse', confidence: 0.7, sourceOfTruth: 'conversation' });
    },
  };
  const resolved = await interpret(user(input), { silent: true, model });
  assert.equal(called, true);
  // The heuristic's own (capped) confidence for a single-candidate match is
  // high, so a lower-confidence semantic disagreement doesn't silently win
  // — but the conflict is now visible and honest, not swallowed.
  assert.equal(resolved.ambiguous, true);
  assert.equal(resolved.status, 'ambiguous');
});

test('2.2 #4 ambiguous: conflicting signals stay ambiguous, with interpretationStatus reflecting it', () => {
  const d = classify(user('I need you to handle this.'), silent);
  assert.notEqual(d.status, 'accepted');
  if (d.status === 'ambiguous') {
    assert.equal(d.ambiguous, true);
    assert.equal(d.interpretationStatus, 'ambiguous');
  }
});

test('2.2 #5 low semantic confidence: confidenceLevel is low and interpretationStatus is uncertain, even though status is accepted', async () => {
  const model = { chat: async () => JSON.stringify({ intent: 'converse', confidence: 0.4, sourceOfTruth: 'conversation' }) };
  const d = await interpret(user('Kun je deze ook doen?'), { silent: true, model });
  assert.equal(d.status, 'accepted');
  assert.equal(d.confidenceLevel, 'low');
  assert.equal(d.interpretationStatus, 'uncertain');
});

// === IntentIQ 2.2: rawScore vs. calibrated confidence =======================

test('2.2 rawScore is reported alongside confidence and is not the same number', () => {
  const d = classify(user('Waarom crasht mijn website?'), silent);
  assert.equal(typeof d.rawScore, 'number');
  assert.equal(typeof d.confidence, 'number');
  assert.ok(d.rawScore >= 1);
});

test('2.2 confidenceLevel buckets: >=0.85 high, 0.60-0.84 medium, <0.60 low', () => {
  const { confidenceLevelFor } = require('../src/logos/intentIQ').__internals;
  assert.equal(confidenceLevelFor(0.95), 'high');
  assert.equal(confidenceLevelFor(0.85), 'high');
  assert.equal(confidenceLevelFor(0.7), 'medium');
  assert.equal(confidenceLevelFor(0.6), 'medium');
  assert.equal(confidenceLevelFor(0.59), 'low');
  assert.equal(confidenceLevelFor(0), 'low');
});

// === IntentIQ 2.2: referent resolution (confidence + honest nulls) =========

test('2.2 reference resolution: "Analyseer deze architectuur." then "En deze dan?" — the semantic tier resolves the referent with its own confidence', async () => {
  const history = [...user('Analyseer deze architectuur.'), msg('assistant', 'Ik zie een paar dingen die opvallen.')];
  const model = {
    chat: async () => JSON.stringify({
      intent: 'inform.explain',
      confidence: 0.8,
      sourceOfTruth: 'conversation',
      referents: [{ expression: 'deze', resolvedTo: 'de architectuur die net besproken werd', confidence: 0.91 }],
    }),
  };
  const d = await interpret(user('En deze dan?', history), { silent: true, model });
  assert.equal(d.referents.length, 1);
  assert.equal(d.referents[0].expression, 'deze');
  assert.equal(d.referents[0].resolvedTo, 'de architectuur die net besproken werd');
  assert.equal(d.referents[0].confidence, 0.91);
  assert.equal(d.referents[0].source, 'conversation');
});

test('2.2 unresolved reference: "Kun je deze doen?" with no prior context — resolvedTo null, interpretationStatus insufficient_context', async () => {
  const d = await interpret(user('Kun je deze doen?'), silent); // no history, no model configured
  assert.equal(d.status, 'unknown');
  assert.equal(d.interpretationStatus, 'insufficient_context');
});

test('2.2 unresolved reference: the semantic tier itself may honestly report resolvedTo: null with low confidence, rather than guessing', async () => {
  const model = {
    chat: async () => JSON.stringify({
      intent: 'inform.explain',
      confidence: 0.5,
      referents: [{ expression: 'deze', resolvedTo: null, confidence: 0.31 }],
    }),
  };
  const d = await interpret(user('Kun je deze ook doen?'), { silent: true, model });
  assert.equal(d.referents[0].resolvedTo, null);
  assert.equal(d.referents[0].confidence, 0.31);
  assert.equal(d.referents[0].source, null);
});

// === IntentIQ 2.2: the runtime feedback seam (intentFeedback.js) ===========

test('2.2 recordOutcome: a user correction produces a structured feedback record, without mutating the original decision', async () => {
  const { recordOutcome } = require('../src/logos/intentFeedback');
  const original = classify(user('Kun je dit uitleggen?'), silent);
  const originalSnapshot = JSON.stringify(original);

  let written = null;
  const record = recordOutcome(
    {
      originalInterpretation: original,
      correctedIntent: 'decide.support',
      source: 'user_correction',
      note: 'Nee, ik bedoelde dat ik advies wilde, niet dat je het moest uitleggen.',
    },
    (r) => { written = r; }
  );

  assert.equal(record.kind, 'intentiq.feedback');
  assert.equal(record.originalIntent, original.intent);
  assert.equal(record.correctedIntent, 'decide.support');
  assert.equal(record.source, 'user_correction');
  assert.equal(written, record);
  // The original decision object itself must be untouched.
  assert.equal(JSON.stringify(original), originalSnapshot);
});

test('2.2 recordOutcome: never throws on missing/partial input', () => {
  const { recordOutcome } = require('../src/logos/intentFeedback');
  const record = recordOutcome({}, () => {});
  assert.equal(record.kind, 'intentiq.feedback');
  assert.equal(record.originalIntent, null);
  assert.equal(record.correctedIntent, null);
  assert.equal(record.source, 'unknown');
});

test('2.2 boundary: intentFeedback.js never imports Hermes, Hindsight, the Decision Engine, or any capability', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/logos/intentFeedback.js'), 'utf-8');
  assert.ok(!/require\(.*hermesClient/.test(source));
  assert.ok(!/require\(.*hindsightClient/.test(source));
  assert.ok(!/require\(.*decisionEngine/.test(source));
});

// === v2.2: meta-intent detection from conversation context =================

test('classify detects meta.question when user asks about Gaia\'s previous action', () => {
  const history = [
    msg('user', 'Wat is het weer in Groningen?'),
    msg('assistant', 'Ik heb gezocht en het is 15 graden bewolkt.'),
  ];
  // "Waarom koos je voor websearch?" — asks about Gaia's capability choice
  // -> meta.capability_question (the user specifically mentions websearch)
  const d = classify([...history, msg('user', 'Waarom koos je voor websearch?')], silent);
  assert.equal(d.intent, 'meta.capability_question');
  assert.equal(d.status, 'accepted');
  assert.equal(d.sourceOfTruth, 'conversation');
  assert.equal(d.meta.reason, 'context_meta_intent_detected');
});

test('classify detects meta.question when user asks about Gaia\'s reasoning (no capability mentioned)', () => {
  const history = [
    msg('user', 'Wat is het weer in Groningen?'),
    msg('assistant', 'Ik heb gezocht en het is 15 graden bewolkt.'),
  ];
  // "Waarom deed je dat?" — asks about Gaia's action, no capability mentioned
  // -> meta.question
  const d = classify([...history, msg('user', 'Waarom deed je dat?')], silent);
  assert.equal(d.intent, 'meta.question');
  assert.equal(d.status, 'accepted');
  assert.equal(d.sourceOfTruth, 'conversation');
});

test('classify detects meta.correction when user corrects Gaia\'s interpretation', () => {
  const history = [
    msg('user', 'Leg dit uit'),
    msg('assistant', 'Hier is een uitleg over dit onderwerp...'),
  ];
  const d = classify([...history, msg('user', 'Nee, ik bedoel iets anders')], silent);
  assert.equal(d.intent, 'meta.correction');
  assert.equal(d.status, 'accepted');
  assert.equal(d.sourceOfTruth, 'conversation');
});

test('classify detects meta.capability_question when user asks about capability choice', () => {
  const history = [
    msg('user', 'Wat is het weer?'),
    msg('assistant', 'Ik heb gezocht en het is 15 graden.'),
  ];
  const d = classify([...history, msg('user', 'Waarom gebruikte je websearch?')], silent);
  assert.equal(d.intent, 'meta.capability_question');
  assert.equal(d.status, 'accepted');
  assert.equal(d.sourceOfTruth, 'conversation');
});

test('classify does NOT detect meta-intent when there is no assistant message in history', () => {
  const history = [
    msg('user', 'Wat is het weer?'),
  ];
  const d = classify([...history, msg('user', 'Waarom koos je voor websearch?')], silent);
  // Without a prior assistant message, this is just a standalone question
  // and should be classified by keyword scoring, not meta-intent detection
  assert.notEqual(d.intent, 'meta.question');
});

test('classify does NOT detect meta-intent when user is making a new information request', () => {
  const history = [
    msg('user', 'Hallo'),
    msg('assistant', 'Hoi! Hoe kan ik je helpen?'),
  ];
  const d = classify([...history, msg('user', 'Wat is het weer in Amsterdam?')], silent);
  // This is a new information request, not a question about Gaia's behavior
  assert.notEqual(d.intent, 'meta.question');
  assert.notEqual(d.intent, 'meta.correction');
  assert.notEqual(d.intent, 'meta.capability_question');
});

test('classify detects meta.correction with English signals', () => {
  const history = [
    msg('user', 'Tell me about AI'),
    msg('assistant', 'AI is artificial intelligence...'),
  ];
  const d = classify([...history, msg('user', 'No, I mean something else')], silent);
  assert.equal(d.intent, 'meta.correction');
  assert.equal(d.status, 'accepted');
});

test('classify detects meta.question with English signals', () => {
  const history = [
    msg('user', 'What is the weather?'),
    msg('assistant', 'I searched and found it is 15 degrees.'),
  ];
  // "Why did you choose websearch?" — asks about capability choice
  // -> meta.capability_question
  const d = classify([...history, msg('user', 'Why did you choose websearch?')], silent);
  assert.equal(d.intent, 'meta.capability_question');
  assert.equal(d.status, 'accepted');
});

test('classify detects meta.question with English signals (no capability)', () => {
  const history = [
    msg('user', 'What is the weather?'),
    msg('assistant', 'I searched and found it is 15 degrees.'),
  ];
  // "Why did you do that?" — asks about Gaia's action, no capability mentioned
  // -> meta.question
  const d = classify([...history, msg('user', 'Why did you do that?')], silent);
  assert.equal(d.intent, 'meta.question');
  assert.equal(d.status, 'accepted');
});

// === PATCH 1-3: Model-native vision handling ==============================

test('classify detects meta.question when user asks about image visibility (image unavailable)', () => {
  const history = [
    msg('user', 'Hier is een foto'),
    msg('assistant', 'Ik begrijp dat je een foto wilt delen.'),
  ];
  // "Kun je de foto zien?" with image unavailable
  const d = classify([...history, msg('user', 'Kun je de foto zien?')], {
    ...silent,
    hasImage: true,
    imageAvailable: false,
  });
  assert.equal(d.intent, 'meta.question');
  assert.equal(d.status, 'accepted');
  assert.equal(d.meta.target, 'image_availability');
});

test('classify detects meta.question when user asks about image visibility (image unknown)', () => {
  const history = [
    msg('user', 'Kijk naar deze afbeelding'),
    msg('assistant', 'Ik begrijp dat je een afbeelding wilt delen.'),
  ];
  // "Zie je de afbeelding?" with image availability unknown
  const d = classify([...history, msg('user', 'Zie je de afbeelding?')], {
    ...silent,
    hasImage: undefined,
    imageAvailable: undefined,
  });
  assert.equal(d.intent, 'meta.question');
  assert.equal(d.status, 'accepted');
  assert.equal(d.meta.target, 'image_availability');
});

test('classify does NOT detect meta.question when image is available (native vision)', () => {
  const history = [
    msg('user', 'Hier is een foto'),
    msg('assistant', 'Ik begrijp dat je een foto wilt delen.'),
  ];
  // "Kun je de foto zien?" with image available -> native vision handles it
  const d = classify([...history, msg('user', 'Kun je de foto zien?')], {
    ...silent,
    hasImage: true,
    imageAvailable: true,
  });
  // When image is available, native vision handles it directly
  // The meta-intent detection should return null, allowing native handling
  assert.notEqual(d.intent, 'meta.question');
});

test('classify detects meta.capability_question when user asks why image was not analyzed', () => {
  const history = [
    msg('user', 'Hier is een foto'),
    msg('assistant', 'Ik kan de afbeelding niet zien.'),
  ];
  // "Waarom heb je de afbeelding niet bekeken?" — asks about capability choice
  const d = classify([...history, msg('user', 'Waarom heb je de afbeelding niet bekeken?')], silent);
  assert.equal(d.intent, 'meta.capability_question');
  assert.equal(d.status, 'accepted');
});

test('classify detects meta.correction when user corrects image interpretation', () => {
  const history = [
    msg('user', 'Kun je de foto zien?'),
    msg('assistant', 'Nee, ik kan de afbeelding niet zien.'),
  ];
  // "Nee, ik bedoel dat je naar de kleuren moet kijken" — correction
  const d = classify([...history, msg('user', 'Nee, ik bedoel dat je naar de kleuren moet kijken')], silent);
  assert.equal(d.intent, 'meta.correction');
  assert.equal(d.status, 'accepted');
});

// === IntentIQ 2.4: targeted refinement from the measured 2.3 findings ======

const v24 = { silent: true };

// --- trap 1+2: weak-cue overconfidence (draft / schedule) -------------------

test('2.4 trap: NBA-draft "draft" is no longer a high-confidence false positive', () => {
  const d = classify(user("I'm not a fan of this new NBA draft process."), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'create.generate'); // heuristic tier's honest opinion...
  assert.ok(d.confidence <= 0.7); // ...no longer wearing high confidence
  assert.equal(d.needsSemanticCheck, true); // semantic verification is its designed path
});

test('2.4 trap: noun-"schedule" is capped and flagged instead of confident', () => {
  const d = classify(user("What's your schedule looking like this week?"), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'act.perform');
  assert.ok(d.confidence <= 0.7);
  assert.equal(d.needsSemanticCheck, true);
});

test('2.4 weak-only cap: genuine imperative schedule requests stay accepted, at honest confidence', () => {
  const d = classify(user('Schedule the call for Monday.'), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'act.perform');
  assert.ok(d.confidence > 0 && d.confidence <= 0.7);
  assert.equal(d.needsSemanticCheck, true);
});

test('2.4 strong evidence overrides the weak cue: draft WITH real generation framing keeps full confidence', () => {
  const d = classify(user('Maak een draft van dit bericht.'), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'create.generate');
  assert.ok(d.confidence > 0.85); // strong 'maak een' signal backs it
});

// --- trap 3: clause-final cause-seeking --------------------------------------

test('2.4 trap: declarative clause closed by ", why?" resolves as explanation', () => {
  const d = classify(user('Write protection is enabled on the drive, why?'), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'inform.explain');
});

test('2.4 clause-final cause-seeking works in Dutch too', () => {
  const d = classify(user('De pipeline faalt steeds op dezelfde stap, waarom?'), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'inform.explain');
});

// --- "Leg uit hoe..." family --------------------------------------------------

test('2.4 "Leg uit hoe X werkt." resolves as inform.explain (inverted order fixed)', () => {
  const d = classify(user('Leg uit hoe Hindsight werkt.'), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'inform.explain');
});

test('2.4 "Kun je uitleggen hoe X werkt?" is a STRONG match, not capped weak-cue confidence', () => {
  const d = classify(user('Kun je uitleggen hoe de orchestrator werkt?'), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'inform.explain');
  assert.ok(d.confidence >= 0.85);
});

test('2.4 negative: physical "leg X op Y" does not become an explanation request', () => {
  const d = classify(user('Leg het document op tafel.'), v24);
  assert.notEqual(d.intent, 'inform.explain');
});

// --- personhood ---------------------------------------------------------------

const PERSONHOOD_POSITIVES = [
  ['Ben je een echt persoon?', 'adjective form'],
  ['Ben jij een echt persoon?', 'jij variant'],
  ['Ben je werkelijk een persoon?', 'werkelijk variant'],
  ['Ben je een mens?', 'pre-2.4 guard'],
  ['Ben jij echt?', 'clause-end intensifier'],
  ['Praat ik met een echte persoon?', 'praat-ik-met frame'],
];
for (const [input, label] of PERSONHOOD_POSITIVES) {
  test(`2.4 personhood: "${input}" (${label}) is meta.relational`, () => {
    const d = classify(user(input), v24);
    assert.equal(d.status, 'accepted');
    assert.equal(d.intent, 'meta.relational');
    assert.ok(d.needsSemanticCheck === false || d.confidence < 0.95);
  });
}

test('2.4 personhood negatives: ordinary uses of persoon/echt stay out of identity intent', () => {
  const writing = classify(user('Schrijf een tekst over een persoon.'), v24);
  assert.notEqual(writing.intent, 'meta.relational');

  const adverb = classify(user('Is dit echt een probleem?'), v24);
  assert.notEqual(adverb.intent, 'meta.relational');
});

test('2.4 personhood negative: "Ben jij echt van plan?" is not identity intent', () => {
  const d = classify(user('Ben jij echt van plan om te verhuizen?'), v24);
  assert.notEqual(d.intent, 'meta.relational');
});

// --- bare interrogative follow-ups ("why?", "waarom dan?") ---------------------

test('2.4 bare why WITHOUT context: honest insufficient_context, never an assumed intent', () => {
  for (const input of ['why?', 'Waarom?', 'waarom dan?', 'waarom eigenlijk?']) {
    const d = classify(user(input), v24);
    assert.equal(d.status, 'unknown', input);
    assert.equal(d.intent, null, input);
    assert.equal(d.interpretationStatus, 'insufficient_context', input);
    assert.equal(d.meta.reason, 'bare_interrogative_without_resolvable_context', input);
  }
});

test('2.4 bare why WITH resolvable context inherits the prior turn intent, flagged for verification', () => {
  const history = [...user('Why is my website crashing?'), msg('assistant', 'Your cache is stale.')];
  const d = classify(user('why?', history), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'inform.explain');
  assert.equal(d.sourceOfTruth, 'conversation');
  assert.equal(d.needsSemanticCheck, true);
  assert.equal(d.meta.reason, 'bare_interrogative_inherited');
});

test('2.4 bare "waarom dan?" after a decision turn inherits decide.support', () => {
  const history = [...user('Should I take the job offer?'), msg('assistant', 'Let me lay out both sides.')];
  const d = classify(user('waarom dan?', history), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'decide.support');
  assert.equal(d.needsSemanticCheck, true);
});

test('2.4 bare-interrogative branch must NOT intercept real questions', () => {
  const d = classify(user('Waarom werkt dit zo?'), v24);
  assert.equal(d.status, 'accepted');
  assert.equal(d.intent, 'inform.explain');
  assert.equal(d.meta.reason, 'direct_signal');
});

test('2.4 isBareInterrogativeFollowUp token discipline', () => {
  const { isBareInterrogativeFollowUp } = require('../src/logos/intentIQ').__internals;
  assert.equal(isBareInterrogativeFollowUp('why?'), true);
  assert.equal(isBareInterrogativeFollowUp('waarom dan?'), true);
  assert.equal(isBareInterrogativeFollowUp('HOEZO'), true);
  assert.equal(isBareInterrogativeFollowUp('why not?!'), true);
  assert.equal(isBareInterrogativeFollowUp('Waarom werkt dit zo?'), false);
  assert.equal(isBareInterrogativeFollowUp('why is the sky blue'), false);
  assert.equal(isBareInterrogativeFollowUp('dit is een vraag waarom'), false);
});

// --- heuristic-v0.3: assistant-originated referents -------------------------
//
// Gaia's OWN previous response is a legitimate antecedent source: when she
// introduces a term ("...zeker gezien de context rond juni..."), the user's
// follow-up ("wat was er in juni ook alweer?") references HER turn, not the
// void. The mechanism is generic content-term anchoring against the
// immediately preceding assistant turn — deliberately NOT a keyword list of
// months/dates/topics.

test("v0.3: a follow-up reusing Gaia's term anchors to her previous turn", () => {
  const history = [
    ...user('Vertel eens hoe het afgelopen jaar ging.'),
    msg('assistant', 'Ik zie vooral veel sessies rond juni — zeker gezien de context rond juni destijds.'),
  ];
  const d = classify(user('wat was er in juni ook alweer?', history), silent);

  // The anchor is real and visible with provenance.
  assert.equal(d.sourceOfTruth, 'memory');
  assert.ok(d.referents.length >= 1);
  const juni = d.referents.find((r) => r.expression === 'juni');
  assert.ok(juni, 'juni recorded as a referent');
  assert.equal(juni.source, 'previous_assistant_turn');
  assert.match(juni.resolvedTo, /previous_assistant_turn:juni/);
  assert.match(d.meta.reason, /^assistant_anchored_follow_up/);
});

test('v0.3: the same question without an assistant antecedent stays honestly uncertain', () => {
  // "oktober" appears nowhere in the (short) assistant reply — no anchor.
  const history = [
    ...user('Hoi'),
    msg('assistant', 'Hoi! Leuk dat je er bent.'),
  ];
  const d = classify(user('wat was er in oktober ook alweer?', history), silent);
  assert.equal(d.status, 'unknown');
  assert.equal(d.sourceOfTruth, 'unknown');
  assert.deepEqual(d.referents, []);
  assert.equal(d.meta.reason, 'no_signal_matched');
});

test('v0.3: anchoring is generic — any substantive term Gaia introduced works', () => {
  const history = [
    ...user('Wat vind je van mijn planning?'),
    msg('assistant', 'De sprintstructuur oogt goed, maar het review-moment elke vrijdag is krap.'),
  ];
  // No pronoun, no interrogative head, no lexical signal of its own — the
  // ONLY thing tying this turn to anything is the term Gaia used first.
  const d = classify(user('wat gebeurde er rond vrijdag precies?', history), silent);
  assert.equal(d.sourceOfTruth, 'memory');
  assert.match(d.meta.reason, /^assistant_anchored_follow_up/);
  assert.ok(d.referents.some((r) => r.expression === 'vrijdag'), 'vrijdag recorded as an assistant-originated referent');
});

test('v0.3: anchored follow-up inherits intent from the prior user turn when resolvable', () => {
  const history = [
    ...user('Analyseer even mijn publicatie-ritme.'),
    msg('assistant', 'Opvallend: de pieken liggen allemaal in juni.'),
  ];
  const d = classify(user('wat verklaart die piek dan in juni?', history), silent);
  assert.equal(d.meta.reason, 'assistant_anchored_follow_up_inherited');
  assert.equal(d.intent, 'inform.explain'); // inherited from "analyseer"
  assert.equal(d.sourceOfTruth, 'memory');   // anchored to shared context, not just conversation
  assert.ok(d.referents.some((r) => r.expression === 'juni'));
  assert.equal(d.needsSemanticCheck, true);  // context-resolved: verify before trusting
});

test('v0.3: function-word overlap alone never anchors', () => {
  // Only function words shared — no content-term anchor may fire.
  const history = [
    ...user('Kun je dit analyseren?'),
    msg('assistant', 'Dat was wat er in de tekst stond over de structuur ervan.'),
  ];
  const d = classify(user('wat betekent dit nog meer eigenlijk?', history), silent);
  // May resolve as a pronominal continuation, but never via a content anchor:
  if (d.meta.reason.startsWith('assistant_anchored')) {
    assert.fail('function words must not produce an anchored decision');
  }
});

test('v0.3: pronominal adverbs ("daar", "daarmee") are continuation cues that record assistant provenance', () => {
  const history = [
    ...user('Waarom crasht mijn website?'),
    msg('assistant', 'Ik zie een probleem met de database-connectie tijdens pieken.'),
  ];
  const d = classify(user('daar twijfel ik nog aan.', history), silent);
  assert.notEqual(d.status, 'unknown'); // continuation inherits/ambiguates, not unknown
  assert.ok(Array.isArray(d.referents));
  for (const r of d.referents) {
    assert.equal(r.source, 'previous_assistant_turn');
    assert.equal(r.resolvedTo, 'previous_assistant_turn');
  }
});

test('v0.3: "dat"/"die" follow-ups keep their inherited-intent semantics', () => {
  const history = [...user('Kun je dit analyseren?'), msg('assistant', 'Ja, ik kijk ernaar.')];
  const d = classify(user('En deze dan?', history), silent);
  assert.equal(d.sourceOfTruth, 'conversation'); // unchanged classic path
  assert.notEqual(d.status, 'unknown');
});

test('v0.3: "wat bedoelde je daarmee?" refers to Gaia\'s previous response', () => {
  const history = [
    ...user('Hoe staat mijn project ervoor?'),
    msg('assistant', 'De mixage loopt, maar mastering wacht op feedback.'),
  ];
  const d = classify(user('wat bedoelde je daarmee?', history), silent);
  // Meta-intent detection already treats this as a question about Gaia's own
  // words; pin that so the anchoring work never regresses it.
  assert.equal(d.intent, 'meta.question');
  assert.equal(d.status, 'accepted');
});

test('v0.3: without ANY preceding context the system remains uncertain', () => {
  const d = classify(user('wat was er in juni ook alweer?'), silent);
  assert.equal(d.status, 'unknown');
  assert.equal(d.sourceOfTruth, 'unknown');
  assert.deepEqual(d.referents, []);
});

// --- heuristic-v0.4: declarative status updates -------------------------------
//
// A first-person statement about something the user just DID is a report,
// never a request. Before v0.4 such turns scored unknown at the heuristic
// tier; with a semantic classifier configured, the consensus tier could then
// judge the un-opinionated turn "ambiguous" and bounce a plain status update
// into a clarification loop (real production failure: two consecutive
// "ik heb ... toegevoegd" turns both answered with the clarify fallback).

test('v0.4: a declarative status update is an accepted converse statement — never clarify-bait', () => {
  const d = classify(user('ik heb de capability toegevoegd dat je kan zoeken in chatgeschiedenis maar kennelijk werkt het nog niet'), silent);
  assert.equal(d.intent, 'converse');
  assert.equal(d.status, 'accepted');
  assert.equal(d.needsClarification, false);
  assert.equal(d.sourceOfTruth, 'conversation');
  assert.equal(d.meta.reason, 'declarative_status_update');
  // The speech act is certain by construction: no semantic second opinion
  // that could reintroduce ambiguity.
  assert.equal(d.needsSemanticCheck, false);
});

// --- acknowledgement/greeting + conversational question -----------------

const CONVERSATIONAL_COMPOUNDS = [
  'dank je. hoe is het?',
  'dank je, hoe gaat het?',
  'goedemorgen, hoe is het?',
  'hoi, hoe gaat het?',
  'fijn je weer te spreken. hoe is het?',
];

for (const input of CONVERSATIONAL_COMPOUNDS) {
  test(`compound conversation: "${input}" resolves from the question clause`, () => {
    const d = classify(user(input), silent);
    assert.equal(d.intent, 'converse');
    assert.equal(d.status, 'accepted');
    assert.equal(d.confidence, 0.95);
    assert.equal(d.needsClarification, false);
    assert.equal(d.ambiguous, false);
    assert.equal(d.speechAct, 'question');
    assert.equal(d.needsSemanticCheck, false);
  });
}

for (const input of ['dank je', 'goedemorgen', 'ok', 'ja precies']) {
  test(`compound conversation does not promote pure filler: "${input}"`, () => {
    const d = classify(user(input), silent);
    // Preserve each input's existing classification. In particular, the
    // existing anchored greeting rule accepts "goedemorgen"; the compound
    // rule must not change it or add question speech-act metadata.
    assert.notEqual(d.meta.reason, 'acknowledgement_or_greeting_plus_conversational_question');
    assert.notEqual(d.speechAct, 'question');
    assert.equal(d.needsClarification, false);
  });
}

for (const input of CONVERSATIONAL_COMPOUNDS) {
  test(`compound conversation: "${input}" does not trigger semantic fallback`, async () => {
    const lines = [];
    const d = await interpret(user(input), {
      logger: (line) => lines.push(JSON.parse(line)),
      model: { chat: async () => { throw new Error('semantic model must not be called'); } },
    });
    assert.equal(d.intent, 'converse');
    assert.equal(d.status, 'accepted');
    assert.equal(d.speechAct, 'question');
    assert.equal(lines.at(-1).semanticCalled, false);
  });
}

test('compound conversation does not classify an informational question as converse', () => {
  const d = classify(user('dank je. wat is een race condition?'), silent);
  assert.equal(d.intent, 'inform.explain');
  assert.equal(d.status, 'accepted');
  assert.equal(d.needsClarification, false);
});

test('compound conversational turns preserve the IntentIQ result through both transports', async () => {
  const { performTurn, performStreamingTurn } = require('../src/turn');
  const input = [{ role: 'user', content: 'dank je. hoe is het?' }];
  const decisions = [];
  const intent = classify(input, silent);
  const reasoning = { reasoningDepth: 'shallow' };
  const decisionEngine = (args) => {
    decisions.push(args.intent);
    return { action: 'native', reason: 'test', capability_execute: false };
  };
  const orchestrate = async () => ({ action: 'native', output: 'ok' });
  const common = {
    messages: input,
    documents: {},
    hermes: { chat: async () => 'unused', stream: async () => 'unused' },
    hindsight: { recall: async () => [], reflect: async () => {} },
    nativeGenerator: { generate: async () => 'ok', stream: async () => 'ok' },
    intentIQ: async () => intent,
    reasonIQ: async () => reasoning,
    decisionEngine,
    orchestrate,
  };
  await performTurn(common);
  await performStreamingTurn({ ...common, res: {
    writeHead() {}, write() {}, end() {}, status() { return this; }, json() {},
  } });
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions[0], decisions[1]);
});

// --- self-directed investigation statements vs assistant-directed requests --

// "Ik ga X doen" means the USER is about to do X. The embedded waarom/wat
// clause is the object of their own action, never a request to Gaia — so the
// bare 'waarom' cue must not resolve these turns to inform.explain +
// external_knowledge (which routed a personal remark into web search).
const SELF_DIRECTED = [
  'Ja, best ver eigenlijk. Ik ga nu even uitzoeken waarom jij relatief traag reageert.',
  'Ik ga dit zelf uitzoeken.',
  'Ik zoek het zelf wel even uit.',
  'Ik ga onderzoeken waarom dit gebeurt.',
  'Ik zal het even opzoeken.',
  'Ik ga nu uitzoeken waarom jij traag reageert.',
  "I'm going to look into why this is slow.",
];

for (const input of SELF_DIRECTED) {
  test(`self-directed investigation: "${input}" is an accepted converse statement — never external_knowledge`, () => {
    const d = classify(user(input), silent);
    assert.equal(d.intent, 'converse');
    assert.equal(d.status, 'accepted');
    assert.equal(d.sourceOfTruth, 'conversation');
    assert.notEqual(d.sourceOfTruth, 'external_knowledge');
    assert.equal(d.speechAct, 'statement');
    assert.equal(d.needsClarification, false);
    assert.equal(d.needsSemanticCheck, false);
    assert.equal(d.meta.reason, 'self_directed_investigation_statement');
  });
}

test('self-directed investigation never triggers the semantic fallback', async () => {
  const lines = [];
  const d = await interpret(user('Ik ga nu uitzoeken waarom jij traag reageert.'), {
    logger: (line) => lines.push(JSON.parse(line)),
    model: { chat: async () => { throw new Error('semantic model must not be called'); } },
  });
  assert.equal(d.intent, 'converse');
  assert.equal(d.speechAct, 'statement');
  assert.equal(lines.at(-1).semanticCalled, false);
});

const SELF_DIRECTED_NEGATIVES = [
  'Ik ga even kijken naar mijn code.',
  'Ik zoek dit zelf wel uit.',
  'Ik ga onderzoeken waarom de app traag is.',
];

for (const input of SELF_DIRECTED_NEGATIVES) {
  test(`self-directed negative: "${input}" never resolves to external_knowledge`, () => {
    const d = classify(user(input), silent);
    assert.notEqual(d.sourceOfTruth, 'external_knowledge');
    assert.equal(d.needsClarification, false);
  });
}

// Assistant-directed requests keep their EXISTING routing — the new branch
// must not intercept them. Web-eligible phrasing stays web-eligible.
test('assistant-directed: "Zoek uit waarom jij traag reageert." keeps existing external_knowledge routing', () => {
  const d = classify(user('Zoek uit waarom jij traag reageert.'), silent);
  assert.equal(d.intent, 'inform.explain');
  assert.equal(d.sourceOfTruth, 'external_knowledge');
  assert.equal(d.meta.reason, 'direct_signal');
});

test('assistant-directed: "Kun je opzoeken waarom dit gebeurt?" keeps existing external_knowledge routing', () => {
  const d = classify(user('Kun je opzoeken waarom dit gebeurt?'), silent);
  assert.equal(d.intent, 'inform.explain');
  assert.equal(d.sourceOfTruth, 'external_knowledge');
});

test('assistant-directed: bare imperatives and voor-me requests are never self-directed statements', () => {
  for (const input of ['Zoek dit even voor me.', 'Kun je dit onderzoeken?', 'Onderzoek dit voor me.']) {
    const d = classify(user(input), silent);
    assert.notEqual(d.meta.reason, 'self_directed_investigation_statement', input);
    assert.notEqual(d.speechAct, 'statement', input);
  }
});

test('self-directed decisions preserve the IntentIQ result through both transports', async () => {
  const { performTurn, performStreamingTurn } = require('../src/turn');
  const input = [{ role: 'user', content: 'Ik ga nu uitzoeken waarom jij traag reageert.' }];
  const decisions = [];
  const intent = classify(input, silent);
  const reasoning = { reasoningDepth: 'shallow' };
  const decisionEngine = (args) => {
    decisions.push(args.intent);
    return { action: 'native', reason: 'test', capability_execute: false };
  };
  const orchestrate = async () => ({ action: 'native', output: 'ok' });
  const common = {
    messages: input,
    documents: {},
    hermes: { chat: async () => 'unused', stream: async () => 'unused' },
    hindsight: { recall: async () => [], reflect: async () => {} },
    nativeGenerator: { generate: async () => 'ok', stream: async () => 'ok' },
    intentIQ: async () => intent,
    reasonIQ: async () => reasoning,
    decisionEngine,
    orchestrate,
  };
  await performTurn(common);
  await performStreamingTurn({ ...common, res: {
    writeHead() {}, write() {}, end() {}, status() { return this; }, json() {},
  } });
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions[0], decisions[1]);
});

// --- creative artifact requests vs concept explanations ---------------------
//
// "Wat is X?" is not automatically inform.explain: when the object of the
// question is something to be PRODUCED (a lyric, a title, a formulation),
// the creative frame outranks the generic cue. Concept questions without an
// artifact object keep their existing inform.explain routing.

const CREATIVE_ARTIFACT_CASES = [
  'ik wil mijn stem uploaden in Suno, wat is een goede songtekst om te zingen daarvoor?',
  'wat is een goede songtekst om te zingen?',
  'wat is een mooie titel voor dit lied?',
  'wat is een goede manier om dit te formuleren?',
  'ik wil een korte songtekst voor mijn stem',
  'kun je een goede songtekst voor me schrijven?',
  'wat is een mooie naam voor dit project?',
];

for (const input of CREATIVE_ARTIFACT_CASES) {
  test(`creative artifact: "${input}" is create.generate — never external_knowledge`, () => {
    const d = classify(user(input), silent);
    assert.equal(d.intent, 'create.generate');
    assert.equal(d.status, 'accepted');
    assert.equal(d.sourceOfTruth, 'conversation');
    assert.notEqual(d.sourceOfTruth, 'external_knowledge');
    assert.equal(d.speechAct, 'request');
    assert.equal(d.needsClarification, false);
    assert.equal(d.needsSemanticCheck, false);
    assert.equal(d.meta.reason, 'creative_artifact_request');
  });
}

const CONCEPT_EXPLAIN_CASES = [
  'Wat is Hindsight?',
  'Wat is de hoofdstad van Frankrijk?',
  'Wat is de huidige API van Suno?',
  'Wat is een goede uitleg van Hindsight?',
  'Hoe werkt het uploaden van mijn stem in Suno?',
];

for (const input of CONCEPT_EXPLAIN_CASES) {
  test(`concept explanation: "${input}" keeps inform.explain + external_knowledge`, () => {
    const d = classify(user(input), silent);
    assert.equal(d.intent, 'inform.explain');
    assert.equal(d.sourceOfTruth, 'external_knowledge');
    assert.notEqual(d.meta.reason, 'creative_artifact_request');
  });
}

test('creative artifact: a first-person wish to KNOW is vetoed — never generation', () => {
  const d = classify(user('ik wil weten wat een songtekst is'), silent);
  assert.notEqual(d.meta.reason, 'creative_artifact_request');
  assert.notEqual(d.intent, 'create.generate');
});

test('creative artifact requests never trigger the semantic fallback', async () => {
  const lines = [];
  const d = await interpret(user('wat is een goede songtekst om te zingen?'), {
    logger: (line) => lines.push(JSON.parse(line)),
    model: { chat: async () => { throw new Error('semantic model must not be called'); } },
  });
  assert.equal(d.intent, 'create.generate');
  assert.equal(lines.at(-1).semanticCalled, false);
});

// --- explicit research requests (assistant-directed) -------------------------

const RESEARCH_CASES = [
  'Zoek uit hoe ik mijn stem in Suno kan uploaden.',
  'Zoek dit even voor me op.',
  'Kun je onderzoeken waarom dit gebeurt?',
  'Onderzoek wat de huidige API hiervoor is.',
  'Kun je dit voor me onderzoeken?',
];

for (const input of RESEARCH_CASES) {
  test(`research request: "${input}" is inform.explain + external_knowledge (web-eligible)`, () => {
    const d = classify(user(input), silent);
    assert.equal(d.intent, 'inform.explain');
    assert.equal(d.status, 'accepted');
    assert.equal(d.sourceOfTruth, 'external_knowledge');
    assert.equal(d.needsClarification, false);
  });
}

test('research requests keep self-directed phrasing out — "ik zoek/onderzoek" stays a user statement', () => {
  for (const input of [
    'Ik zoek het zelf wel even uit.',
    'ik zoek wel even uit waarom jij traag reageert.',
    'Ik ga onderzoeken waarom dit gebeurt.',
    'Ik zal het zelf opzoeken.',
  ]) {
    const d = classify(user(input), silent);
    assert.equal(d.intent, 'converse', input);
    assert.equal(d.sourceOfTruth, 'conversation', input);
    assert.notEqual(d.sourceOfTruth, 'external_knowledge', input);
    assert.equal(d.meta.reason, 'self_directed_investigation_statement', input);
  }
});

test('creative artifact decisions preserve the IntentIQ result through both transports', async () => {
  const { performTurn, performStreamingTurn } = require('../src/turn');
  const input = [{ role: 'user', content: 'ik wil mijn stem uploaden in Suno, wat is een goede songtekst om te zingen daarvoor?' }];
  const decisions = [];
  const intent = classify(input, silent);
  const reasoning = { reasoningDepth: 'shallow' };
  const decisionEngine = (args) => {
    decisions.push(args.intent);
    return { action: 'native', reason: 'test', capability_execute: false };
  };
  const orchestrate = async () => ({ action: 'native', output: 'ok' });
  const common = {
    messages: input,
    documents: {},
    hermes: { chat: async () => 'unused', stream: async () => 'unused' },
    hindsight: { recall: async () => [], reflect: async () => {} },
    nativeGenerator: { generate: async () => 'ok', stream: async () => 'ok' },
    intentIQ: async () => intent,
    reasonIQ: async () => reasoning,
    decisionEngine,
    orchestrate,
  };
  await performTurn(common);
  await performStreamingTurn({ ...common, res: {
    writeHead() {}, write() {}, end() {}, status() { return this; }, json() {},
  } });
assert.equal(decisions.length, 2);
  assert.deepEqual(decisions[0], decisions[1]);
});

test('ambiguity calibration decisions preserve the IntentIQ result through both transports', async () => {
  const { performTurn, performStreamingTurn } = require('../src/turn');
  // A semantic-tier decision that is accepted (clear winner) must produce
  // the identical IntentIQ result on both transports.
  const intent = {
    schemaVersion: 'intentiq.v1', intent: 'converse', status: 'accepted',
    confidence: 0.85, ambiguous: false, needsClarification: false,
    speechAct: 'statement', sourceOfTruth: 'conversation', entities: [],
    candidates: [{ intent: 'converse', score: 0.85 }, { intent: 'meta.relational', score: 0.6 }],
    referents: [], needsSemanticCheck: false,
  };
  const decisions = [];
  const reasoning = { reasoningDepth: 'shallow' };
  const decisionEngine = (args) => {
    decisions.push(args.intent);
    return { action: 'native', reason: 'test', capability_execute: false };
  };
  const orchestrate = async () => ({ action: 'native', output: 'ok' });
  const common = {
    messages: [{ role: 'user', content: 'dank je, je bent nog slimmer als het goed is' }],
    documents: {},
    hermes: { chat: async () => 'unused', stream: async () => 'unused' },
    hindsight: { recall: async () => [], reflect: async () => {} },
    nativeGenerator: { generate: async () => 'ok', stream: async () => 'ok' },
    intentIQ: async () => intent,
    reasonIQ: async () => reasoning,
    decisionEngine,
    orchestrate,
  };
  await performTurn(common);
  await performStreamingTurn({ ...common, res: {
    writeHead() {}, write() {}, end() {}, status() { return this; }, json() {},
  } });
assert.equal(decisions.length, 2);
  assert.deepEqual(decisions[0], decisions[1]);
});

test('v0.4: the frame survives trailing clauses and multi-sentence reports', () => {
  for (const text of [
    'ik heb die mogelijkheid wel toegevoegd. Kennelijk moet ik terug naar de tekenafel',
    'ik heb net de nieuwe retrieval-capability gebouwd',
    'ik heb de tests bijgewerkt maar twee falen nog',
  ]) {
    const d = classify(user(text), silent);
    assert.equal(d.meta.reason, 'declarative_status_update', text);
    assert.equal(d.needsClarification, false);
  }
});

test('v0.4: English mirrors work', () => {
  const d = classify(user('Added the new capability to the registry.'), silent);
  assert.equal(d.intent, 'converse');
  assert.equal(d.meta.reason, 'declarative_status_update');
});

test('v0.4: requests, questions and non-completion statements stay outside the frame', () => {
  // Imperative request — NOT a status report.
  assert.equal(classify(user('Voeg de capability toe aan de registry'), silent).meta.reason, 'no_signal_matched');
  // 'ik heb' without a completion verb.
  assert.equal(classify(user('Ik heb een vraag'), silent).status, 'unknown');
  assert.equal(classify(user('ik heb honger'), silent).status, 'unknown');
  // A question is never a status report, even with the same words.
  const q = classify(user('heb ik die capability toegevoegd?'), silent);
  assert.notEqual(q.meta.reason, 'declarative_status_update');
  // Meta-intent about Gaia's own actions keeps its existing path.
  const meta = classify(user('Waarom heb je dat toegevoegd?'), silent);
  assert.notEqual(meta.meta.reason, 'declarative_status_update');
});

test('v0.4: decision integration — status updates route native, never to clarify', () => {
  const { decide } = require('../src/decision/decisionEngine');
  const intent = classify(user('ik heb de capability toegevoegd maar kennelijk werkt het nog niet'), silent);
  const decision = decide({
    userInput: 'ik heb de capability toegevoegd maar kennelijk werkt het nog niet',
    intent,
    context: { reflections: [], mentalModels: [], patterns: [] },
    reasoning: null,
    availableCapabilities: [{ id: 'hermes' }, { id: 'native' }],
  });
  assert.notEqual(decision.action, 'clarify');
  assert.equal(decision.action, 'native');
});
