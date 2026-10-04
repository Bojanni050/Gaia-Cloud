'use strict';

/**
 * Deterministic pre-clustering — the token-free reduction layer (Layer 2).
 *
 * Groups raw observations into clusters on three boundaries, with ZERO LLM
 * tokens spent:
 *   1. an inactivity gap > 5 min closes the cluster;
 *   2. a foreground-app change starts a new cluster;
 *   3. a hard 30-min maximum duration caps an otherwise endless run.
 *
 * Crucially, this is written for an INCREMENTAL poller, not a batch: a cluster
 * is only FINAL when it is provably closed, i.e. the run of observations ended
 * with either an inactivity gap (relative to the next observation) or an app
 * switch. The trailing cluster of a batch is OPEN by definition — the next
 * poll may continue it. finalizeOpen=false (the default) therefore never emits
 * it; the caller advances its watermark only past the closed clusters, so the
 * open one simply keeps growing on the next poll instead of being emitted
 * repeatedly as fragmented, half-true episodes.
 *
 * The inactivity test for the trailing run is measured against `now`: a run of
 * observations that has been quiet for > 5 min is closed even though no later
 * observation arrived to prove it. groupObservations() is pure and takes the
 * timestamp it should treat as "now", so it needs no clock of its own.
 *
 * Cluster ids are DETERMINISTIC (derived from the first/last observation id),
 * so re-processing the same observations yields the same id and the writer can
 * upsert instead of duplicating.
 */

const INACTIVITY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CLUSTER_DURATION_MS = 30 * 60 * 1000; // 30 minutes

function toMs(value) {
  if (value == null) return NaN;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return ms;
}

function isClosedVsNext(prev, nextMs) {
  if (!Number.isFinite(nextMs)) return false;
  const gap = nextMs - toMs(prev.observed_at);
  return gap > INACTIVITY_THRESHOLD_MS;
}

function buildCluster(obsList) {
  const apps = [];
  for (const o of obsList) {
    if (o.observed_app && !apps.includes(o.observed_app)) apps.push(o.observed_app);
  }
  const first = obsList[0];
  const last = obsList[obsList.length - 1];
  return {
    id: `cluster_${first.id}_${last.id}`,
    start_time: new Date(toMs(first.observed_at)).toISOString(),
    end_time: new Date(toMs(last.observed_at)).toISOString(),
    // The event-time the cluster is "closed as of" (the caller needs it to
    // advance a watermark only past a finalized cluster).
    window_end: new Date(toMs(last.captured_at)).toISOString(),
    apps,
    observations: obsList,
  };
}

/**
 * @param {import('./types').KairosObservation[]} observations
 * @param {{ now: string|Date|number, finalizeOpen?: boolean }} options
 * @returns {import('./types').ObservationCluster[]}
 */
function groupObservations(observations, { now, finalizeOpen = false } = {}) {
  if (!Array.isArray(observations) || observations.length === 0) return [];
  const nowMs = toMs(now);

  // Chronos order: by event time, then by captured time as a tiebreak so the
  // grouping is stable even for same-instant observations.
  const sorted = [...observations].sort((a, b) => {
    const ao = toMs(a.observed_at) - toMs(b.observed_at);
    if (ao !== 0) return ao;
    return toMs(a.captured_at) - toMs(b.captured_at);
  });

  const clusters = [];
  let current = [sorted[0]];
  let clusterStartMs = toMs(sorted[0].observed_at);

  const flush = () => {
    clusters.push(buildCluster(current));
  };

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const currMs = toMs(curr.observed_at);
    const gap = currMs - toMs(prev.observed_at);
    const duration = currMs - clusterStartMs;
    const appChanged = (prev.observed_app || null) !== (curr.observed_app || null);

    if (gap > INACTIVITY_THRESHOLD_MS || appChanged || duration >= MAX_CLUSTER_DURATION_MS) {
      flush();
      current = [curr];
      clusterStartMs = currMs;
    } else {
      current.push(curr);
    }
  }

  // The trailing run: only final if a boundary proves it closed.
  const last = current[current.length - 1];
  const lastMs = toMs(last.observed_at);
  const trailingClosed =
    finalizeOpen ||
    (nowMs - lastMs > INACTIVITY_THRESHOLD_MS) ||
    (nowMs - clusterStartMs >= MAX_CLUSTER_DURATION_MS);

  if (trailingClosed) {
    flush();
  }

  return clusters;
}

module.exports = {
  INACTIVITY_THRESHOLD_MS,
  MAX_CLUSTER_DURATION_MS,
  groupObservations,
};
