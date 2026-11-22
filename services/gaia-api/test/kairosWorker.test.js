'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createKairosWorker, computeSafeWatermark, selectClusterable } = require('../src/kairos/worker');
const { INACTIVITY_THRESHOLD_MS } = require('../src/kairos/clusterer');
const { windowCost } = require('../src/kairos/partition');

function obs(observedAt, app, capturedAt, id, sourceType = 'system-observation') {
  return {
    id,
    bron_object_id: `ingest:${id}`,
    fragment: `text ${id}`,
    observed_at: new Date(observedAt).toISOString(),
    captured_at: new Date(capturedAt || observedAt).toISOString(),
    observed_app: app,
    source_type: sourceType,
  };
}

// A quiet logger so tests don't print.
const quiet = { info() {}, warn() {}, error() {} };

test('requires its dependencies', () => {
  assert.throws(() => createKairosWorker({ bankId: 'gaia' }), /readWatermark|requires/);
});

test('no observations => no work, no watermark write', async () => {
  let wrote = false;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => null,
    writeWatermark: async () => { wrote = true; },
    fetchObservations: async () => [],
    synthesize: async () => { throw new Error('should not run'); },
    saveEpisode: async () => {},
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  const r = await worker.runOnce();
  assert.deepEqual(r, { processed: 0, emitted: 0, skipped: 0, failed: 0, remaining: 0 });
  assert.equal(wrote, false);
});

