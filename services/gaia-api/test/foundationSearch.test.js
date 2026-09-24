'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readFoundationConfig,
  isConfigured,
  epistemicLabel,
  createFoundationClient,
  createFoundationRetrievalCapability,
  formatFoundationOutcome,
  createFromEnv,
} = require('../src/tools/foundationSearch');

// --- Configuration ----------------------------------------------------------

test('readFoundationConfig reads from environment variables', () => {
  const env = {
    FOUNDATION_MEMORY_URL: 'http://100.65.0.15:4577',
    FOUNDATION_API_TOKEN: 'tok-123',
    FOUNDATION_MEMORY_LIMIT: '8',
  };
  const config = readFoundationConfig(env);
  assert.equal(config.baseUrl, 'http://100.65.0.15:4577');
  assert.equal(config.token, 'tok-123');
  assert.equal(config.limit, 8);
});

test('readFoundationConfig defaults: no baseUrl, no token, limit 6', () => {
  const config = readFoundationConfig({});
  assert.equal(config.baseUrl, '');
  assert.equal(config.token, '');
  assert.equal(config.limit, 6);
});

test('isConfigured requires only a baseUrl', () => {
  assert.equal(isConfigured({ baseUrl: '' }), false);
  assert.equal(isConfigured({ baseUrl: 'http://127.0.0.1:4577' }), true);
});

// --- createFromEnv (the composition server.js uses) -------------------------

test('createFromEnv returns undefined when FOUNDATION_MEMORY_URL is unset — the Decision Engine never sees a "foundation" capability', () => {
  assert.equal(createFromEnv({}), undefined);
});

test('createFromEnv returns a working capability when FOUNDATION_MEMORY_URL is set', () => {
  const capability = createFromEnv({ FOUNDATION_MEMORY_URL: 'http://127.0.0.1:4577' });
  assert.ok(capability);
  assert.equal(typeof capability.invoke, 'function');
});

// --- createFoundationClient ---------------------------------------------------

test('createFoundationClient throws when baseUrl is missing', () => {
  assert.throws(() => createFoundationClient({}), /FOUNDATION_MEMORY_URL/);
});

test('searchResults calls /api/memory/search with the query and limit, no Origin header (Foundation guards on Origin)', async () => {
  let seenUrl;
  let seenOptions;
  const fetchImpl = async (url, options) => {
    seenUrl = new URL(url);
    seenOptions = options;
    return { ok: true, json: async () => ({ results: [] }) };
  };
  const client = createFoundationClient({ baseUrl: 'http://100.65.0.15:4577', fetchImpl });
  await client.searchResults('wat heb ik vastgelegd over X', { limit: 8 });

  assert.equal(seenUrl.origin + seenUrl.pathname, 'http://100.65.0.15:4577/api/memory/search');
  assert.equal(seenUrl.searchParams.get('q'), 'wat heb ik vastgelegd over X');
  assert.equal(seenUrl.searchParams.get('limit'), '8');
  assert.equal(seenOptions.headers.Origin, undefined);
  assert.equal(seenOptions.headers.Authorization, undefined); // no token configured = no auth header
});

test('searchResults sends the Bearer token only when FOUNDATION_API_TOKEN is set', async () => {
  let seenHeaders;
  const fetchImpl = async (_url, options) => {
    seenHeaders = options.headers;
    return { ok: true, json: async () => ({ results: [] }) };
  };
  const client = createFoundationClient({ baseUrl: 'http://x:1', token: 'tok-abc', fetchImpl });
  await client.searchResults('q');
  assert.equal(seenHeaders.Authorization, 'Bearer tok-abc');
});

test('searchResults clamps limit to 1..10 (Foundation accepts max 50; Gaia stays compact)', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(new URL(url).searchParams.get('limit'));
    return { ok: true, json: async () => ({ results: [] }) };
  };
  const client = createFoundationClient({ baseUrl: 'http://x:1', fetchImpl });
  await client.searchResults('q', { limit: 999 });
  await client.searchResults('q', { limit: -5 });
  await client.searchResults('q', { limit: 0 }); // falsy → DEFAULT_LIMIT (6), not 1
  assert.deepEqual(seen, ['10', '1', '6']);
});

// --- Epistemic labels (Manifest §5: status never silently lost) ---------------

test('epistemicLabel distinguishes confirmed facts, superseded facts and every hypothesis status', () => {
  assert.equal(epistemicLabel({ kind: 'fact' }), '[bevestigd feit]');
  assert.equal(epistemicLabel({ kind: 'fact', superseded: true }), '[vervallen feit]');
  assert.equal(epistemicLabel({ kind: 'hypothesis', status: 'open' }), '[hypothese · open]');
  assert.equal(epistemicLabel({ kind: 'hypothesis', status: 'confirmed' }), '[hypothese · bevestigd]');
  assert.equal(epistemicLabel({ kind: 'hypothesis', status: 'rejected' }), '[hypothese · verworpen]');
  // Unknown shapes get an honest generic label, never a confident guess.
  assert.equal(epistemicLabel({ kind: 'something-new' }), '[geheugen]');
  assert.equal(epistemicLabel(null), '[geheugen]');
});

// --- Capability invoke: Foundation response -> { results, total } --------------

