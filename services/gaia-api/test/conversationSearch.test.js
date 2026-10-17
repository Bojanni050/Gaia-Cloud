'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConversationStore } = require('../src/conversationStore');
const {
  createConversationSearch,
  renderConversationHistoryContext,
  tokenize,
  scoreMessage,
  makeSnippet,
} = require('../src/conversationSearch');

function tempSearch() {
  const store = createConversationStore({ historyDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-convsearch-')) });
  return { store, search: createConversationSearch({ store }) };
}

// --- tokenize --------------------------------------------------------------

test('tokenize lowers, strips diacritics, drops stopwords and short tokens, dedups', () => {
  assert.deepEqual(tokenize('Wat zei ik over de VPS en de café?'), ['vps', 'cafe']);
  assert.deepEqual(tokenize('the what about'), []);
  assert.deepEqual(tokenize(''), []);
});

// --- scoreMessage / makeSnippet -------------------------------------------

test('scoreMessage scores by query-token coverage', () => {
  assert.equal(scoreMessage('we zetten de vps om naar tailscale', ['vps', 'tailscale']).score, 1);
  assert.equal(scoreMessage('alleen vps hier', ['vps', 'tailscale']).score, 0.5);
  assert.equal(scoreMessage('niets relevants', ['vps']).score, 0);
});

test('makeSnippet keeps the match and adds ellipses only when trimmed', () => {
  assert.equal(makeSnippet('kort', ['kort']), 'kort');
  const long = `${'x'.repeat(300)} tailscale ${'y'.repeat(300)}`;
  const snippet = makeSnippet(long, ['tailscale'], 100);
  assert.ok(snippet.includes('tailscale'));
  assert.ok(snippet.length <= 102);
  assert.match(snippet, /…/);
});

// --- search ----------------------------------------------------------------

test('search finds the literal text across saved conversations, best message per conversation', () => {
  const { store, search } = tempSearch();
  store.saveConversation('conv-1', [
    { role: 'user', content: 'we zetten de VPS om naar Tailscale' },
    { role: 'assistant', content: 'prima, dan is de VPS alleen via de tailnet bereikbaar' },
  ]);
  store.saveConversation('conv-2', [{ role: 'user', content: 'iets over de tuin' }]);

  const hits = search.search('tailscale vps');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].conversationId, 'conv-1');
  assert.equal(hits[0].title, 'we zetten de VPS om naar Tailscale');
  assert.deepEqual(hits[0].matchedTerms.sort(), ['tailscale', 'vps']);
  assert.ok(hits[0].updatedAt);
});

test('search excludes the current conversation and ranks by coverage', () => {
  const { store, search } = tempSearch();
  store.saveConversation('conv-a', [{ role: 'user', content: 'vps tailscale' }]);
  store.saveConversation('conv-b', [{ role: 'user', content: 'vps' }]);

  const hits = search.search('vps tailscale');
  assert.deepEqual(hits.map((h) => h.conversationId), ['conv-a', 'conv-b']);

  const excluded = search.search('vps', { excludeConversationId: 'conv-a' });
  assert.deepEqual(excluded.map((h) => h.conversationId), ['conv-b']);
});

test('search returns [] for an empty or stopword-only query, and never throws on an unreadable conversation', () => {
  const brokenStore = {
    listConversations: () => [{ id: 'ok' }, { id: 'broken' }],
    getConversation: (id) => {
      if (id === 'broken') throw new Error('unreadable');
      return { messages: [{ role: 'user', content: 'de vps staat op tailscale' }] };
    },
  };
  const search = createConversationSearch({ store: brokenStore });

  assert.deepEqual(search.search(''), []);
  assert.deepEqual(search.search('de het een'), []);
  assert.deepEqual(search.search('vps').map((h) => h.conversationId), ['ok']);
});

// --- renderConversationHistoryContext --------------------------------------

test('renderConversationHistoryContext is null with nothing, and frames hits as literal fragments', () => {
  assert.equal(renderConversationHistoryContext([]), null);
  assert.equal(renderConversationHistoryContext([{ snippet: '  ' }]), null);

  const block = renderConversationHistoryContext([
    { title: 'VPS', updatedAt: '2026-10-01T10:00:00Z', role: 'user', snippet: 'we zetten de VPS om naar Tailscale' },
  ]);
  assert.match(block, /Letterlijke fragmenten/);
  assert.match(block, /\[VPS/);
  assert.match(block, /we zetten de VPS om naar Tailscale/);
});

test('renderConversationHistoryContext adds the real age next to the calendar date', () => {
  const now = Date.parse('2026-10-17T18:42:00Z');
  const block = renderConversationHistoryContext([
    { title: 'VPS', updatedAt: '2026-10-14T10:00:00Z', role: 'user', snippet: 'we zetten de VPS om' },
  ], now);
  assert.match(block, /\[VPS · 14-10-2026 · 3 dagen geleden\] de persoon/);
});
