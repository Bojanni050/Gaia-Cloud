'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHindsightClient } = require('../src/hindsightClient');
const { createHindsightPatternAdapter, PATTERN_TAG } = require('../src/reasoning/hindsightPatternAdapter');

function makeFake() {
  const facts = new Map();
  let n = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === 'POST' && u.pathname.endsWith('/memories')) {
      for (const item of body.items) {
        n += 1;
        facts.set(`ptf_${n}`, {
          id: `ptf_${n}`, text: item.content, type: 'world', state: 'valid',
          context: item.context || null, metadata: item.metadata || null,
          tags: item.tags || [], document_id: item.document_id || null,
        });
      }
      return { ok: true, json: async () => ({ success: true }) };
    }
    if (method === 'GET' && u.pathname.endsWith('/memories/list')) {
      const q = u.searchParams;
      let items = [...facts.values()];
      if (q.get('state')) items = items.filter((f) => f.state === q.get('state'));
      if (q.get('type')) items = items.filter((f) => f.type === q.get('type'));
      if (q.get('document_id')) items = items.filter((f) => f.document_id === q.get('document_id'));
      if (q.get('q')) {
        const needle = q.get('q').toLowerCase();
        items = items.filter((f) => `${f.text || ''} ${f.context || ''}`.toLowerCase().includes(needle));
      }
      return { ok: true, json: async () => ({ items: items.map((f) => ({ ...f })) }) };
    }
    if (method === 'PATCH' && u.pathname.includes('/memories/')) {
      const id = decodeURIComponent(u.pathname.split('/memories/')[1]);
      const f = facts.get(id);
      if (!f) return { ok: false, status: 404, json: async () => ({}) };
      if (body.state) f.state = body.state;
      if (body.reason !== undefined) f.patch_reason = body.reason;
      return { ok: true, json: async () => ({ ...f }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = createHindsightClient({ baseUrl: 'http://hs.test', bankId: 'bojan', fetchImpl });
  return { client, facts };
}

const PATTERN = () => ({
  id: 'pattern-1',
  statement: 'Technische doorbraken hangen samen met langere creatieve werkfasen.',
  status: 'supported',
  confidence: 0.71,
  hypothesisIds: ['hyp-a', 'hyp-b', 'hyp-c'],
});

test('pattern persistence: save retains a gaia:pattern world-fact with gaia_pattern_* metadata', async () => {
  const { client, facts } = makeFake();
  const adapter = createHindsightPatternAdapter({ client });
  await adapter.sink.save(PATTERN());
  await drain();

  const unit = [...facts.values()][0];
  assert.equal(unit.tags[0], PATTERN_TAG);
  assert.equal(unit.context, 'gaia pattern');
  assert.equal(unit.document_id, 'gaia-ptn-pattern-1-v1');
  assert.equal(unit.metadata.gaia_pattern_id, 'pattern-1');
  assert.equal(unit.metadata.gaia_pattern_version, '1');
  assert.equal(unit.metadata.gaia_pattern_status, 'supported');
  assert.equal(unit.metadata.gaia_pattern_confidence, '0.71');
  assert.deepEqual(JSON.parse(unit.metadata.gaia_pattern_hypotheses), ['hyp-a', 'hyp-b', 'hyp-c']);
  assert.equal(unit.metadata.gaia_pattern_persistence, 'durable');
});

test('pattern persistence: update creates v2 and natively supersedes v1', async () => {
  const { client, facts } = makeFake();
  const adapter = createHindsightPatternAdapter({ client });
  await adapter.sink.save({ ...PATTERN(), status: 'candidate', confidence: 0.6 });
  await adapter.sink.update('pattern-1', PATTERN());
  await drain();

  const versions = [...facts.values()];
  assert.equal(versions.length, 2);
  const superseded = versions.find((v) => v.document_id.endsWith('-v1'));
  const active = versions.find((v) => v.document_id.endsWith('-v2'));
  assert.equal(superseded.state, 'invalidated');
  assert.match(superseded.patch_reason, /superseded by gaia-ptn-pattern-1-v2/);
  assert.equal(active.state, 'valid');
  assert.equal(active.metadata.gaia_pattern_status, 'supported');
});

test('pattern persistence: loadActivePatterns reconstructs the highest active version', async () => {
  const { client, facts } = makeFake();
  const adapter = createHindsightPatternAdapter({ client });
  await adapter.sink.save({ ...PATTERN(), status: 'candidate', confidence: 0.6 });
  await adapter.sink.update('pattern-1', PATTERN());

  const loaded = await adapter.loadActivePatterns();
  assert.equal(loaded.length, 1);
  const p = loaded[0];
  assert.equal(p.id, 'pattern-1');
  assert.equal(p.status, 'supported'); // from metadata, never from relevance
  assert.equal(p.confidence, 0.71);
  assert.deepEqual(p.hypothesisIds, ['hyp-a', 'hyp-b', 'hyp-c']);
  assert.equal(p.persistence, 'durable');
  assert.equal(p.sourceRef.startsWith('ptf_'), true);
});

async function drain() { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); }
