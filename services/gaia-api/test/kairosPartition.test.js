'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_CLUSTER_PROMPT_CHARS,
  partitionCluster,
  windowCost,
} = require('../src/kairos/partition');
const { buildUserPrompt } = require('../src/kairos/synthesizer');

const BASE_MS = Date.parse('2026-11-19T10:00:00Z');

/** An observation whose rendered line costs roughly `chars` characters. */
function obs(i, { chars = 40, app = 'msedge', second = i } = {}) {
  return {
    id: `obs${i}`,
    bron_object_id: `ingest:obs${i}`,
    fragment: 'x'.repeat(chars),
    observed_at: new Date(BASE_MS + second * 1000).toISOString(),
    captured_at: new Date(BASE_MS + second * 1000 + 1000).toISOString(),
    observed_app: app,
    observed_window: 'Tab',
  };
}

function clusterOf(observations, extra = {}) {
  return {
    id: `cluster_${observations[0].id}_${observations[observations.length - 1].id}`,
    start_time: observations[0].observed_at,
    end_time: observations[observations.length - 1].observed_at,
    window_end: observations[observations.length - 1].captured_at,
    apps: ['msedge'],
    observations,
    ...extra,
  };
}

/**
 * The budget that fits exactly ONE observation of this shape, derived from the
 * real renderer — so these tests do not encode the synthesizer's own fragment
 * caps (a fragment is cut to 800/1 500 characters before it reaches the prompt).
 */
function budgetForOne(o) {
  return windowCost([o]) + 50;
}

test('an empty cluster yields no windows', () => {
  assert.deepEqual(partitionCluster(null), []);
  assert.deepEqual(partitionCluster({ observations: [] }), []);
});

test('a cluster that fits the budget stays one window — the same one the clusterer built', () => {
  const observations = [1, 2, 3, 4, 5].map((i) => obs(i));
  const cluster = clusterOf(observations);
  const windows = partitionCluster(cluster);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, cluster.id);
  assert.deepEqual(windows[0].observations, observations);
  assert.equal(windows[0].start_time, cluster.start_time);
  assert.equal(windows[0].end_time, cluster.end_time);
  assert.equal(windows[0].window_end, cluster.window_end);
});

test('a cluster too big for one prompt is cut into consecutive windows, and the boundary is where the budget runs out', () => {
  // 30 observations of ~2000 characters: a window holds 11 of them, so 3 windows.
  const observations = Array.from({ length: 30 }, (_, n) => obs(n + 1, { chars: 2000 }));
  const cluster = clusterOf(observations);
  const windows = partitionCluster(cluster);

  assert.ok(windows.length > 1, 'expected a split');
  // Nothing dropped, order preserved.
  assert.deepEqual(
    windows.flatMap((w) => w.observations.map((o) => o.id)),
    observations.map((o) => o.id),
  );
  // Every window is inside the budget it was given.
  for (const w of windows) {
    assert.ok(windowCost(w.observations) <= MAX_CLUSTER_PROMPT_CHARS, `window ${w.id} costs ${windowCost(w.observations)}`);
  }
  // The first window is the LONGEST prefix that fits: adding the next
  // observation would break the budget. That is the greedy rule, and it is the
  // property that keeps a window's id stable while a cluster grows.
  const firstSize = windows[0].observations.length;
  assert.ok(firstSize >= 2, 'a greedy window takes as much as fits');
  assert.ok(windowCost(observations.slice(0, firstSize + 1)) > MAX_CLUSTER_PROMPT_CHARS);
});

test('nothing is lost when a single observation costs more than the whole budget', () => {
  const observations = [obs(1, { chars: 300 }), obs(2, { chars: 300 })];
  const windows = partitionCluster(clusterOf(observations), { maxChars: 100 });
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((w) => w.observations.length), [1, 1]);
  assert.deepEqual(
    windows.flatMap((w) => w.observations.map((o) => o.id)),
    ['obs1', 'obs2'],
  );
});

test('a tiny budget still progresses: one observation per window, never an empty one', () => {
  const observations = Array.from({ length: 6 }, (_, n) => obs(n + 1, { chars: 900 }));
  const windows = partitionCluster(clusterOf(observations), { maxChars: 1000 });
  assert.equal(windows.length, 6);
  for (const w of windows) {
    assert.equal(w.observations.length, 1);
    assert.ok(w.id);
  }
});

test('a window id is stable when the cluster grows at the tail (greedy from the front)', () => {
  const all = Array.from({ length: 30 }, (_, n) => obs(n + 1, { chars: 2000 }));
  // Room for four observations per window, so the 12-observation prefix splits.
  const four = windowCost(all.slice(0, 4)) + 50;
  const first = partitionCluster(clusterOf(all.slice(0, 12)), { maxChars: four });
  const grown = partitionCluster(clusterOf(all), { maxChars: four });

  assert.ok(first.length > 1, 'expected the prefix to split');
  // Every window but the last keeps its id when more observations arrive: the
  // greedy walk only ever extends the tail window.
  assert.deepEqual(
    grown.slice(0, first.length - 1).map((w) => w.id),
    first.slice(0, first.length - 1).map((w) => w.id),
  );
});

test('a non-positive or non-finite budget means no cap: exactly one window', () => {
  const observations = Array.from({ length: 30 }, (_, n) => obs(n + 1, { chars: 2000 }));
  const cluster = clusterOf(observations);
  // Sanity: the same cluster does split when it is given a real budget.
  assert.ok(partitionCluster(cluster, { maxChars: budgetForOne(observations[0]) }).length > 1);
  for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const windows = partitionCluster(cluster, { maxChars: budget });
    assert.equal(windows.length, 1, `budget ${budget} should not split`);
  }
  // Omitting the option is not the same thing: it takes the documented default,
  // which for this oversized cluster means a split.
  assert.equal(
    partitionCluster(cluster).length,
    partitionCluster(cluster, { maxChars: MAX_CLUSTER_PROMPT_CHARS }).length,
  );
  assert.ok(partitionCluster(cluster).length > 1, 'the default budget still bounds the cluster');
});

test('a window describes itself: its own apps and its own first/last timestamps', () => {
  const first = [obs(1, { chars: 2000, app: 'Outlook' }), obs(2, { chars: 2000, app: 'Outlook' })];
  const second = [obs(3, { chars: 2000, app: 'VS Code', second: 20 })];
  const cluster = clusterOf([...first, ...second]);
  const windows = partitionCluster(cluster, { maxChars: budgetForOne(first[0]) });

  assert.equal(windows.length, 3, 'one window per observation at this budget');
  assert.deepEqual(windows.map((w) => w.apps[0]), ['Outlook', 'Outlook', 'VS Code']);
  assert.equal(windows[2].start_time, second[0].observed_at);
  assert.equal(windows[2].window_end, second[0].captured_at);
  // The prompt of a window only carries that window's apps.
  assert.match(buildUserPrompt(windows[2]), /VS Code/);
  assert.doesNotMatch(buildUserPrompt(windows[2]), /Outlook/);
});
