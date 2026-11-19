'use strict';

/**
 * Episode partition — one cluster, several episodes when the cluster is too big
 * to send as one.
 *
 * WHY (measured 2026-11-19 on the live store, three days of observations): a
 * cluster is capped by TIME (`MAX_CLUSTER_DURATION_MS` = 30 min in
 * `clusterer.js`), not by content, while capture-rs samples a browser window
 * every few seconds. 6 861 clusterable observations formed 1 294 closed
 * clusters, and the tail was not a long tail:
 *
 *   observations/cluster   p50 2   p90 12   p95 20   p99 66   max 173
 *   rendered prompt chars  p50 1 491   p90 10 727   p95 17 250
 *                          p99 53 396   max 161 472
 *
 * 140 clusters cost more than 10 000 characters, 51 more than 20 000, and the
 * worst one was 161 472 — one 30-minute browsing cluster with 173 observations.
 * That is the request the pipeline builds, and it walks straight into a model's
 * context limit (the open point of the 2026-11-19 round).
 *
 * THE RULE: an episode's observation block may cost at most
 * `MAX_CLUSTER_PROMPT_CHARS` characters. A cluster that costs more is cut into
 * consecutive windows, and each window becomes its own episode. The boundary
 * therefore falls where the BUDGET runs out, never at a fixed observation
 * count, because the cost is in the text: a messaging fragment is allowed 1 500
 * characters and a window title 200, so ten observations can outweigh eighty.
 * Nothing is dropped — the windows concatenated are the cluster, in order.
 *
 * It runs where the cost is measurable: `buildUserPrompt` is the renderer, so
 * the budget is measured on exactly the string that goes out, with the window's
 * own app list (that list is part of the same prompt).
 *
 * IDS. A window id uses the clusterer's own rule — `cluster_<first>_<last>`
 * observation id — and the walk is greedy from the front, so:
 *   - re-partitioning the same observations yields the same ids (the writer
 *     upserts instead of duplicating);
 *   - a window keeps its id when the cluster later grows at the tail, which is
 *     how the worker's existing-episode check keeps skipping episodes it
 *     already paid a model call for.
 *
 * WHAT THIS DOES NOT DO: it never drops an observation to fit the budget. A
 * single observation that alone costs more than the budget still gets its own
 * window — the fragment caps in the synthesizer (200/800/1 500 characters) are
 * the layer that bounds one observation, and silently losing screen text is not
 * this function's job. A non-positive or non-finite budget means "no cap":
 * exactly one window, the whole cluster (the pre-2026-11-19 behaviour).
 */

const { buildUserPrompt } = require('./synthesizer');

// ~6 000 tokens of observation block: far below any model's context, large
// enough that 95% of the measured clusters still fit in one episode.
const MAX_CLUSTER_PROMPT_CHARS = 24000;

/**
 * The apps an observation list actually saw, in first-seen order — the rule
 * `clusterer.js` uses, applied to a window instead of the whole cluster.
 * @param {Array<{observed_app?: string}>} observations
 * @returns {string[]}
 */
function appsOf(observations) {
  const apps = [];
  for (const o of observations) {
    if (o && o.observed_app && !apps.includes(o.observed_app)) apps.push(o.observed_app);
  }
  return apps;
}

/** What one window costs in the prompt: the rendered block, apps line included. Pure. */
function windowCost(observations) {
  return buildUserPrompt({ observations, apps: appsOf(observations) }).length;
}

/** An ISO timestamp, or the cluster's own value when the observation has none. */
function isoOr(value, fallback) {
  const ms = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

/** A cluster-shaped window around one slice of the cluster's observations. */
function toWindow(cluster, observations) {
  const first = observations[0];
  const last = observations[observations.length - 1];
  return {
    id: `cluster_${first.id}_${last.id}`,
    start_time: isoOr(first.observed_at, cluster.start_time),
    end_time: isoOr(last.observed_at, cluster.end_time),
    // The event-time the window is closed as of — same field, same meaning as
    // the clusterer's, so the watermark axis does not change.
    window_end: isoOr(last.captured_at, cluster.window_end || cluster.end_time),
    apps: appsOf(observations),
    observations,
  };
}

/**
 * Cut a cluster into episodes whose observation block fits the budget.
 *
 * @param {import('./types').ObservationCluster} cluster
 * @param {{ maxChars?: number }} [options]
 * @returns {Array<object>} one or more windows, in order. A cluster that fits
 *   returns as a single window with the cluster's own id; an empty cluster
 *   returns nothing.
 */
function partitionCluster(cluster, { maxChars = MAX_CLUSTER_PROMPT_CHARS } = {}) {
  const observations = Array.isArray(cluster && cluster.observations) ? cluster.observations : [];
  if (observations.length === 0) return [];
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : Number.POSITIVE_INFINITY;

  const windows = [];
  let current = [observations[0]];
  for (let i = 1; i < observations.length; i += 1) {
    const candidate = current.concat([observations[i]]);
    // The first observation always starts a window, so `current` is never empty
    // and the walk always progresses — a single observation costs at most
    // MAX_WINDOW_CHARS + MAX_CONVERSATION_CHARS plus its line overhead.
    if (windowCost(candidate) > budget) {
      windows.push(current);
      current = [observations[i]];
    } else {
      current = candidate;
    }
  }
  windows.push(current);
  return windows.map((list) => toWindow(cluster, list));
}

module.exports = {
  MAX_CLUSTER_PROMPT_CHARS,
  appsOf,
  windowCost,
  partitionCluster,
};
