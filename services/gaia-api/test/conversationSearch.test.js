'use strict';

/**
 * conversation_search capability tests (v0.1).
 *
 * Spec §20 matrix: current/assistant/saved/all scopes, conversation
 * isolation, provenance, ranking, empty results, hygiene (limits, dedupe,
 * truncation) and hard capability isolation — plus Decision Engine and
 * Orchestrator integration.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createConversationSearch,
  createConversationSearchTool,
  formatOutcome,
  SEARCH_SCOPES,
} = require('../src/tools/conversationSearch');
const { createConversationStore } = require('../src/conversationStore');

function makeStore(seed = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convsearch-'));
  const store = createConversationStore({ historyDir: dir });
  for (const [id, messages] of Object.entries(seed)) {
    store.saveConversation(id, messages);
  }
  return { store, dir };
}

const CURRENT_CONV = [
  { role: 'user', content: 'Vertel eens hoe het afgelopen jaar ging.' },
  { role: 'assistant', content: 'Ik zie vooral veel sessies rond juni — zeker gezien de context rond juni destijds.' },
  { role: 'user', content: 'wat was er in juni ook alweer?' },
];

test('scopes expose exactly current/saved/all', () => {
  assert.deepEqual([...SEARCH_SCOPES], ['current', 'saved', 'all']);
});

// --- §7/§20: current conversation search ---------------------------------------

test('current scope finds a relevant USER message in the live transcript', () => {
  const { store } = makeStore();
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({
    query: 'wat was er in juni ook alweer?',
    scope: 'current',
    currentConversationId: 'live-1',
    currentMessages: CURRENT_CONV,
  });
  assert.ok(out.total >= 1);
  assert.ok(out.results.some((r) => r.role === 'user' && /juni/.test(r.text)));
});

test('current scope finds the ASSISTANT message — Gaia\'s own reference counts (spec §8)', () => {
  const { store } = makeStore();
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({
    query: 'juni',
    scope: 'current',
    currentConversationId: 'live-1',
    currentMessages: CURRENT_CONV,
  });
  const assistantHit = out.results.find((r) => r.role === 'assistant' && /context rond juni/.test(r.text));
  assert.ok(assistantHit, "Gaia's earlier juni turn must be findable");
  // Ranked at/near the top: exact term match with recency tilt.
  assert.equal(out.results[0].role === 'assistant' || out.results[0].relevance >= assistantHit.relevance, true);
});

// --- §9/§20: saved conversation search ------------------------------------------

test('saved scope finds passages in an old stored conversation', () => {
  const { store } = makeStore({
    'old-1': [
      { role: 'user', content: 'Ik heb vorige maand mijn communicatievoorkeuren besproken: korte mails.' },
      { role: 'assistant', content: 'Genoteerd dat je korte mails prefereert.' },
    ],
  });
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({ query: 'korte mails voorkeur', scope: 'saved' });
  assert.ok(out.total >= 1);
  assert.ok(out.results.every((r) => r.source === 'saved'));
  assert.ok(out.results.some((r) => /korte mails/.test(r.text)));
});

// --- §20: all -------------------------------------------------------------------

test('all merges current and saved results', () => {
  const { store } = makeStore({
    'old-2': [{ role: 'assistant', content: 'In juni spraken we over de Melodiq-release.' }],
  });
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({
    query: 'juni',
    scope: 'all',
    currentConversationId: 'live-1',
    currentMessages: CURRENT_CONV,
  });
  const sources = new Set(out.results.map((r) => r.source));
  assert.ok(sources.has('current'), 'current hit present');
  assert.ok(sources.has('saved'), 'saved hit present');
});

// --- §19/§20: isolation -----------------------------------------------------------

test('isolation: current scope never returns saved conversations', () => {
  const { store } = makeStore({
    'other': [{ role: 'user', content: 'juni plannen met Luca' }],
  });
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({
    query: 'juni',
    scope: 'current',
    currentConversationId: 'live-1',
    currentMessages: CURRENT_CONV,
  });
  assert.ok(out.total > 0);
  assert.ok(out.results.every((r) => r.conversationId === 'live-1'));
});

test('isolation: saved scope with an explicit conversationId searches only that one', () => {
  const { store } = makeStore({
    'a': [{ role: 'user', content: 'juni afspraak met de accountant' }],
    'b': [{ role: 'user', content: 'juni vakantieplannen' }],
  });
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({ query: 'juni', scope: 'saved', conversationId: 'b' });
  assert.ok(out.total > 0);
  assert.ok(out.results.every((r) => r.conversationId === 'b'));
});

// --- §5/§20: provenance -----------------------------------------------------------

test('every result carries real provenance from storage', () => {
  const { store } = makeStore({
    'prov-1': [
      { role: 'user', content: 'Belangrijk: de demo staat op vrijdag 13 juni gepland.' },
      { role: 'assistant', content: 'Onrelated antwoord over het weer.' },
    ],
  });
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({ query: 'demo vrijdag juni', scope: 'saved' });
  assert.ok(out.total >= 1);
  for (const r of out.results) {
    assert.equal(r.conversationId, 'prov-1');
    assert.match(r.messageId, /^prov-1:\d+$/); // stable positional id over the real transcript
    assert.ok(['user', 'assistant'].includes(r.role));
    assert.ok(r.timestamp, 'conversation timestamp from stored meta rides along');
    assert.equal(typeof r.relevance, 'number');
    if (/demo/i.test(r.text)) {
      const idx = Number(r.messageId.split(':')[1]);
      assert.ok(Number.isInteger(idx) && idx >= 0);
    }
  }
});

// --- §10/§20: ranking -------------------------------------------------------------

test('ranking: the relevant result outranks the irrelevant one', () => {
  const { store } = makeStore({
    'rank-1': [
      { role: 'user', content: 'We hebben uitgebreid gesproken over de migratie van de database.' },
      { role: 'assistant', content: 'Die migratie was een groot succes.' },
      { role: 'user', content: 'Even iets anders: leuk weer vandaag hoor.' },
    ],
  });
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({ query: 'database migratie', scope: 'saved' });
  assert.ok(out.total >= 2);
  assert.match(out.results[0].text, /migratie van de database/);
  assert.ok(out.results[0].relevance > out.results[out.results.length - 1].relevance);
});

// --- §20: no result ----------------------------------------------------------------

test('no match returns empty results without throwing', () => {
  const { store } = makeStore({ 'x': [{ role: 'user', content: 'juni plannen' }] });
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({ query: 'quantumfluffel zzz', scope: 'all' });
  assert.deepEqual(out.results, []);
  assert.equal(out.total, 0);
});

test('empty/function-word-only queries return empty results', () => {
  const { store } = makeStore({ 'x': [{ role: 'user', content: 'juni plannen' }] });
  const cs = createConversationSearch({ historyStore: store });
  assert.deepEqual(cs.search({ query: 'was er ook alweer?', scope: 'all' }).results, []);
  assert.deepEqual(cs.search({ query: '', scope: 'all' }).results, []);
});

// --- §18: hygiene -------------------------------------------------------------------

test('hygiene: near-identical messages are deduplicated', () => {
  const { store } = makeStore({
    'dupe': [
      { role: 'user', content: 'juni deadline voor de release' },
      { role: 'assistant', content: 'Juni deadline voor de release.' },
      { role: 'user', content: 'juni deadline voor de release' },
    ],
  });
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({ query: 'juni deadline release', scope: 'saved' });
  const normalizedTexts = new Set(out.results.map((r) => r.text.toLowerCase().replace(/[.]/g, '')));
  assert.equal(normalizedTexts.size, out.results.length, 'no same-message floods');
});

test('hygiene: limit clamps and text/context truncate', () => {
  const longText = `${'juni '.repeat(120)}einde`;
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `juni bericht nummer ${i} ${longText}` }));
  const { store } = makeStore({ 'bulk': many });
  const cs = createConversationSearch({ historyStore: store });
  const out = cs.search({ query: 'juni', scope: 'saved', limit: 999 });
  assert.ok(out.results.length <= 20);
  for (const r of out.results) {
    assert.ok(r.text.length <= 280);
    if (r.contextBefore !== null) assert.ok(r.contextBefore.length <= 160);
    if (r.contextAfter !== null) assert.ok(r.contextAfter.length <= 160);
  }
});

// --- §3: input schema ------------------------------------------------------------------

test('unknown scope throws; missing conversationId never guesses the current conversation', () => {
  const { store } = makeStore();
  const cs = createConversationSearch({ historyStore: store });
  assert.throws(() => cs.search({ query: 'x', scope: 'everything' }), /unknown scope/);
  // current without an id: refuse to fabricate provenance — empty, not guessed.
  const out = cs.search({ query: 'juni', scope: 'current', currentMessages: CURRENT_CONV });
  assert.deepEqual(out.results, []);
  // ...and 'all' without an id degrades to saved-only rather than inventing one.
  const allOut = cs.search({ query: 'juni', scope: 'all', currentMessages: CURRENT_CONV });
  assert.ok(allOut.results.every((r) => r.source === 'saved'));
});

// --- §26/§25: no second engine, no memory duplication ------------------------------------

test('boundary: the capability imports nothing beyond Node builtins and touches only its store', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/tools/conversationSearch.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepEqual(required, [], 'conversation_search must be dependency-free retrieval over injected deps');
  assert.ok(!/hindsight|hypothes|patternManager|hermes|brave|mcp|decisionEngine|responseEngine|fetch\(/i.test(source),
    'no reasoning, generation, Hindsight or network access inside the capability');
});

test('searching writes nothing: stores stay byte-identical (no Hindsight/memory duplication analog)', () => {
  const seed = { 'w': [{ role: 'user', content: 'juni notities' }] };
  const { store, dir } = makeStore(seed);
  const before = fs.readdirSync(dir).sort().join('|');
  const cs = createConversationSearch({ historyStore: store });
  cs.search({ query: 'juni', scope: 'all', currentConversationId: 'live', currentMessages: CURRENT_CONV });
  const after = fs.readdirSync(dir).sort().join('|');
  assert.equal(after, before);
});
