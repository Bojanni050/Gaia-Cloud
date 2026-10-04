'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createKairosRouter } = require('../src/kairosRoutes');
const { emitEpisode } = require('../src/kairos/emitter');
const { parseTokens, createAuthMiddleware } = require('../src/auth');

function startTestServer({ cognition, foundation } = {}) {
  const auth = createAuthMiddleware(parseTokens('test-token'));
  const app = express();
  app.use(express.json());
  app.use('/kairos', createKairosRouter({ cognition, foundation, auth }));
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
    getKairosEpisode: async (id) => ({ id, sources: ['chronicle:ingest:obs1'], epistemic_status: 'interpretation' }),
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
    assert.deepEqual(body.observations.map((o) => o.id), ['ingest:obs1'], 'the chronicle: namespace is stripped, leaving the ingest_object id Foundation knows');
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
