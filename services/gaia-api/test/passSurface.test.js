'use strict';

// C7: the background passes had no status surface at all. They computed their
// counts and threw them away, so "is the expiry pass off, or did nothing
// expire?" could only be answered from the container's environment.
//
// This file covers the three layers that answer it: the registry itself, each
// pass actually reporting, and the route plus the wiring that exposes them. The
// failure paths are here too — a switched-off pass must be distinguishable from
// a pass that ran and found nothing, which was the whole complaint.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPassRegistry } = require('../src/passRegistry');
const { createExpiryScan } = require('../src/reasoning/expiryScan');
const { createSoftPromotionScan } = require('../src/reasoning/softPromotionScan');
const { createBeliefFormationScan } = require('../src/reasoning/beliefFormationScan');
const { createAionScheduler } = require('../src/reasoning/aionScheduler');
const { createKairosRuntime } = require('../src/kairos/runtime');
const { createDigestScheduler } = require('../src/kairos/digest');
const { createEleosRuntime } = require('../src/eleosRuntime');
const { createAdminRouter } = require('../src/adminRoutes');
const { createApp } = require('../src/server');
const { parseTokens, createAuthMiddleware } = require('../src/auth');

const find = (registry, name) => registry.snapshot().find((pass) => pass.name === name);

// --- the registry itself ----------------------------------------------------

test('a pass that never started is on the surface with its reason', () => {
  const registry = createPassRegistry();
  registry.declare('expiry', { enabled: false, reason: 'GAIA_HYPOTHESIS_EXPIRY is off' });
  registry.declare('belief-formation', { enabled: true, intervalMs: 900000 });

  const off = find(registry, 'expiry');
  assert.equal(off.enabled, false);
  assert.equal(off.reason, 'GAIA_HYPOTHESIS_EXPIRY is off');
  assert.equal(off.runs, 0, 'a pass that never ran must not look like one that ran and found nothing');
  assert.equal(off.lastRunAt, null);

  const on = find(registry, 'belief-formation');
  assert.equal(on.enabled, true);
  assert.equal(on.reason, null, 'a running pass carries no reason');
  assert.equal(on.intervalMs, 900000);
});

test('a failure keeps the counts of the last good run beside the error', () => {
  const registry = createPassRegistry();
  registry.declare('expiry', { enabled: true, intervalMs: 1000 });
  registry.record('expiry', { at: 1000, durationMs: 5, result: { examined: 4, expired: 1 } });
  registry.record('expiry', { at: 2000, durationMs: 7, result: { examined: 0, expired: 0 } });
  registry.record('expiry', { at: 3000, durationMs: 9, result: { error: 'cognition unreachable' } });

  const pass = find(registry, 'expiry');
  assert.equal(pass.runs, 3);
  assert.equal(pass.failures, 1);
  assert.equal(pass.lastError, 'cognition unreachable');
  assert.equal(pass.lastErrorAt, new Date(3000).toISOString());
  assert.equal(pass.lastRunAt, new Date(3000).toISOString(), 'the last attempt is the last run, not the last success');
  assert.deepEqual(pass.lastCounts, { examined: 0, expired: 0 }, 'a failure must not erase what the last good run found');
});

test('a thrown error is a failure too, and the snapshot is a copy', () => {
  const registry = createPassRegistry();
  registry.record('aion', { error: new Error('the Aion writer threw') });
  assert.equal(find(registry, 'aion').lastError, 'the Aion writer threw');

  const snapshot = registry.snapshot();
  snapshot[0].enabled = true;
  snapshot[0].name = 'nonsense';
  assert.equal(find(registry, 'aion').enabled, false, 'the reader must not be able to write');
  assert.equal(find(registry, 'aion').name, 'aion');
});

test('the snapshot is sorted, so the surface does not reshuffle per request', () => {
  const registry = createPassRegistry();
  registry.declare('soft-promotion');
  registry.declare('aion');
  registry.declare('expiry');
  assert.deepEqual(registry.snapshot().map((p) => p.name), ['aion', 'expiry', 'soft-promotion']);
});

// --- each pass reports ------------------------------------------------------

const EXPIRABLE_ROW = {
  id: 'h1',
  statement: 'Zij werkt het liefst vroeg',
  kind: 'hypothesis',
  status: 'proposed',
  confidence: 0.4,
  updated_at: '2026-01-01T00:00:00Z',
  evidence_for: [],
};

