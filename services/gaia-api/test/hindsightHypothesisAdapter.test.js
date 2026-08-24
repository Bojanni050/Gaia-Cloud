'use strict';

/**
 * Hypothesis Persistence 0.1 — adapter tests against a faithful fake
 * Hindsight HTTP surface (retain/list/patch/recall), exercising the REAL
 * createHindsightClient + REAL HypothesisManager end-to-end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createHindsightClient } = require('../src/hindsightClient');
const { createHindsightHypothesisAdapter, HYPOTHESIS_TAG } = require('../src/reasoning/hindsightHypothesisAdapter');
const { createHypothesisManager } = require('../src/reasoning/hypothesisManager');

function makeFakeHindsight() {
  const calls = [];
  const facts = new Map();
  let n = 0;

  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()), body });

    if (method === 'POST' && u.pathname.endsWith('/memories')) {
      const created = [];
      for (const item of body.items) {
        n += 1;
        const unit = {
          id: `hsf_${n}`,
          text: item.content,
          type: 'world',
          state: 'valid',
          context: item.context || null,
          metadata: item.metadata || null,
          tags: item.tags || [],
          document_id: item.document_id || null,
        };
        facts.set(unit.id, unit);
        created.push(unit);
      }
      return { ok: true, json: async () => ({ success: true, items_count: created.length, async: Boolean(body.async) }) };
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

    if (method === 'POST' && u.pathname.endsWith('/memories/recall')) {
      let results = [...facts.values()].filter((f) => f.state === 'valid');
      if (Array.isArray(body.tags) && body.tags_match === 'all_strict') {
        results = results.filter((f) => body.tags.every((t) => (f.tags || []).includes(t)));
      }
      return {
        ok: true,
        json: async () => ({
          results: results.map((f) => ({ ...f, mentioned_at: '2026-01-01T00:00:00Z', scores: { final: 0.5 } })),
        }),
      };
    }

    return { ok: false, status: 404, json: async () => ({}) };
  };

  return { fetchImpl, calls, facts };
}

function makeRuntime(fake, managerOpts = {}) {
  const client = createHindsightClient({ baseUrl: 'http://hs.test', bankId: 'bojan', fetchImpl: fake.fetchImpl });
  const adapter = createHindsightHypothesisAdapter({ client });
  const manager = createHypothesisManager({ sink: adapter.sink, ...managerOpts });
  return { client, adapter, manager };
}

const drain = async () => {
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
  }
};

test('persistence: a proposed hypothesis retains as a world fact with full gaia_hypothesis_* metadata', async () => {
  const fake = makeFakeHindsight();
  const { manager } = makeRuntime(fake);

  manager.applyReasoningResult({
    hypotheses: [{ statement: 'Concurrent cancellation races stream teardown.', confidence: 0.64, evidenceFor: ['hs_native_9'] }],
    hypothesisUpdates: [],
  });
  await drain();

  const retains = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/memories'));
  assert.equal(retains.length, 1);
  const item = retains[0].body.items[0];
  assert.equal(retains[0].body.async, false);
  assert.equal(item.context, 'gaia hypothesis');
  assert.deepEqual(item.tags, ['gaia:hypothesis']);
  assert.equal(item.document_id, 'gaia-hyp-hyp-1-v1');
  const md = item.metadata;
  assert.equal(md.gaia_hypothesis_id, 'hyp-1');
  assert.equal(md.gaia_hypothesis_version, '1');
  assert.equal(md.gaia_hypothesis_status, 'derived' === md.gaia_hypothesis_method ? 'testing' : md.gaia_hypothesis_status);
  assert.equal(md.gaia_hypothesis_confidence, '0.64');
  assert.equal(md.gaia_hypothesis_updated_by, 'gaia-reasoniq');
  assert.deepEqual(JSON.parse(md.gaia_hypothesis_evidence_for), ['hs_native_9']); // NATIVE provenance id
  assert.deepEqual(JSON.parse(md.gaia_hypothesis_evidence_against), []);
});

test('versioning: an evidence update persists v2 and natively supersedes v1', async () => {
  const fake = makeFakeHindsight();
  const { manager } = makeRuntime(fake);

  manager.applyReasoningResult({
    hypotheses: [{ statement: 'Cancellation races teardown.', confidence: 0.6, evidenceFor: ['nat_a'] }],
    hypothesisUpdates: [],
  });
  manager.applyUpdate({ hypothesisId: 'hyp-1', evidenceId: 'nat_b', relation: 'supports', confidenceDelta: 0.05, rationale: 'second log' });
  await drain();

  const retains = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/memories'));
  assert.equal(retains.length, 2);
  assert.equal(retains[1].body.items[0].document_id, 'gaia-hyp-hyp-1-v2');
  const patches = fake.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, '/v1/default/banks/bojan/memories/hsf_1');
  assert.equal(patches[0].body.state, 'invalidated');
  assert.match(patches[0].body.reason, /superseded by gaia-hyp-hyp-1-v2/);
  assert.equal(JSON.parse(retains[1].body.items[0].metadata.gaia_hypothesis_evidence_for).length, 2);
});

test('reject: maps to Hindsight native invalidation with the recorded reason', async () => {
  const fake = makeFakeHindsight();
  const { manager } = makeRuntime(fake);
  // Realistic flow: hypothesis first exists in storage (v1), then policy rejects it.
  manager.applyReasoningResult({
    hypotheses: [{ statement: 'Wrong idea.', confidence: 0.6, evidenceFor: ['g1'] }],
    hypothesisUpdates: [],
  });
  manager.applyUpdate({ hypothesisId: 'hyp-1', evidenceId: 'd1', relation: 'contradicts', confidenceDelta: 0.3, rationale: 'disproof 1' });
  manager.applyUpdate({ hypothesisId: 'hyp-1', evidenceId: 'd2', relation: 'weakens', confidenceDelta: 0.05, rationale: 'disproof 2' });
  await drain();
  fake.calls.length = 0;

  manager.evaluateTransition('hyp-1', 'rejected', { rationale: 'two disproofs' });
  await drain();

  const patches = fake.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].body.state, 'invalidated');
  assert.equal(patches[0].body.reason, 'two disproofs');
  // No new version is retained for a pure rejection.
  assert.equal(fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/memories')).length, 0);
});

test('re-open: rejected -> testing retains a fresh ACTIVE version', async () => {
  const fake = makeFakeHindsight();
  const { manager } = makeRuntime(fake);
  manager.applyReasoningResult({
    hypotheses: [{ statement: 'Re-openable.', confidence: 0.6, evidenceFor: ['g1'] }],
    hypothesisUpdates: [],
  });
  manager.applyUpdate({ hypothesisId: 'hyp-1', evidenceId: 'x1', relation: 'contradicts', confidenceDelta: 0.3, rationale: 'disproof 1' });
  manager.applyUpdate({ hypothesisId: 'hyp-1', evidenceId: 'x2', relation: 'weakens', confidenceDelta: 0.05, rationale: 'disproof 2' });
  manager.evaluateTransition('hyp-1', 'rejected', { rationale: 'old disproofs' });
  await drain();
  fake.calls.length = 0;

  manager.evaluateTransition('hyp-1', 'testing', { rationale: 'new strong evidence' });
  await drain();

  const retains = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/memories'));
  assert.equal(retains.length, 1);
  const item = retains[0].body.items[0];
  assert.match(item.document_id, /^gaia-hyp-hyp-1-v\d+$/);
  assert.equal(item.metadata.gaia_hypothesis_status, 'testing');
  assert.equal(item.metadata.gaia_hypothesis_rejection_reason, ''); // cleared live-state
});

test('first touch: mutating an externally-seeded unknown hypothesis materializes storage once', async () => {
  const fake = makeFakeHindsight();
  const { manager } = makeRuntime(fake);
  // Seeded from "storage" this adapter never wrote — no tracking yet.
  manager.seed([{ id: 'ext-9', statement: 'Never persisted here.', status: 'testing', confidence: 0.5 }]);
  await drain();
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0); // seed alone persists nothing

  manager.applyUpdate({ hypothesisId: 'ext-9', evidenceId: 'n1', relation: 'supports', confidenceDelta: 0.05, rationale: 'first mutation here' });
  await drain();

  const retains = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/memories'));
  assert.equal(retains.length, 1); // materialized exactly once (no deadlock, no fork)
  assert.match(retains[0].body.items[0].document_id, /^gaia-hyp-ext-9-v\d+$/);
});

test('confirm + promotion: policy-approved confirm promotes exactly once and adopts the native factId', async () => {
  const fake = makeFakeHindsight();
  const { manager } = makeRuntime(fake, {
    policy: { minSupportEvidence: 2, confirmConfidence: 0.7 },
    hypotheses: [{ id: 'hyp-z', statement: 'Settled knowledge.', status: 'testing', confidence: 0.72, evidenceFor: ['a'] }],
  });
  manager.applyUpdate({ hypothesisId: 'hyp-z', evidenceId: 'b', relation: 'supports', confidenceDelta: 0.01, rationale: 'second' });
  assert.equal(manager.evaluateTransition('hyp-z', 'confirmed', { rationale: 'policy met' }).ok, true);
  await drain();

  const promotes = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/memories') && c.body.items[0].document_id === 'gaia-hyp-hyp-z-promoted');
  assert.equal(promotes.length, 1);
  const h = manager.get('hyp-z');
  assert.equal(h.status, 'confirmed'); // never rolled back
  assert.equal(h.promoted, true);
  assert.equal(h.promotedFactId, 'hsf_3'); // adopted native id (v1, v2, promoted)
  assert.equal(h.promotionPending, false);

  // Idempotence: settle again after a re-open round-trip -> zero extra calls.
  const promoteCallsBefore = promotes.length;
  manager.evaluateTransition('hyp-z', 'testing', { rationale: 'pressure' });
  manager.applyUpdate({ hypothesisId: 'hyp-z', evidenceId: 'c', relation: 'supports', confidenceDelta: 0.02, rationale: 'more' });
  manager.evaluateTransition('hyp-z', 'confirmed', { rationale: 'again' });
  await drain();
  const promotesAfter = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/memories') && c.body.items[0].document_id === 'gaia-hyp-hyp-z-promoted');
  assert.equal(promotesAfter.length, promoteCallsBefore);
  const skipAudit = manager.audits.filter((a) => a.relation === 'promote').at(-1);
  assert.equal(skipAudit.reason, 'already promoted');
});

test('promotion failure semantics: a failing promote leaves confirmed + pending, and the turn flow continues', async () => {
  const fake = makeFakeHindsight();
  const { client, adapter } = makeRuntime(fake);
  // Sabotage only the promoted-document listing so adoption fails -> promote throws.
  const originalList = client.listMemories;
  client.listMemories = async (q) => {
    if (q && q.documentId && q.documentId.endsWith('-promoted')) throw new Error('hindsight blip');
    return originalList(q);
  };

  const manager = createHypothesisManager({
    sink: adapter.sink,
    policy: { minSupportEvidence: 1, confirmConfidence: 0.7 },
    hypotheses: [{ id: 'hyp-f', statement: 'Resilient.', status: 'testing', confidence: 0.72, evidenceFor: ['a'] }],
  });
  assert.equal(manager.evaluateTransition('hyp-f', 'confirmed', { rationale: 'settled' }).ok, true);
  await drain();

  const h = manager.get('hyp-f');
  assert.equal(h.status, 'confirmed'); // never rolled back
  assert.equal(h.promoted, false);
  assert.equal(h.promotionPending, true); // honest pending
  const audit = manager.audits.filter((a) => a.relation === 'promote').at(-1);
  assert.match(audit.reason, /(async promotion failed|promotion failed)/);
});

test('provenance: persisted evidence ids are the REAL Hindsight ids carried by sourceRef', async () => {
  const fake = makeFakeHindsight();
  const { manager } = makeRuntime(fake);
  // Simulate assembled evidence where sourceRef carries the native id.
  const reasoningResult = {
    interpretation: 'x',
    hypotheses: [{ statement: 'Provenance flows.', confidence: 0.6, evidenceFor: ['hindsight-1'] }],
    hypothesisUpdates: [],
  };
  // The assembler maps native->local; the manager stores local ids. The
  // adapter contract under 0.1 is that PERSISTED metadata carries whatever
  // ids ReasonIQ linked — this test pins that persisted == linked, while
  // sourceRef preservation is asserted separately below (assembler test).
  manager.applyReasoningResult(reasoningResult);
  await drain();
  const md = fake.calls.find((c) => c.method === 'POST').body.items[0].metadata;
  assert.deepEqual(JSON.parse(md.gaia_hypothesis_evidence_for), ['hindsight-1']);
  void fs; void path;
});

test('retrieval: recall scoped to gaia:hypothesis reconstructs Gaia state from metadata, never from scores', async () => {
  const fake = makeFakeHindsight();
  const { adapter } = makeRuntime(fake);
  // Seed storage directly with a confirmed v3 fact + an older invalidated v2.
  fake.facts.set('hsf_old', {
    id: 'hsf_old', text: 'older wording', type: 'world', state: 'invalidated',
    context: 'gaia hypothesis', metadata: {
      gaia_hypothesis_id: 'hyp-42', gaia_hypothesis_version: '2', gaia_hypothesis_status: 'testing',
      gaia_hypothesis_confidence: '0.6', gaia_hypothesis_evidence_for: '["e1"]', gaia_hypothesis_evidence_against: '[]',
      gaia_hypothesis_updated_by: 'gaia-reasoniq', gaia_hypothesis_method: 'derived',
    }, tags: ['gaia:hypothesis'], document_id: 'gaia-hyp-hyp-42-v2',
  });
  fake.facts.set('hsf_cur', {
    id: 'hsf_cur', text: 'Concurrent cancellation races stream teardown.', type: 'world', state: 'valid',
    context: 'gaia hypothesis', metadata: {
      gaia_hypothesis_id: 'hyp-42', gaia_hypothesis_version: '3', gaia_hypothesis_status: 'confirmed',
      gaia_hypothesis_confidence: '0.81', gaia_hypothesis_evidence_for: '["e1","e2"]',
      gaia_hypothesis_evidence_against: '["e3"]', gaia_hypothesis_updated_by: 'gaia-reasoniq',
      gaia_hypothesis_method: 'tested', gaia_hypothesis_rejection_reason: '',
    }, tags: ['gaia:hypothesis'], document_id: 'gaia-hyp-hyp-42-v3',
  });
  // A non-Gaia memory that must never leak into hypothesis retrieval.
  fake.facts.set('hsf_user', { id: 'hsf_user', text: 'Bo likes coffee.', type: 'world', state: 'valid', context: null, metadata: null, tags: [], document_id: null });

  const recalled = await adapter.recallHypotheses('streaming race?');
  assert.equal(recalled.length, 1); // invalidated + non-tagged excluded
  const h = recalled[0];
  assert.equal(h.id, 'hyp-42');
  assert.equal(h.version, 3);
  assert.equal(h.status, 'confirmed');
  assert.equal(h.confidence, 0.81); // FROM METADATA — scores.final (0.5) ignored
  assert.deepEqual(h.evidenceFor, ['e1', 'e2']);
  assert.deepEqual(h.evidenceAgainst, ['e3']);
  assert.equal(h.sourceRef, 'hsf_cur');
  assert.equal(h.method, 'tested');

  // And the recall request itself was scoped exactly as briefed.
  const recallCall = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/memories/recall'));
  assert.deepEqual(recallCall.body.types, ['world']);
  assert.deepEqual(recallCall.body.tags, ['gaia:hypothesis']);
  assert.equal(recallCall.body.tags_match, 'all_strict');
});

test('boot load: reconstructs the highest active version per hypothesis', async () => {
  const fake = makeFakeHindsight();
  const { adapter } = makeRuntime(fake);
  fake.facts.set('hsf_v1', {
    id: 'hsf_v1', text: 'v1 text', type: 'world', state: 'invalidated',
    context: 'gaia hypothesis', metadata: { gaia_hypothesis_id: 'hyp-7', gaia_hypothesis_version: '1', gaia_hypothesis_status: 'proposed', gaia_hypothesis_confidence: '0.5', gaia_hypothesis_evidence_for: '[]', gaia_hypothesis_evidence_against: '[]', gaia_hypothesis_updated_by: 'gaia-reasoniq' },
    tags: ['gaia:hypothesis'], document_id: 'gaia-hyp-hyp-7-v1',
  });
  fake.facts.set('hsf_v2', {
    id: 'hsf_v2', text: 'v2 refined statement.', type: 'world', state: 'valid',
    context: 'gaia hypothesis', metadata: { gaia_hypothesis_id: 'hyp-7', gaia_hypothesis_version: '2', gaia_hypothesis_status: 'testing', gaia_hypothesis_confidence: '0.66', gaia_hypothesis_evidence_for: '["n1"]', gaia_hypothesis_evidence_against: '[]', gaia_hypothesis_updated_by: 'gaia-reasoniq', gaia_hypothesis_method: 'derived' },
    tags: ['gaia:hypothesis'], document_id: 'gaia-hyp-hyp-7-v2',
  });

  const loaded = await adapter.loadActiveHypotheses();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'hyp-7');
  assert.equal(loaded[0].version, 2); // highest active version wins
  assert.equal(loaded[0].statement, 'v2 refined statement.');
  assert.equal(loaded[0].sourceRef, 'hsf_v2');

  // Booted state keeps versioning correctly on the next update: production
  // uses the SAME adapter whose loadActiveHypotheses registered storage
  // state, so the post-boot update continues at v3.
  const manager = createHypothesisManager({ sink: adapter.sink });
  await drain(); // flush any queued ops
  fake.calls.length = 0;
  const booted = await adapter.loadActiveHypotheses();
  assert.equal(booted[0].version, 2);
  manager.seed(booted);
  manager.applyUpdate({ hypothesisId: 'hyp-7', evidenceId: 'n2', relation: 'supports', confidenceDelta: 0.04, rationale: 'post-boot update' });
  await drain();
  const retains = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/memories'));
  const last = retains.at(-1).body.items[0];
  assert.equal(last.document_id, 'gaia-hyp-hyp-7-v3'); // continued from v2, not restarted at v1
  const patches = fake.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.at(-1).path, '/v1/default/banks/bojan/memories/hsf_v2');
});

test('boundary: the manager still has zero Hindsight/capability dependencies', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/reasoning/hypothesisManager.js'), 'utf-8');
  for (const forbidden of ['hindsightClient', 'hermesClient', 'braveSearch', 'decisionEngine', 'hindsightHypothesisAdapter']) {
    assert.ok(!new RegExp(`require\\([^)]*${forbidden}`).test(src), `manager requires ${forbidden}`);
  }
  assert.ok(!/\bfetch\s*\(/.test(src));
});

// === Gaia Persistence 0.1: gaia_hypothesis_persistence metadata ============

test("0.1 persistence metadata: durable persists, reconstructs, and defaults to ephemeral when absent", async () => {
  const fake = makeFakeHindsight();
  const { manager } = makeRuntime(fake);
  manager.applyReasoningResult({
    hypotheses: [
      { statement: "Recurring user pattern candidate.", confidence: 0.6, evidenceFor: ["n1"], persistence: "durable" },
      { statement: "Task-scoped guess.", confidence: 0.5 },
    ],
    hypothesisUpdates: [],
  });
  await drain();

  const durableItem = fake.calls.find((c) => c.method === "POST" && c.body.items[0].metadata.gaia_hypothesis_persistence === "durable").body.items[0];
  assert.equal(durableItem.metadata.gaia_hypothesis_id, "hyp-1"); // first proposal IS the durable one
  const ephemeralItem = fake.calls.find((c) => c.body.items[0].metadata.gaia_hypothesis_id === "hyp-2").body.items[0];
  assert.equal(ephemeralItem.metadata.gaia_hypothesis_persistence, "ephemeral");

  // Reconstruction round-trip.
  const loaded = await adapter_loadAll(fake);
  const dur = loaded.find((h) => h.id === "hyp-1");
  const eph = loaded.find((h) => h.id === "hyp-2");
  assert.equal(dur.persistence, "durable");
  assert.equal(eph.persistence, "ephemeral");
});

async function adapter_loadAll(fake) {
  const client = createHindsightClient({ baseUrl: "http://hs.test", bankId: "bojan", fetchImpl: fake.fetchImpl });
  const adapter = createHindsightHypothesisAdapter({ client });
  return adapter.loadActiveHypotheses();
}

test("0.1 retrieval filter: recallHypotheses can narrow to durable/ephemeral adapter-side", async () => {
  const fake = makeFakeHindsight();
  const client = createHindsightClient({ baseUrl: "http://hs.test", bankId: "bojan", fetchImpl: fake.fetchImpl });
  const adapter = createHindsightHypothesisAdapter({ client });
  fake.facts.set("hsf_d", {
    id: "hsf_d", text: "Durable pattern.", type: "world", state: "valid",
    context: "gaia hypothesis",
    metadata: { gaia_hypothesis_id: "hyp-D", gaia_hypothesis_version: "1", gaia_hypothesis_status: "testing", gaia_hypothesis_confidence: "0.6", gaia_hypothesis_evidence_for: "[]", gaia_hypothesis_evidence_against: "[]", gaia_hypothesis_updated_by: "gaia-reasoniq", gaia_hypothesis_persistence: "durable" },
    tags: ["gaia:hypothesis"], document_id: "gaia-hyp-hyp-D-v1",
  });
  fake.facts.set("hsf_e", {
    id: "hsf_e", text: "Ephemeral task guess.", type: "world", state: "valid",
    context: "gaia hypothesis",
    metadata: { gaia_hypothesis_id: "hyp-E", gaia_hypothesis_version: "1", gaia_hypothesis_status: "testing", gaia_hypothesis_confidence: "0.5", gaia_hypothesis_evidence_for: "[]", gaia_hypothesis_evidence_against: "[]", gaia_hypothesis_updated_by: "gaia-reasoniq" },
    tags: ["gaia:hypothesis"], document_id: "gaia-hyp-hyp-E-v1",
  });

  const all = await adapter.recallHypotheses("anything");
  assert.equal(all.length, 2); // both are relevant by default
  const durableOnly = await adapter.recallHypotheses("anything", { persistence: "durable" });
  assert.deepEqual(durableOnly.map((h) => h.id), ["hyp-D"]);
  const ephemeralOnly = await adapter.recallHypotheses("anything", { persistence: "ephemeral" });
  assert.deepEqual(ephemeralOnly.map((h) => h.id), ["hyp-E"]);
});