test('only closed clusters are processed; the open trailing run is left behind', async () => {
  const closedStart = '2026-10-04T10:00:00Z';
  const closedGap = new Date(Date.parse(closedStart) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  const observations = [
    obs(closedStart, 'Outlook', closedStart, 'a'),
    // gap of > 5 min closes the first cluster:
    obs(closedGap, 'VS Code', closedGap, 'b'),
    // a fresh, still-open run right before "now":
    obs('2026-10-04T22:59:50Z', 'VS Code', '2026-10-04T22:59:50Z', 'c'),
    obs('2026-10-04T22:59:59Z', 'VS Code', '2026-10-04T22:59:59Z', 'd'),
  ];
  const saved = [];
  let watermark = null;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => null,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => observations,
    synthesize: async (cluster) => ({ id: cluster.id, summary: 's', epistemic_status: 'interpretation' }),
    saveEpisode: async (ep) => { saved.push(ep.id); },
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  const r = await worker.runOnce();
  // First run: cluster a-b is closed; c-d is open. So exactly two clusters
  // (a alone is closed by the gap; b-c is closed by the app switch; c-d is open)
  assert.equal(saved.length, 2);
  assert.equal(r.failed, 0);
  // The trailing open c-d never appeared:
  assert.equal(saved.includes('cluster_c_d'), false);
  // Watermark advanced (past the closed clusters only):
  assert.ok(watermark);
});

test('a failing cluster STOPS the batch and does NOT advance the watermark past it', async () => {
  const early = '2026-10-04T10:00:00Z';
  const later = new Date(Date.parse(early) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  const observations = [obs(early, 'Outlook', early, 'a'), obs(later, 'VS Code', later, 'b')];
  let watermark = 'UNCHANGED';
  let saveCount = 0;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => null,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => observations,
    // First cluster fails; the batch must not proceed to the second.
    synthesize: async () => { throw new Error('model down'); },
    saveEpisode: async () => { saveCount += 1; },
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  const r = await worker.runOnce();
  assert.equal(saveCount, 0);
  assert.equal(r.failed > 0, true);
  assert.equal(watermark, 'UNCHANGED', 'watermark must not move when a cluster fails');
});

test('watermark advances only past the last CONTIGUOUS successful cluster', async () => {
  const t1 = '2026-10-04T10:00:00Z';
  const t2 = new Date(Date.parse(t1) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  const t3 = new Date(Date.parse(t2) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  const observations = [
    obs(t1, 'Outlook', t1, 'a'),
    obs(t2, 'VS Code', t2, 'b'),
    obs(t3, 'Word', t3, 'c'),
  ];
  let watermark = null;
  let call = 0;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => null,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => observations,
    synthesize: async (cluster) => {
      call += 1;
      if (call === 2) throw new Error('second cluster failed');
      return { id: cluster.id, summary: 's' };
    },
    saveEpisode: async () => {},
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  await worker.runOnce();
  // First cluster succeeded (window_end = t1); second failed; third never ran.
  assert.equal(watermark, new Date(t1).toISOString(), 'watermark stops at the last successful contiguous cluster');
});

test('emit is best-effort: a throwing emitter never fails the episode', async () => {
  const t1 = '2026-10-04T10:00:00Z';
  const t2 = new Date(Date.parse(t1) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  let watermark = null;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => null,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => [obs(t1, 'Outlook', t1, 'a'), obs(t2, 'VS Code', t2, 'b')],
    synthesize: async (cluster) => ({ id: cluster.id, summary: 's' }),
    saveEpisode: async () => {},
    emit: () => { throw new Error('listener blew up'); },
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  const r = await worker.runOnce();
  assert.equal(r.processed, 2);
  assert.ok(watermark, 'watermark still advanced despite the emit error');
});

// --- the per-run budget: a bounded run still advances the watermark ---------

test('a run stops at its cluster budget, advances the watermark and reports what is left', async () => {
  const step = INACTIVITY_THRESHOLD_MS + 1000;
  const t1 = '2026-10-04T10:00:00Z';
  const t2 = new Date(Date.parse(t1) + step).toISOString();
  const t3 = new Date(Date.parse(t2) + step).toISOString();
  const t4 = new Date(Date.parse(t3) + step).toISOString();
  // Four separate clusters (each an app switch), the last one closed by "now".
  const observations = [
    obs(t1, 'A', t1, 'a'),
    obs(t2, 'B', t2, 'b'),
    obs(t3, 'C', t3, 'c'),
    obs(t4, 'D', t4, 'd'),
  ];
  const saved = [];
  let watermark = null;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    maxClustersPerRun: 2,
    readWatermark: async () => null,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => observations,
    synthesize: async (cluster) => ({ id: cluster.id, summary: 's' }),
    saveEpisode: async (ep) => { saved.push(ep.id); },
    now: () => new Date(Date.parse(t4) + 10 * 60 * 1000),
  });
  const r = await worker.runOnce();
  assert.equal(saved.length, 2, 'only the budgeted clusters are synthesized');
  assert.equal(r.processed, 2);
  assert.equal(r.remaining, 2, 'the untouched clusters are reported for the next run');
  assert.equal(watermark, new Date(t2).toISOString(), 'the watermark advances over the finished slice');
});

test('a bounded run leaves nothing behind once the budget covers the batch', async () => {
  const step = INACTIVITY_THRESHOLD_MS + 1000;
  const t1 = '2026-10-04T10:00:00Z';
  const t2 = new Date(Date.parse(t1) + step).toISOString();
  const observations = [obs(t1, 'A', t1, 'a'), obs(t2, 'B', t2, 'b')];
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    maxClustersPerRun: 50,
    readWatermark: async () => null,
    writeWatermark: async () => {},
    fetchObservations: async () => observations,
    synthesize: async (cluster) => ({ id: cluster.id, summary: 's' }),
    saveEpisode: async () => {},
    now: () => new Date(Date.parse(t2) + 10 * 60 * 1000),
  });
  const r = await worker.runOnce();
  assert.equal(r.processed, 2);
  assert.equal(r.remaining, 0);
});

// --- computeSafeWatermark: the captured_at-axis guarantee -------------------

test('computeSafeWatermark: everything finalized => the batch max captured_at', () => {
  const batch = [obs('2026-01-01T00:00:00Z', 'A', '2026-09-23T00:00:00Z', 'a'), obs('2026-01-02T00:00:00Z', 'A', '2026-10-01T00:00:00Z', 'b')];
  const finalized = [{ observations: batch }];
  assert.equal(computeSafeWatermark(batch, finalized, null), new Date('2026-10-01T00:00:00Z').toISOString());
});

test('computeSafeWatermark: never past the earliest UNfinalized captured_at', () => {
  // Backfill shape: event order != captured_at order. `a` is finalized but was
  // captured LATER than unfinalized `b`; the watermark must stay below b.
  const a = obs('2025-12-24T00:00:00Z', 'A', '2026-10-05T00:00:00Z', 'a');
  const b = obs('2026-01-01T00:00:00Z', 'A', '2026-09-24T00:00:00Z', 'b');
  const batch = [a, b];
  const wm = computeSafeWatermark(batch, [{ observations: [a] }], null);
  // b (unfinalized) is the earliest captured_at; only observations strictly
  // below it are safe — none here, so nothing advances.
  assert.equal(wm, null);
});

test('computeSafeWatermark: advances to the max captured_at strictly below the cut', () => {
  const a = obs('2025-12-24T00:00:00Z', 'A', '2026-09-23T00:00:00Z', 'a');
  const b = obs('2025-12-25T00:00:00Z', 'A', '2026-09-25T00:00:00Z', 'b');
  const c = obs('2026-01-01T00:00:00Z', 'A', '2026-10-01T00:00:00Z', 'c'); // unfinalized
  const wm = computeSafeWatermark([a, b, c], [{ observations: [a, b] }], null);
  assert.equal(wm, new Date('2026-09-25T00:00:00Z').toISOString());
});

test('computeSafeWatermark is monotonic: it never moves backwards', () => {
  const a = obs('2025-12-24T00:00:00Z', 'A', '2026-09-23T00:00:00Z', 'a');
  const b = obs('2026-01-01T00:00:00Z', 'A', '2026-10-01T00:00:00Z', 'b');
  const current = new Date('2026-10-05T00:00:00Z').toISOString();
  // Safe value would be 2026-09-23 (only a is finalized), i.e. lower than current.
  assert.equal(computeSafeWatermark([a, b], [{ observations: [a] }], current), current);
});

// --- skip-if-exists: a conservative re-fetch never re-spends tokens ---------

test('a cluster whose episode already exists is skipped, not re-synthesized', async () => {
  const t1 = '2026-10-04T10:00:00Z';
  const t2 = new Date(Date.parse(t1) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  let synthCalls = 0;
  let watermark = null;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => null,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => [obs(t1, 'Outlook', t1, 'a'), obs(t2, 'VS Code', t2, 'b')],
    synthesize: async (cluster) => { synthCalls += 1; return { id: cluster.id, summary: 's' }; },
    saveEpisode: async () => {},
    episodeIdFor: (cid) => `e_${cid}`,
    // The first cluster is already stored; the second is not.
    readEpisode: async (id) => (id === 'e_cluster_a_a' ? { id } : null),
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  const r = await worker.runOnce();
  assert.equal(r.skipped, 1);
  assert.equal(r.processed, 1);
  assert.equal(synthCalls, 1, 'the already-stored cluster is not synthesized again');
  assert.ok(watermark, 'a skipped (already-done) cluster still advances the watermark');
});

// --- source selection: only activity observations are clustered -------------

test('selectClusterable: whitelist system-observation; nothing is silently kept', () => {
  const out = selectClusterable([
    obs('2026-10-04T10:00:00Z', 'Outlook', '2026-10-04T10:00:00Z', 'a'),
    obs('2026-10-04T10:00:00Z', 'chatgpt', '2026-10-04T10:00:00Z', 'k', 'chat-import'),
    obs('2026-10-04T10:00:00Z', 'doc', '2026-10-04T10:00:00Z', 'd', 'document'),
    { id: 'x' }, // missing source_type
  ]);
  assert.deepEqual(out.clusterable.map((o) => o.id), ['a']);
  assert.deepEqual(out.skipped.map((o) => o.id).sort(), ['d', 'k', 'x']);
  assert.deepEqual(out.skippedByType, { 'chat-import': 1, document: 1, '(missing)': 1 });
});

test('a mixed batch clusters only captures; a chat is never inside an episode', async () => {
  const t1 = '2026-10-04T10:00:00Z';
  const t2 = new Date(Date.parse(t1) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  const observations = [
    obs(t1, 'Outlook', t1, 'a'),
    obs(t2, 'VS Code', t2, 'b'),
    obs(t2, 'chatgpt', t2, 'k', 'chat-import'),
  ];
  const clusters = [];
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => null,
    writeWatermark: async () => {},
    fetchObservations: async () => observations,
    synthesize: async (cluster) => { clusters.push(cluster); return { id: cluster.id, summary: 's' }; },
    saveEpisode: async () => {},
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  const r = await worker.runOnce();
  assert.ok(clusters.length > 0);
  for (const c of clusters) {
    assert.equal(c.observations.some((o) => o.id === 'k'), false, 'a chat observation is never clustered');
  }
  assert.equal(r.processed, clusters.length);
});

test('a chat-only batch advances the watermark to the end (no stall)', async () => {
  let watermark = null;
  const observations = [
    obs('2026-10-04T10:00:00Z', 'chatgpt', '2026-10-04T10:00:00Z', 'k1', 'chat-import'),
    obs('2026-10-04T11:00:00Z', 'claude', '2026-10-04T11:00:00Z', 'k2', 'chat-import'),
  ];
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => null,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => observations,
    synthesize: async () => { throw new Error('should not run'); },
    saveEpisode: async () => {},
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  const r = await worker.runOnce();
  assert.equal(r.processed, 0);
  assert.equal(watermark, new Date('2026-10-04T11:00:00Z').toISOString());
});

test('an unknown/missing source_type is skipped, logged and never clustered', async () => {
  const t1 = '2026-10-04T10:00:00Z';
  const t2 = new Date(Date.parse(t1) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  const logged = [];
  const clusters = [];
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: { info: (l) => logged.push(l), warn() {}, error() {} },
    readWatermark: async () => null,
    writeWatermark: async () => {},
    fetchObservations: async () => [obs(t1, 'A', t1, 'a', 'weird-type'), obs(t2, 'A', t2, 'b')],
    synthesize: async (cluster) => { clusters.push(cluster); return { id: cluster.id, summary: 's' }; },
    saveEpisode: async () => {},
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  await worker.runOnce();
  for (const c of clusters) assert.equal(c.observations.some((o) => o.id === 'a'), false);
  assert.ok(logged.some((l) => l.includes('weird-type')), 'the skipped source_type is logged');
});

test('an open capture-run caps the watermark; chats after it neither hold nor advance it past the run', async () => {
  const early = '2026-10-04T10:00:00Z';
  const runStart = '2026-10-04T22:59:50Z';
  const observations = [
    obs(early, 'A', early, 'a'),
    obs(runStart, 'B', runStart, 'r1'),
    obs('2026-10-04T22:59:59Z', 'B', '2026-10-04T22:59:59Z', 'r2'),
    obs('2026-10-04T23:30:00Z', 'chatgpt', '2026-10-04T23:30:00Z', 'k', 'chat-import'),
  ];
  let watermark = null;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => null,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => observations,
    synthesize: async (cluster) => ({ id: cluster.id, summary: 's' }),
    saveEpisode: async () => {},
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  await worker.runOnce();
  // Only 'a' is finalized; the r1-r2 run is open, so the watermark stays at 'a'.
  assert.equal(watermark, new Date(early).toISOString());
});

test('a cluster-specific failure does not stop the batch; it is retried and parked after 3 attempts', async () => {
  const t1 = '2026-10-04T10:00:00Z';
  const t2 = new Date(Date.parse(t1) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  const t3 = new Date(Date.parse(t2) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  const observations = [obs(t1, 'Outlook', t1, 'a'), obs(t2, 'VS Code', t2, 'b'), obs(t3, 'Word', t3, 'c')];
  let watermark = null;
  const saved = [];
  const warnings = [];
  let poison = null;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: { info() {}, error() {}, warn: (l) => warnings.push(l) },
    readWatermark: async () => watermark,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => observations,
    synthesize: async (cluster) => {
      if (cluster.observations[0].id === 'b') {
        poison = cluster.id;
        const e = new Error('model responded 400');
        e.clusterSpecific = true;
        throw e;
      }
      return { id: cluster.id, summary: 's' };
    },
    saveEpisode: async (e) => { saved.push(e.id); },
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  await worker.runOnce();
  // Run 1: a and c are synthesized although b failed; the watermark stays below b.
  assert.equal(saved.length, 2);
  assert.equal(watermark, new Date(t1).toISOString());
  await worker.runOnce();
  assert.equal(watermark, new Date(t1).toISOString(), 'second attempt: still held');
  await worker.runOnce();
  // Third attempt parks b; the watermark may now pass it.
  assert.equal(warnings.some((w) => w.includes('parked') && w.includes(poison)), true);
  assert.equal(watermark, new Date(t3).toISOString());
});

// Four windows, each far enough apart to be its own cluster: a, b, c, d.
function fourWindows() {
  const t = ['2026-10-04T10:00:00Z'];
  for (let i = 1; i < 4; i += 1) t.push(new Date(Date.parse(t[i - 1]) + INACTIVITY_THRESHOLD_MS + 1000).toISOString());
  return { t, observations: ['a', 'b', 'c', 'd'].map((id, i) => obs(t[i], `App${i}`, t[i], id)) };
}

function refusal() {
  const e = new Error('kairos synthesis: model responded 403');
  e.status = 403;
  e.refusal = true;
  return e;
}

test('a 403 on one cluster does not freeze the batch: the others go through and it is parked after 3 runs', async () => {
  const { t, observations } = fourWindows();
  let watermark = null;
  const saved = [];
  const warnings = [];
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: { info() {}, error() {}, warn: (l) => warnings.push(l) },
    readWatermark: async () => watermark,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => observations,
    synthesize: async (cluster) => {
      if (cluster.observations[0].id === 'a') throw refusal(); // the poison one, FIRST in line
      return { id: cluster.id, summary: 's' };
    },
    saveEpisode: async (e) => { saved.push(e.id); },
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  await worker.runOnce();
  assert.equal(saved.length, 3, 'b, c and d are synthesized although a was refused');
  assert.equal(watermark, null, 'but the watermark cannot pass a yet');
  await worker.runOnce();
  assert.equal(warnings.some((w) => w.includes('parked')), false, 'two attempts: not parked');
  await worker.runOnce();
  assert.equal(warnings.some((w) => w.includes('parked')), true, 'third attempt parks it');
  assert.equal(watermark, new Date(t[3]).toISOString(), 'the watermark passes the parked window');
});

test('three 403s in a row with no success are the provider: the run stops and nothing is parked', async () => {
  const { observations } = fourWindows();
  let calls = 0;
  const warnings = [];
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: { info() {}, error() {}, warn: (l) => warnings.push(l) },
    readWatermark: async () => null,
    writeWatermark: async () => {},
    fetchObservations: async () => observations,
    synthesize: async () => { calls += 1; throw refusal(); },
    saveEpisode: async () => {},
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  // Many runs: a revoked key must never wear a cluster down to "parked".
  for (let i = 0; i < 5; i += 1) await worker.runOnce();
  assert.equal(calls, 15, 'each run stops after 3 refusals, d is never reached');
  assert.equal(warnings.some((w) => w.includes('parked')), false);
});

test('two refusals followed by a success count against those two windows only', async () => {
  const { observations } = fourWindows();
  const warnings = [];
  const attemptsSeen = [];
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: { info() {}, warn() {}, error: (l) => attemptsSeen.push(l) },
    readWatermark: async () => null,
    writeWatermark: async () => {},
    fetchObservations: async () => observations,
    synthesize: async (cluster) => {
      if (['a', 'b'].includes(cluster.observations[0].id)) throw refusal();
      return { id: cluster.id, summary: 's' };
    },
    saveEpisode: async () => {},
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  await worker.runOnce();
  const counted = attemptsSeen.filter((l) => l.includes('(attempt 1/3)'));
  assert.equal(counted.length, 2, 'a and b are each one failed attempt; c and d are untouched');
  assert.equal(warnings.length, 0);
});

test('a provider-wide failure (no clusterSpecific flag) still stops the batch', async () => {
  const t1 = '2026-10-04T10:00:00Z';
  const t2 = new Date(Date.parse(t1) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  let calls = 0;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => null,
    writeWatermark: async () => {},
    fetchObservations: async () => [obs(t1, 'Outlook', t1, 'a'), obs(t2, 'VS Code', t2, 'b')],
    synthesize: async () => { calls += 1; throw new Error('kairos synthesis: model responded 502'); },
    saveEpisode: async () => {},
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  await worker.runOnce();
  assert.equal(calls, 1);
});

test('the watermark is saved as clusters finish, not only at the end of the run', async () => {
  const t1 = '2026-10-04T10:00:00Z';
  const t2 = new Date(Date.parse(t1) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  const t3 = new Date(Date.parse(t2) + INACTIVITY_THRESHOLD_MS + 1000).toISOString();
  const writes = [];
  let stored = null;
  let call = 0;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    readWatermark: async () => stored,
    writeWatermark: async (iso) => { stored = iso; writes.push(iso); },
    fetchObservations: async () => [obs(t1, 'Outlook', t1, 'a'), obs(t2, 'VS Code', t2, 'b'), obs(t3, 'Word', t3, 'c')],
    synthesize: async (cluster) => {
      call += 1;
      // The run dies on the third cluster (a provider-wide error).
      if (call === 3) {
        assert.deepEqual(writes, [new Date(t1).toISOString(), new Date(t2).toISOString()], 'saved before the run ended');
        throw new Error('provider down');
      }
      return { id: cluster.id, summary: 's' };
    },
    saveEpisode: async () => {},
    now: () => new Date('2026-10-04T23:00:00Z'),
  });
  await worker.runOnce();
  assert.equal(stored, new Date(t2).toISOString());
  assert.equal(new Set(writes).size, writes.length, 'no duplicate writes');
});

// --- One cluster, several episodes (partition.js, 2026-11-19) ----------------

/**
 * One observation with a big fragment, all inside the inactivity window and in
 * one app: together they form ONE cluster whose rendered prompt runs far past
 * the budget, which is exactly the case the live store showed (161 472 chars).
 */
const BIG_BASE = Date.parse('2026-11-19T10:00:00Z');
function bigObs(id, second, chars = 2000) {
  const at = new Date(BIG_BASE + second * 1000).toISOString();
  return {
    id: `obs${id}`,
    bron_object_id: `ingest:obs${id}`,
    fragment: 'x'.repeat(chars),
    observed_at: at,
    captured_at: at,
    observed_app: 'msedge',
    source_type: 'system-observation',
  };
}

/**
 * A budget that fits exactly one of those observations, derived from the real
 * renderer: the floor for "one episode per slice" without encoding the
 * synthesizer's own fragment caps.
 */
const ONE_OBS_BUDGET = windowCost([bigObs('probe', 0)]) + 50;

test('a cluster whose prompt exceeds maxClusterChars becomes several episodes, one model call each', async () => {
  const observations = ['a', 'b', 'c', 'd'].map((id, i) => bigObs(id, i * 10));
  const synthesized = [];
  let watermark = null;
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    maxClusterChars: ONE_OBS_BUDGET, // fits one of these observations per window
    readWatermark: async () => null,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => observations,
    synthesize: async (window) => { synthesized.push(window); return { id: window.id, summary: 's' }; },
    saveEpisode: async () => {},
    now: () => new Date('2026-11-19T12:00:00Z'),
  });
  const r = await worker.runOnce();

  assert.equal(synthesized.length, 4, 'one model call per window');
  assert.deepEqual(synthesized.map((w) => w.observations.length), [1, 1, 1, 1]);
  assert.equal(new Set(synthesized.map((w) => w.id)).size, 4, 'each window its own episode id');
  // A window carries its own slice, not the whole cluster:
  assert.deepEqual(synthesized[2].observations.map((o) => o.id), ['obsc']);
  assert.equal(r.processed, 4);
  assert.equal(r.remaining, 0);
  assert.equal(watermark, observations[3].captured_at, 'everything finalized');
});

test('the run budget bounds windows, and a re-fetch skips the episodes already stored', async () => {
  const observations = ['a', 'b', 'c', 'd'].map((id, i) => bigObs(id, i * 10));
  const storedEpisodes = new Map();
  const synthIds = [];
  const state = { watermark: null };

  // One worker per run budget, all three sharing the store and the cursor —
  // which is what a restart looks like from the inside.
  const makeWorker = (maxClustersPerRun) => createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    maxClusterChars: ONE_OBS_BUDGET,
    maxClustersPerRun,
    readWatermark: async () => state.watermark,
    writeWatermark: async (iso) => { state.watermark = iso; },
    // The conservative re-fetch: every run sees the same batch again.
    fetchObservations: async () => observations,
    synthesize: async (window) => { synthIds.push(window.id); return { id: `kei_gaia_${window.id}`, summary: 's' }; },
    saveEpisode: async (episode) => { storedEpisodes.set(episode.id, episode); },
    readEpisode: async (id) => storedEpisodes.get(id) || null,
    episodeIdFor: (clusterId) => `kei_gaia_${clusterId}`,
    emit: () => {},
    now: () => new Date('2026-11-19T12:00:00Z'),
  });

  const first = await makeWorker(2).runOnce();
  assert.equal(first.processed, 2, 'the budget counts windows, not time clusters');
  assert.equal(first.remaining, 2);
  assert.equal(synthIds.length, 2);
  // Pinned below the first unfinished window: its observations are re-fetched.
  assert.equal(state.watermark, observations[1].captured_at);

  // The same batch again (a failed run left the watermark behind). The two
  // stored windows are skipped without a model call — and a skip counts as
  // finished work for the run budget, exactly as a skipped cluster did, so this
  // run spends its budget on nothing new.
  const second = await makeWorker(2).runOnce();
  assert.equal(second.skipped, 2, 'the stored windows are skipped without a model call');
  assert.equal(second.processed, 0);
  assert.equal(synthIds.length, 2, 'no second model call for a stored window');
  assert.equal(state.watermark, observations[1].captured_at, 'a skip alone cannot move the cursor');

  // With room for the whole batch the re-fetch converges: skip, then finish.
  const third = await makeWorker(8).runOnce();
  assert.equal(third.skipped, 2);
  assert.equal(third.processed, 2);
  assert.equal(third.remaining, 0);
  assert.equal(synthIds.length, 4);
  assert.equal(new Set(synthIds).size, 4, 'no window was synthesized twice');
  assert.equal(state.watermark, observations[3].captured_at);
});

test('a window the provider refuses moves on, and that window is not finalized', async () => {
  const observations = ['a', 'b', 'c'].map((id, i) => bigObs(id, i * 10));
  let watermark = null;
  const seen = [];
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: quiet,
    maxClusterChars: ONE_OBS_BUDGET,
    readWatermark: async () => null,
    writeWatermark: async (iso) => { watermark = iso; },
    fetchObservations: async () => observations,
    synthesize: async (window) => {
      seen.push(window.observations[0].id);
      if (window.observations[0].id === 'obsb') {
        const error = new Error('model output was not valid JSON');
        error.clusterSpecific = true;
        throw error;
      }
      return { id: window.id, summary: 's' };
    },
    saveEpisode: async () => {},
    now: () => new Date('2026-11-19T12:00:00Z'),
  });
  const r = await worker.runOnce();

  assert.deepEqual(seen, ['obsa', 'obsb', 'obsc'], 'the refused window did not stop the rest');
  assert.equal(r.processed, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.remaining, 1);
  // The watermark may not name an observation of the unfinalized window.
  assert.equal(watermark, observations[0].captured_at);
});

