'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHindsightClient } = require('../src/hindsightClient');

test('createKnowledgeFolder: posts to /knowledge-base/folders and maps the response', async () => {
  let captured;
  const client = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ id: 'kf-1', kind: 'folder', name: 'User', parent_id: null }) };
    },
  });
  const folder = await client.createKnowledgeFolder({ name: 'User' });
  assert.ok(captured.url.endsWith('/knowledge-base/folders'));
  assert.equal(JSON.parse(captured.init.body).name, 'User');
  assert.deepEqual(folder, { id: 'kf-1', kind: 'folder', name: 'User', parentId: null });
});

test('createKnowledgePage: posts source_query and maps page_id/mental_model_id', async () => {
  let captured;
  const client = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ page_id: 'kp-1', mental_model_id: 'mm-1', operation_id: 'op-1' }) };
    },
  });
  const page = await client.createKnowledgePage({ name: 'About', sourceQuery: 'Who is Bojan?', parentId: 'kf-1' });
  assert.ok(captured.url.endsWith('/knowledge-base/pages'));
  const body = JSON.parse(captured.init.body);
  assert.equal(body.name, 'About');
  assert.equal(body.source_query, 'Who is Bojan?');
  assert.equal(body.parent_id, 'kf-1');
  assert.deepEqual(page, { pageId: 'kp-1', mentalModelId: 'mm-1', operationId: 'op-1' });
});

test('getKnowledgePage: returns null on failure, mapped object on success', async () => {
  const unreachable = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan', fetchImpl: async () => { throw new Error('down'); },
  });
  assert.equal(await unreachable.getKnowledgePage('kp-1'), null);

  const notFound = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan', fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(await notFound.getKnowledgePage('kp-1'), null);

  const ok = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: 'kp-1', name: 'About', type: 'knowledge-page', description: 'Who is Bojan?',
        tags: [], timestamp: '2026-08-01T00:00:00Z', body: 'Bojan works on Gaia.', markdown: '---\n---\nBojan works on Gaia.',
      }),
    }),
  });
  const page = await ok.getKnowledgePage('kp-1');
  assert.equal(page.id, 'kp-1');
  assert.equal(page.body, 'Bojan works on Gaia.');
  assert.equal(page.description, 'Who is Bojan?');
});

test('getKnowledgePage: treats the "Generating content..." placeholder as not-ready (null)', async () => {
  const generating = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ id: 'kp-1', name: 'About', type: 'knowledge-page', body: 'Generating content...', markdown: '' }),
    }),
  });
  assert.equal(await generating.getKnowledgePage('kp-1'), null);
});

test('searchKnowledgeBase: builds query params and maps results', async () => {
  let captured;
  const client = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan',
    fetchImpl: async (url) => {
      captured = url;
      return {
        ok: true,
        json: async () => ({
          results: [{ id: 'kp-1', name: 'About', mental_model_id: 'mm-1', snippet: 'Bojan...', score: 0.9, updated_at: null }],
          total: 1,
        }),
      };
    },
  });
  const results = await client.searchKnowledgeBase('who is Bojan', { limit: 5 });
  assert.ok(captured.includes('/knowledge-base/search?'));
  assert.ok(captured.includes('q=who'));
  assert.ok(captured.includes('limit=5'));
  assert.equal(results.length, 1);
  assert.equal(results[0].mentalModelId, 'mm-1');
});

test('searchKnowledgeBase: throws on non-ok response (recall parity, caller must gate)', async () => {
  const client = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan', fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(() => client.searchKnowledgeBase('anything'));
});

test('getKnowledgeTree: maps nested folder/page tree with camelCase fields', async () => {
  const client = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        roots: [
          {
            id: 'kf-1', kind: 'folder', name: 'User', parent_id: null, managed: false, tags: [], children: [
              { id: 'kp-1', kind: 'page', name: 'About', parent_id: 'kf-1', mental_model_id: 'mm-1', managed: false, description: 'q', tags: [], timestamp: null, is_stale: false, children: [] },
            ],
          },
        ],
      }),
    }),
  });
  const roots = await client.getKnowledgeTree();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].name, 'User');
  assert.equal(roots[0].children.length, 1);
  assert.equal(roots[0].children[0].mentalModelId, 'mm-1');
  assert.equal(roots[0].children[0].isStale, false);
});

test('updateKnowledgeNode: only sends provided fields', async () => {
  let captured;
  const client = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true };
    },
  });
  await client.updateKnowledgeNode('kp-1', { name: 'New Name' });
  assert.equal(captured.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(captured.init.body), { name: 'New Name' });
  assert.ok(captured.url.endsWith('/knowledge-base/nodes/kp-1'));
});

test('deleteKnowledgeNode: DELETEs the node and returns true', async () => {
  let captured;
  const client = createHindsightClient({
    baseUrl: 'http://x', bankId: 'bojan',
    fetchImpl: async (url, init) => { captured = { url, init }; return { ok: true }; },
  });
  const result = await client.deleteKnowledgeNode('kf-1');
  assert.equal(result, true);
  assert.equal(captured.init.method, 'DELETE');
});
