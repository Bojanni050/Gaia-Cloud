'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readFoundationConfig,
  isConfigured,
  epistemicLabel,
  createFoundationClient,
  renderFoundationContext,
  createFromEnv,
} = require('../src/foundationClient');

test('epistemicLabel: facts are confirmed unless superseded; hypotheses carry their status', () => {
  assert.equal(epistemicLabel({ kind: 'fact' }), '[bevestigd feit]');
  assert.equal(epistemicLabel({ kind: 'fact', superseded: true }), '[vervallen feit]');
  assert.equal(epistemicLabel({ kind: 'hypothesis', status: 'confirmed' }), '[hypothese · bevestigd]');
  assert.equal(epistemicLabel({ kind: 'hypothesis', status: 'rejected' }), '[hypothese · verworpen]');
  assert.equal(epistemicLabel({ kind: 'hypothesis', status: 'testing' }), '[hypothese · open]');
  assert.equal(epistemicLabel(null), '[geheugen]');
  assert.equal(epistemicLabel({ kind: 'mystery' }), '[geheugen]');
});

test('readFoundationConfig prefers FOUNDATION_URL and falls back to FOUNDATION_MEMORY_URL', () => {
  assert.equal(readFoundationConfig({ FOUNDATION_URL: 'http://f' }).baseUrl, 'http://f');
  assert.equal(readFoundationConfig({ FOUNDATION_MEMORY_URL: 'http://legacy' }).baseUrl, 'http://legacy');
  assert.equal(isConfigured(readFoundationConfig({})), false);
  assert.equal(isConfigured(readFoundationConfig({ FOUNDATION_URL: 'http://f' })), true);
});

test('createFromEnv returns undefined when no base URL is set', () => {
  assert.equal(createFromEnv({}), undefined);
});

test('searchResults GETs /api/memory/search with the bounded limit and returns results', async () => {
  const calls = [];
  const client = createFoundationClient({
    baseUrl: 'http://foundation:4577/',
    token: 'tok',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ results: [{ kind: 'fact', text: 'iets' }] }) };
    },
  });

  const results = await client.searchResults('mijn planning', { limit: 99 });

  assert.equal(results.length, 1);
  const { url, init } = calls[0];
  assert.match(url, /^http:\/\/foundation:4577\/api\/memory\/search\?/);
  assert.ok(url.includes('q=mijn+planning') || url.includes('q=mijn%20planning'));
  assert.ok(url.includes('limit=10'), 'limit is bounded to MAX_LIMIT');
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, 'Bearer tok');
});

test('searchResults throws a calm generic error when Foundation is unreachable', async () => {
  const client = createFoundationClient({
    baseUrl: 'http://foundation:4577',
    fetchImpl: async () => { throw new Error('ECONNREFUSED at http://foundation:4577'); },
  });

  await assert.rejects(
    () => client.searchResults('x'),
    (err) => err.message === 'foundation search unreachable' && !/foundation:4577/.test(err.message),
  );
});

test('submitObservation POSTs the chat entry-point with source, turns and no client status', async () => {
  const calls = [];
  const client = createFoundationClient({
    baseUrl: 'http://foundation:4577',
    token: 'tok',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    },
  });

  const ok = await client.submitObservation({
    content: 'user\n\nreply',
    source: 'gaia',
    turns: [{ role: 'user', text: 'user' }, { role: 'assistant', text: 'reply' }],
    tags: ['gaia-turn'],
    occurredAt: '2026-10-04T00:00:00Z',
  });

  assert.equal(ok, true);
  assert.equal(calls[0].url, 'http://foundation:4577/api/ingest/chat');
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.source, 'gaia');
  assert.equal(body.content, 'user\n\nreply');
  assert.equal(body.turns.length, 2);
  assert.equal(body.status, undefined, 'a client must never claim a status');
  assert.equal(body.providerConversationId, undefined);
});

test('submitObservation never throws — a dead Foundation is a calm false', async () => {
  const client = createFoundationClient({
    baseUrl: 'http://foundation:4577',
    fetchImpl: async () => { throw new Error('boom'); },
  });

  assert.equal(await client.submitObservation({ content: 'x' }), false);
  assert.equal(await client.submitObservation({ content: '   ' }), false);
});

test('renderFoundationContext is null with no usable results and labels the rest', () => {
  assert.equal(renderFoundationContext([]), null);
  assert.equal(renderFoundationContext([{ text: '  ' }]), null);

  const block = renderFoundationContext([
    { kind: 'fact', text: 'Vastgelegd feit.' },
    { kind: 'hypothesis', status: 'testing', text: 'Open hypothese.' },
  ]);
  assert.match(block, /\[bevestigd feit\] Vastgelegd feit\./);
  assert.match(block, /\[hypothese · open\] Open hypothese\./);
});