test('a split cluster is reported in the log, a cluster that fits is not', async () => {
  const big = ['a', 'b', 'c', 'd'].map((id, i) => bigObs(id, i * 10));
  // A separate, small cluster (a different app an hour earlier) that fits.
  const small = [obs('2026-11-19T09:00:00Z', 'Outlook', '2026-11-19T09:00:00Z', 'x')];
  const lines = [];
  const worker = createKairosWorker({
    bankId: 'gaia',
    logger: { info: (line) => lines.push(line), warn() {}, error() {} },
    maxClusterChars: ONE_OBS_BUDGET,
    readWatermark: async () => null,
    writeWatermark: async () => {},
    fetchObservations: async () => [...big, ...small],
    synthesize: async (window) => ({ id: window.id, summary: 's' }),
    saveEpisode: async () => {},
    now: () => new Date('2026-11-19T12:00:00Z'),
  });
  await worker.runOnce();

  const splits = lines.filter((line) => line.includes('episodes (observation block over'));
  assert.equal(splits.length, 1, 'exactly one line for the one split cluster');
  assert.match(splits[0], /cluster_obsa_obsd is 4 episodes/);
  assert.match(splits[0], new RegExp(`over ${ONE_OBS_BUDGET} chars`));
  assert.ok(!lines.some((line) => line.includes('cluster_obsx_obsx')), 'the fitting cluster is silent');
});