test('the expiry pass reports what it lapsed', async () => {
  const registry = createPassRegistry();
  let updated = null;
  const scan = createExpiryScan({
    cognition: { listHypotheses: async () => [EXPIRABLE_ROW] },
    sink: { update: async (id, patch) => { updated = { id, status: patch.status }; } },
    env: {},
    now: () => Date.parse('2026-11-16T12:00:00Z'),
    logger: { warn() {}, info() {}, error() {} },
    registry,
  });

  const result = await scan.runOnce();
  assert.equal(result.expired, 1);
  assert.deepEqual(updated, { id: 'h1', status: 'expired' });

  const pass = find(registry, 'expiry');
  assert.equal(pass.enabled, true);
  assert.equal(pass.runs, 1);
  assert.equal(pass.lastCounts.expired, 1);
  assert.deepEqual(pass.lastCounts.ids, ['h1']);
});

test('a switched-off scan names the flag that switched it off', () => {
  const registry = createPassRegistry();
  const scan = createSoftPromotionScan({
    cognition: { listHypotheses: async () => [] },
    sink: { update: async () => {} },
    env: { GAIA_HYPOTHESIS_SCAN: 'false' },
    registry,
  });

  assert.equal(scan, null);
  const pass = find(registry, 'soft-promotion');
  assert.equal(pass.enabled, false);
  assert.equal(pass.reason, 'GAIA_HYPOTHESIS_SCAN is off');
});

test('a scan that is on but has no store blames the store, not the flag', () => {
  const registry = createPassRegistry();
  createSoftPromotionScan({ env: {}, logger: { warn() {} }, registry });
  assert.equal(find(registry, 'soft-promotion').reason, 'Cognition client unavailable');

  const second = createPassRegistry();
  createBeliefFormationScan({ cognition: { listObservations: async () => [] }, env: {}, logger: { warn() {} }, registry: second });
  assert.equal(find(second, 'belief-formation').reason, 'hypothesis sink unavailable');
});

test('the Kairos worker is off by default and says which switch turns it on', () => {
  const registry = createPassRegistry();
  const runtime = createKairosRuntime({ env: {}, registry });
  assert.equal(runtime, null);
  assert.equal(find(registry, 'kairos-worker').enabled, false);
  assert.match(find(registry, 'kairos-worker').reason, /GAIA_KAIROS_ENABLED/);
});

test('an Aion flush is recorded, and a writer that throws becomes a failure', async () => {
  const registry = createPassRegistry();
  const failing = createAionScheduler({
    getWriter: () => ({ write: async () => { throw new Error('model down'); } }),
    everyTurns: 1,
    registry,
  });
  await failing.noteTurn({ conversationId: 'c1', messages: [{ role: 'user', content: 'hoi' }] });

  const failed = find(registry, 'aion');
  assert.equal(failed.runs, 1);
  assert.equal(failed.failures, 1);
  assert.match(failed.lastError, /Aion writer threw/);

  const working = createAionScheduler({
    getWriter: () => ({ write: async () => ({ written: 2 }) }),
    everyTurns: 1,
    registry,
  });
  await working.noteTurn({ conversationId: 'c2', messages: [{ role: 'user', content: 'hoi' }] });
  assert.equal(find(registry, 'aion').failures, 1, 'the earlier failure stays visible');
  assert.deepEqual(find(registry, 'aion').lastCounts, { written: 2 });
});

