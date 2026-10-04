'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  groupObservations,
  INACTIVITY_THRESHOLD_MS,
  MAX_CLUSTER_DURATION_MS,
} = require('../src/kairos/clusterer');

let seq = 0;
function obs(observedAt, app, { capturedAt, id } = {}) {
  seq += 1;
  return {
    id: id || `obs${seq}`,
    bron_object_id: `ingest:${id || `obs${seq}`}`,
    fragment: `text ${seq}`,
    observed_at: new Date(observedAt).toISOString(),
    captured_at: new Date(capturedAt || observedAt).toISOString(),
    observed_app: app || null,
  };
}

const NOW = '2026-10-04T23:00:00.000Z';

test('empty input yields no clusters', () => {
  assert.deepEqual(groupObservations([], { now: NOW }), []);
  assert.deepEqual(groupObservations(null, { now: NOW }), []);
});

test('a single closed observation (older than the inactivity window) becomes one cluster', () => {
  const clusters = groupObservations([obs('2026-10-04T10:00:00Z', 'Outlook')], { now: NOW });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].apps, ['Outlook']);
});

test('sorts by event time before grouping, independent of input order', () => {
  const a = obs('2026-10-04T10:00:00Z', 'Outlook', { id: 'a' });
  const b = obs('2026-10-04T10:00:10Z', 'Outlook', { id: 'b' });
  const clusters = groupObservations([b, a], { now: NOW });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].observations.map((o) => o.id), ['a', 'b']);
});

test('an inactivity gap > 5 min splits into two clusters', () => {
  const first = obs('2026-10-04T10:00:00Z', 'Outlook');
  const second = obs(new Date(Date.parse('2026-10-04T10:00:00Z') + INACTIVITY_THRESHOLD_MS + 1000).toISOString(), 'Outlook');
  const clusters = groupObservations([first, second], { now: NOW });
  assert.equal(clusters.length, 2);
});

test('an app switch starts a new cluster', () => {
  const a = obs('2026-10-04T10:00:00Z', 'Outlook');
  const b = obs('2026-10-04T10:00:10Z', 'VS Code');
  const clusters = groupObservations([a, b], { now: NOW });
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].apps, ['Outlook']);
  assert.deepEqual(clusters[1].apps, ['VS Code']);
});

test('a run exceeding 30 minutes is capped', () => {
  const start = Date.parse('2026-10-04T10:00:00Z');
  const observations = [];
  // one observation every 2 min for 34 min — the 30-min cap must fire.
  for (let m = 0; m <= 34; m += 2) {
    observations.push(obs(new Date(start + m * 60000).toISOString(), 'Outlook', { id: `m${m}` }));
  }
  const clusters = groupObservations(observations, { now: NOW });
  assert.equal(clusters.length, 2);
  const firstSpan = Date.parse(clusters[0].end_time) - Date.parse(clusters[0].start_time);
  assert.ok(firstSpan >= MAX_CLUSTER_DURATION_MS - 2 * 60000, 'first cluster should reach the cap');
});

test('the trailing OPEN run is NOT emitted when finalizeOpen is false (the key anti-fragmentation rule)', () => {
  // Two observations 10s apart, and "now" is right after them — still active.
  const a = obs('2026-10-04T10:00:00Z', 'Outlook');
  const b = obs('2026-10-04T10:00:10Z', 'Outlook');
  const clusters = groupObservations([a, b], { now: '2026-10-04T10:00:20Z' });
  assert.equal(clusters.length, 0, 'an open run must be left for the next poll');
});

test('the trailing run IS emitted once it has been quiet past the inactivity window', () => {
  const a = obs('2026-10-04T10:00:00Z', 'Outlook');
  const b = obs('2026-10-04T10:00:10Z', 'Outlook');
  const now = new Date(Date.parse('2026-10-04T10:00:10Z') + INACTIVITY_THRESHOLD_MS + 1).toISOString();
  const clusters = groupObservations([a, b], { now });
  assert.equal(clusters.length, 1);
});

test('finalizeOpen=true forces the trailing run out (used at end of stream)', () => {
  const a = obs('2026-10-04T10:00:00Z', 'Outlook');
  const b = obs('2026-10-04T10:00:10Z', 'Outlook');
  const clusters = groupObservations([a, b], { now: '2026-10-04T10:00:20Z', finalizeOpen: true });
  assert.equal(clusters.length, 1);
});

test('cluster id is deterministic from the first/last observation', () => {
  const a = obs('2026-10-04T10:00:00Z', 'Outlook', { id: 'a' });
  const b = obs('2026-10-04T10:00:10Z', 'Outlook', { id: 'b' });
  const first = groupObservations([a, b], { now: NOW, finalizeOpen: true });
  const second = groupObservations([{ ...a }, { ...b }], { now: NOW, finalizeOpen: true });
  assert.equal(first[0].id, 'cluster_a_b');
  assert.equal(first[0].id, second[0].id);
});

test('window_end carries the last captured_at (the watermark axis)', () => {
  const a = obs('2026-10-04T10:00:00Z', 'Outlook', { id: 'a', capturedAt: '2026-10-04T10:05:00Z' });
  const clusters = groupObservations([a], { now: NOW });
  assert.equal(clusters[0].window_end, new Date('2026-10-04T10:05:00Z').toISOString());
});