test('invoke maps results with the status label FIRST, so it survives truncation', async () => {
  const client = {
    searchResults: async () => ([
      { kind: 'fact', id: 'f1', text: 'Bo gebruikt Tailscale voor alle VPS-toegang.', score: 0.91 },
      { kind: 'hypothesis', id: 'h1', status: 'open', text: 'Misschien wordt Chronicle de primaire client.', score: 0.4 },
      { kind: 'fact', id: 'f2', superseded: true, text: 'De Hermes-kabel staat aan.', score: 0.2 },
    ]),
  };
  const capability = createFoundationRetrievalCapability({ client });
  const outcome = await capability.invoke([], { input: { query: 'wat staat er vast over de VPS', limit: 6 } });

  assert.equal(outcome.total, 3);
  assert.match(outcome.results[0].text, /^\[bevestigd feit\] Bo gebruikt Tailscale/);
  assert.match(outcome.results[1].text, /^\[hypothese · open\] Misschien wordt Chronicle/);
  assert.match(outcome.results[2].text, /^\[vervallen feit\] De Hermes-kabel/);
  assert.equal(outcome.results[0].relevance, 0.91);
  assert.equal(outcome.results[1].relevance, 0.4);
  for (const r of outcome.results) assert.ok(r.text.length <= 280, 'compact passages only');
});

test('invoke: a missing score maps to null relevance; a missing query returns an empty outcome without calling Foundation', async () => {
  let calls = 0;
  const client = { searchResults: async () => { calls += 1; return []; } };
  const capability = createFoundationRetrievalCapability({ client });

  const empty = await capability.invoke([], { input: { query: '   ' } });
  assert.deepEqual(empty, { results: [], total: 0 });
  assert.equal(calls, 0);

  const noScoreClient = { searchResults: async () => ([{ kind: 'fact', text: 'x' }]) };
  const outcome = await createFoundationRetrievalCapability({ client: noScoreClient }).invoke([], { input: { query: 'q' } });
  assert.equal(outcome.results[0].relevance, null);
});

test('invoke skips results without text (never emits an empty labelled line)', async () => {
  const client = { searchResults: async () => ([{ kind: 'fact' }, { kind: 'fact', text: '  ' }, { kind: 'fact', text: 'bewaard' }]) };
  const outcome = await createFoundationRetrievalCapability({ client }).invoke([], { input: { query: 'q' } });
  assert.equal(outcome.total, 1);
  assert.match(outcome.results[0].text, /^\[bevestigd feit\] bewaard$/);
});

test('createFoundationRetrievalCapability requires a client', () => {
  assert.throws(() => createFoundationRetrievalCapability({}), /foundation client/);
});

// --- Error handling: never leak provider/transport details ---------------------

test('searchResults throws a calm, generic error on network failure — no host, no token', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED 100.65.0.15:4577 (token=tok-abc)'); };
  const client = createFoundationClient({ baseUrl: 'http://100.65.0.15:4577', token: 'tok-abc', fetchImpl });
  await assert.rejects(() => client.searchResults('x'), (err) => {
    assert.match(err.message, /foundation search unreachable/);
    assert.ok(!err.message.includes('100.65.0.15'));
    assert.ok(!err.message.includes('tok-abc'));
    return true;
  });
});

test('searchResults throws a calm, generic error on a non-200 response (e.g. Foundation embedding down = 503)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const client = createFoundationClient({ baseUrl: 'http://x:1', fetchImpl });
  await assert.rejects(() => client.searchResults('x'), (err) => {
    assert.match(err.message, /foundation search responded with an error/);
    assert.ok(!err.message.includes('503'));
    return true;
  });
});

test('searchResults throws a calm error on an unreadable (non-JSON) response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  const client = createFoundationClient({ baseUrl: 'http://x:1', fetchImpl });
  await assert.rejects(() => client.searchResults('x'), /foundation search returned an unreadable response/);
});

test('searchResults treats a malformed body (no results array) as an empty result set, not a crash', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ unexpected: 'shape' }) });
  const client = createFoundationClient({ baseUrl: 'http://x:1', fetchImpl });
  assert.deepEqual(await client.searchResults('x'), []);
});

// --- Compact presentation ------------------------------------------------------

test('formatFoundationOutcome is honest about zero results and labels the rest', () => {
  assert.match(formatFoundationOutcome(undefined), /Niets in Foundation gevonden/);
  assert.match(formatFoundationOutcome({ results: [] }), /Niets in Foundation gevonden/);
  const text = formatFoundationOutcome({ results: [{ text: '[bevestigd feit] X', relevance: 0.8 }] });
  assert.match(text, /Gevonden in Foundation/);
  assert.match(text, /\[bevestigd feit\] X \(relevantie: 0\.8\)/);
});

// --- Architectural invariant: no cognitive dependencies -------------------------

test('foundationSearch.js has no code-level dependency on Hermes, the native generator, IntentIQ/ReasonIQ, the Decision Engine, the Orchestrator, or the Response Engine', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/tools/foundationSearch.js'), 'utf-8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const forbidden = [
    'hermesClient', 'gaiaGenerator', 'intentIQ', 'reasonIQ',
    'decisionEngine', 'orchestrator', 'responseEngine',
  ];
  for (const name of forbidden) {
    assert.ok(!codeOnly.includes(name), `foundationSearch.js must not reference ${name}`);
  }
});