test('an Eleos tick that found nothing still counts as a tick', async () => {
  const registry = createPassRegistry();
  const runtime = createEleosRuntime({
    store: { listDue: () => [], update() {}, countDeliveredSince: () => 0 },
    registry,
    now: () => new Date('2026-11-16T12:00:00Z'),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  runtime.start();

  const result = await runtime.tick();
  assert.deepEqual(result, []);
  const pass = find(registry, 'eleos-tick');
  assert.equal(pass.enabled, true, 'starting the tick puts it on the surface');
  assert.equal(pass.runs, 1, 'an empty round is a round');
  assert.deepEqual(pass.lastCounts, []);
});

test('the digest scheduler records "too early" instead of staying silent', async () => {
  const registry = createPassRegistry();
  const scheduler = createDigestScheduler({
    writer: { generate: async () => ({ skipped: 'too-early' }), minEpisodes: 3 },
    hour: 23,
    now: () => new Date('2026-11-16T09:00:00Z'),
    logger: { info() {}, warn() {} },
    registry,
  });

  const result = await scheduler.tick();
  assert.equal(result.skipped, 'too-early');
  assert.deepEqual(find(registry, 'kairos-digest').lastCounts, { skipped: 'too-early' });
});

// --- the route --------------------------------------------------------------

function startAdminServer({ passRegistry }) {
  const app = express();
  app.use(express.json());
  app.use('/admin', createAdminRouter({ auth: createAuthMiddleware(parseTokens('test-token')), passRegistry }));
  const server = app.listen(0);
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('GET /admin/api/scans serves the registry, behind the token', async () => {
  const registry = createPassRegistry();
  registry.declare('expiry', { enabled: false, reason: 'GAIA_HYPOTHESIS_EXPIRY is off' });
  registry.record('aion', { at: Date.parse('2026-11-16T12:00:00Z'), durationMs: 3, result: { written: 1 } });

  const ctx = startAdminServer({ passRegistry: registry });
  try {
    const unauthorized = await fetch(`${ctx.baseUrl}/admin/api/scans`);
    assert.equal(unauthorized.status, 401);

    const res = await fetch(`${ctx.baseUrl}/admin/api/scans`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(res.status, 200);
    const { passes } = await res.json();
    assert.deepEqual(passes.map((p) => p.name), ['aion', 'expiry']);
    assert.equal(passes.find((p) => p.name === 'expiry').reason, 'GAIA_HYPOTHESIS_EXPIRY is off');
    assert.deepEqual(passes.find((p) => p.name === 'aion').lastCounts, { written: 1 });
  } finally {
    await ctx.close();
  }
});

test('the scans route says the registry is missing rather than claiming there are none', async () => {
  const ctx = startAdminServer({ passRegistry: null });
  try {
    const res = await fetch(`${ctx.baseUrl}/admin/api/scans`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /registry is not wired/);
  } finally {
    await ctx.close();
  }
});

// --- the wiring -------------------------------------------------------------

test('createApp puts every pass on the surface, and the off ones carry their reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-surface-'));
  const artifactPath = path.join(dir, 'foundation-artifact.json');
  fs.writeFileSync(artifactPath, JSON.stringify({
    documents: { 'soul.md': 'SOUL', 'principles.md': 'PRINCIPLES', 'lexicon.md': 'LEXICON' },
  }));

  const app = createApp({
    GAIA_API_TOKEN: 'test-token',
    HERMES_BASE_URL: 'http://fake-hermes.internal/v1',
    HERMES_MODEL: 'hermes-agent',
    FOUNDATION_ARTIFACT_PATH: artifactPath,
    LOGOS_DECISIONS_PATH: path.join(dir, 'logos-decisions'),
  });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/api/scans`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(res.status, 200);
    const { passes } = await res.json();
    assert.deepEqual(
      passes.map((p) => p.name),
      ['aion', 'belief-formation', 'eleos-tick', 'expiry', 'kairos-digest', 'kairos-worker', 'research-poll', 'soft-promotion'],
      'the eight timer passes, and nothing that only looks like one',
    );

    const byName = Object.fromEntries(passes.map((p) => [p.name, p]));
    for (const name of ['soft-promotion', 'expiry', 'belief-formation', 'aion']) {
      assert.equal(byName[name].enabled, true, `${name} is on by default`);
      assert.equal(byName[name].reason, null);
    }
    // The four that are off by default: each must say why, or the surface has
    // not answered the question it exists for.
    assert.match(byName['kairos-worker'].reason, /GAIA_KAIROS_ENABLED/);
    assert.match(byName['kairos-digest'].reason, /GAIA_KAIROS_ENABLED/);
    assert.equal(byName['eleos-tick'].reason, 'GAIA_ELEOS is off (default)');
    assert.match(byName['research-poll'].reason, /GAIA_RESEARCH_REACH/);
    assert.equal(byName.aion.intervalMs, null, 'Aion has no interval; its note says what it does instead');
    assert.match(byName.aion.note, /every N turns/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
