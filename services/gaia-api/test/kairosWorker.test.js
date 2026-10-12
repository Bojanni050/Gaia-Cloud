'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createKairosWorker, computeSafeWatermark, selectClusterable } = require('../src/kairos/worker');
const { INACTIVITY_THRESHOLD_MS } = require('../src/kairos/clusterer');

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
  assert.deepEqual(r, { processed: 0, emitted: 0, skipped: 0, failed: 0 });
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
