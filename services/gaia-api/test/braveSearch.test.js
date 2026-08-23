'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBraveSearch,
  readWebSearchConfig,
  isConfigured,
  createFromEnv,
  formatResults,
} = require('../src/tools/braveSearch');

// --- Configuration ----------------------------------------------------------

test('readWebSearchConfig reads from environment variables', () => {
  const env = {
    GAIA_WEB_SEARCH_BASE_URL: 'http://test:1234/search',
    GAIA_WEB_SEARCH_API_KEY: 'test-key',
    GAIA_WEB_SEARCH_RESULT_COUNT: '3',
  };
  const config = readWebSearchConfig(env);
  assert.equal(config.baseUrl, 'http://test:1234/search');
  assert.equal(config.apiKey, 'test-key');
  assert.equal(config.resultCount, 3);
});

test('readWebSearchConfig defaults to the real Brave endpoint and 5 results', () => {
  const config = readWebSearchConfig({});
  assert.equal(config.baseUrl, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(config.apiKey, '');
  assert.equal(config.resultCount, 5);
});

test('isConfigured requires only an apiKey (baseUrl always has a default)', () => {
  assert.equal(isConfigured({ apiKey: '' }), false);
  assert.equal(isConfigured({ apiKey: 'x' }), true);
});

// --- createFromEnv (the composition server.js uses) -------------------------

test('createFromEnv returns undefined when GAIA_WEB_SEARCH_API_KEY is unset — the Decision Engine never sees a "web" capability', () => {
  assert.equal(createFromEnv({}), undefined);
});

test('createFromEnv returns a working client when an apiKey is set', () => {
  const webSearch = createFromEnv({ GAIA_WEB_SEARCH_API_KEY: 'test-key' });
  assert.ok(webSearch);
  assert.equal(typeof webSearch.search, 'function');
});

// --- createBraveSearch / search ---------------------------------------------

test('createBraveSearch throws when apiKey is missing', () => {
  assert.throws(() => createBraveSearch({}), /GAIA_WEB_SEARCH_API_KEY/);
});

test('search() calls the Brave endpoint with the query, result count, and auth header', async () => {
  let seenUrl;
  let seenHeaders;
  const fetchImpl = async (url, options) => {
    seenUrl = new URL(url);
    seenHeaders = options.headers;
    return { ok: true, json: async () => ({ web: { results: [] } }) };
  };
  const client = createBraveSearch({ apiKey: 'secret-brave-key', resultCount: 3, fetchImpl });
  await client.search('current OpenAI API documentation');

  assert.equal(seenUrl.origin + seenUrl.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(seenUrl.searchParams.get('q'), 'current OpenAI API documentation');
  assert.equal(seenUrl.searchParams.get('count'), '3');
  assert.equal(seenHeaders['X-Subscription-Token'], 'secret-brave-key');
});

test('search() formats results into a calm, source-attributed answer', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      web: {
        results: [
          { title: 'OpenAI API Reference', url: 'https://platform.openai.com/docs/api-reference', description: 'The <strong>official</strong> API reference.' },
          { title: 'OpenAI Docs', url: 'https://platform.openai.com/docs', description: 'Guides and docs.' },
        ],
      },
    }),
  });
  const client = createBraveSearch({ apiKey: 'test-key', fetchImpl });
  const text = await client.search('openai api docs');

  assert.match(text, /OpenAI API Reference/);
  assert.match(text, /platform\.openai\.com\/docs\/api-reference/);
  // Brave's own <strong> highlight markup is stripped, not leaked as raw HTML.
  assert.ok(!text.includes('<strong>'));
  assert.match(text, /official API reference/);
});

test("search() decodes HTML entities Brave's own snippets carry (e.g. &quot;), not just strips tags — found live in production", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      web: {
        results: [{
          title: 'API Overview | OpenAI API Reference',
          url: 'https://platform.openai.com/docs/api-reference/introduction',
          description: 'Don&#8217;t share it with others. string key = Environment.GetEnvironmentVariable(&quot;OPENAI_API_KEY&quot;)!;',
        }],
      },
    }),
  });
  const client = createBraveSearch({ apiKey: 'test-key', fetchImpl });
  const text = await client.search('openai api docs');

  assert.match(text, /"OPENAI_API_KEY"/);
  assert.match(text, /Don’t share it/);
  assert.ok(!text.includes('&quot;'));
  assert.ok(!text.includes('&#8217;'));
});

test('search() answers honestly (not an error) when there are no results', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ web: { results: [] } }) });
  const client = createBraveSearch({ apiKey: 'test-key', fetchImpl });
  const text = await client.search('something extremely obscure');
  assert.match(text, /couldn't find anything relevant/);
});

test('formatResults handles a missing/malformed web.results shape gracefully', () => {
  assert.match(formatResults(undefined), /couldn't find anything relevant/);
  assert.match(formatResults([]), /couldn't find anything relevant/);
});

// --- Error handling: never leak provider/transport/API-key details ---------

test('search() throws a calm, generic error on network failure — no API key, no host', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED api.search.brave.com:443 (key=secret-brave-key)'); };
  const client = createBraveSearch({ apiKey: 'secret-brave-key', fetchImpl });
  await assert.rejects(() => client.search('x'), (err) => {
    assert.match(err.message, /web search unreachable/);
    assert.ok(!err.message.includes('secret-brave-key'));
    assert.ok(!err.message.includes('brave.com'));
    return true;
  });
});

test('search() throws a calm, generic error on a non-200 response (e.g. invalid key)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  const client = createBraveSearch({ apiKey: 'bad-key', fetchImpl });
  await assert.rejects(() => client.search('x'), (err) => {
    assert.match(err.message, /web search responded with an error/);
    assert.ok(!err.message.includes('401'));
    return true;
  });
});

test('search() throws a calm error on an unreadable (non-JSON) response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  const client = createBraveSearch({ apiKey: 'test-key', fetchImpl });
  await assert.rejects(() => client.search('x'), /web search returned an unreadable response/);
});

// --- Architectural invariant: no cognitive dependencies ---------------------

test('braveSearch.js has no code-level dependency on Hermes, the native generator, IntentIQ/ReasonIQ, the Decision Engine, the Orchestrator, or the Response Engine', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/tools/braveSearch.js'), 'utf-8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const forbidden = [
    'hermesClient', 'gaiaGenerator', 'intentIQ', 'reasonIQ',
    'decisionEngine', 'orchestrator', 'responseEngine',
  ];
  for (const name of forbidden) {
    assert.ok(!codeOnly.includes(name), `braveSearch.js must not reference ${name}`);
  }
});
