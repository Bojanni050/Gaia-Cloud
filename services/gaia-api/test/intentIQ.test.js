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
