'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createKairosRouter } = require('../src/kairosRoutes');
const { emitEpisode, emitDigest } = require('../src/kairos/emitter');
const { parseTokens, createAuthMiddleware } = require('../src/auth');

function startTestServer({ cognition, foundation, digestWriter } = {}) {
  const auth = createAuthMiddleware(parseTokens('test-token'));
  const app = express();
  app.use(express.json());
  app.use('/kairos', createKairosRouter({ cognition, foundation, auth, digestWriter }));
  const server = app.listen(0);
  const port = server.address().port;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const authHeaders = () => ({ Authorization: 'Bearer test-token' });

function fakeCognition(overrides = {}) {
  return {
    listKairosEpisodes: async () => ({
      data: [{ id: 'kei_1', summary: 's', epistemic_status: 'interpretation' }],
      pagination: { page: 1, limit: 20, total_records: 1, has_more: false },
    }),
    getKairosEpisode: async (id) => ({ id, sources: ['foundation:obs1'], epistemic_status: 'interpretation' }),
    listKairosDigests: async () => ([
      { digest_date: '2026-11-06', summary: 'Je werkte aan Gaia.', episode_count: 2 },
    ]),
    getKairosDigest: async (date) => ({ digest_date: date, summary: 'Je werkte aan Gaia.', episode_count: 2 }),
    ...overrides,
  };
}

test('GET /kairos/episodes requires auth', async () => {
  const ctx = startTestServer({ cognition: fakeCognition() });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/episodes`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /kairos/episodes returns the paged payload from Cognition', async () => {
  const ctx = startTestServer({ cognition: fakeCognition() });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/episodes`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data[0].epistemic_status, 'interpretation');
    assert.equal(body.pagination.has_more, false);
  } finally {
    await ctx.close();
  }
});

test('GET /kairos/episodes maps a Cognition 404 to a bank-not-found 404', async () => {
  const cognition = fakeCognition({
    listKairosEpisodes: async () => { const e = new Error('x'); e.status = 404; throw e; },
  });
  const ctx = startTestServer({ cognition });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/episodes`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('GET /kairos/episodes/:id/evidence walks sources back to Foundation raw records', async () => {
  const foundation = {
    fetchIngestObjects: async (ids) => ids.map((id) => ({ id, content: 'raw text' })),
  };
  const ctx = startTestServer({ cognition: fakeCognition(), foundation });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/episodes/kei_1/evidence`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.episode.id, 'kei_1');
    assert.deepEqual(body.observations.map((o) => o.id), ['obs1'], 'the foundation: prefix is stripped, leaving the bare ingest_object id Foundation knows');
  } finally {
    await ctx.close();
  }
});

test('GET /kairos/episodes/:id/evidence still resolves a legacy chronicle: source (migration window)', async () => {
  const seen = [];
  const foundation = {
    fetchIngestObjects: async (ids) => { seen.push(...ids); return ids.map((id) => ({ id, content: 'raw text' })); },
  };
  const cognition = fakeCognition({
    getKairosEpisode: async (id) => ({ id, sources: ['chronicle:ingest:obs9'], epistemic_status: 'interpretation' }),
  });
  const ctx = startTestServer({ cognition, foundation });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/episodes/kei_1/evidence`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(seen, ['obs9'], 'Foundation gets the bare uuid, never the ingest: prefix');
    assert.deepEqual(body.observations.map((o) => o.id), ['obs9']);
  } finally {
    await ctx.close();
  }
});

test('GET /kairos/episodes/:id/evidence 503s when no Foundation source is wired', async () => {
  const ctx = startTestServer({ cognition: fakeCognition() });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/episodes/kei_1/evidence`, { headers: authHeaders() });
    assert.equal(res.status, 503);
  } finally {
    await ctx.close();
  }
});

test('GET /kairos/episodes/stream relays emitted episodes as SSE and cleans up on close', async () => {
  const ctx = startTestServer({ cognition: fakeCognition() });
  try {
    const controller = new AbortController();
    const res = await fetch(`${ctx.baseUrl}/kairos/episodes/stream`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // Read the initial ':ok' so the connection is established.
    await reader.read();

    const episode = { id: 'kei_live', epistemic_status: 'interpretation', summary: 'live' };
    emitEpisode(episode);

    const { value } = await reader.read();
    const chunk = decoder.decode(value);
    assert.match(chunk, /event: episode/);
    assert.match(chunk, /kei_live/);

    controller.abort();
  } finally {
    await ctx.close();
  }
});

test('GET /kairos/digests returns the stored day overviews', async () => {
  const ctx = startTestServer({ cognition: fakeCognition() });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/digests`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data[0].digest_date, '2026-11-06');
  } finally {
    await ctx.close();
  }
});

test('GET /kairos/digest defaults to the latest and 404s when there is none', async () => {
  const ctx = startTestServer({ cognition: fakeCognition() });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/digest`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.digest_date, '2026-11-06');
  } finally {
    await ctx.close();
  }

  const empty = startTestServer({ cognition: fakeCognition({ listKairosDigests: async () => [] }) });
  try {
    const res = await fetch(`${empty.baseUrl}/kairos/digest`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    await empty.close();
  }
});

test('GET /kairos/digest rejects a date that is not a calendar day', async () => {
  const ctx = startTestServer({ cognition: fakeCognition() });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/digest?date=2026-02-31`, { headers: authHeaders() });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('POST /kairos/digest asks the writer for that day and returns the stored row', async () => {
  const calls = [];
  const digestWriter = {
    generate: async (opts) => {
      calls.push(opts);
      return { digest: { digest_date: opts.date, summary: 'Je werkte aan Gaia.', episode_count: 3 } };
    },
  };
  const ctx = startTestServer({ cognition: fakeCognition(), digestWriter });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/digest`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-11-05' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.digest_date, '2026-11-05');
    assert.deepEqual(calls, [{ date: '2026-11-05', force: false }]);
  } finally {
    await ctx.close();
  }
});

test('POST /kairos/digest reports a too-thin day as 422 with the count', async () => {
  const digestWriter = { generate: async () => ({ skipped: 'too-few-episodes', date: '2026-11-10', episodeCount: 3 }) };
  const ctx = startTestServer({ cognition: fakeCognition(), digestWriter });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/digest`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-11-10' }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.date, '2026-11-10');
    assert.equal(body.episodeCount, 3);
  } finally {
    await ctx.close();
  }
});

test('POST /kairos/digest reports an empty day as 404, not as a written overview', async () => {
  const digestWriter = { generate: async () => ({ skipped: 'no-episodes', date: '2026-11-09', episodeCount: 0 }) };
  const ctx = startTestServer({ cognition: fakeCognition(), digestWriter });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/digest`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-11-09' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('POST /kairos/digest is unavailable when no writer is wired', async () => {
  const ctx = startTestServer({ cognition: fakeCognition() });
  try {
    const res = await fetch(`${ctx.baseUrl}/kairos/digest`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-11-09' }),
    });
    assert.equal(res.status, 503);
  } finally {
    await ctx.close();
  }
});

test('the SSE stream relays a written digest as its own event', async () => {
  const ctx = startTestServer({ cognition: fakeCognition() });
  try {
    const controller = new AbortController();
    const res = await fetch(`${ctx.baseUrl}/kairos/episodes/stream`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ':ok'

    emitDigest({ digest_date: '2026-11-06', summary: 'Je werkte aan Gaia.' });
    const { value } = await reader.read();
    const chunk = decoder.decode(value);
    assert.match(chunk, /event: digest/);
    assert.match(chunk, /2026-11-06/);

    controller.abort();
  } finally {
    await ctx.close();
  }
});
