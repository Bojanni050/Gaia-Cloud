'use strict';

/**
 * Kairos — turning raw observations (Chronos) into narrative episodes
 * (Kairos), the meaningful, human-readable spans of activity.
 *
 * Epistemic contract (the four-layer model):
 *   - Foundation holds RAW observations, always status 'observation'. Kairos
 *     never writes to Foundation and never mutates a raw record.
 *   - A Kairos episode is a DERIVED synthesis and is therefore always
 *     epistemic_status 'interpretation', carrying `sources` back to the exact
 *     raw records (['chronicle:<ingest_object-id>']) so any interpretation can
 *     be audited down to its evidence.
 *
 * This module is the pure, deterministic core: it forms clusters and derives
 * the epistemic fields. It spends ZERO LLM tokens. The synthesis itself lives
 * in synthesizer.js; orchestration in worker.js.
 */

const EPISTEMIC_OBSERVATION = 'observation';
const EPISTEMIC_INTERPRETATION = 'interpretation';

/**
 * A single raw observation as Kairos sees it (the subset of Foundation's
 * GET /api/memory/episodes?with_source=1 row that matters here).
 * @typedef {{
 *   id: string,
 *   fragment: string,
 *   observed_at: string|Date|null,
 *   captured_at: string|Date,
 *   bron_object_id: string,
 *   observed_app?: string|null,
 *   observed_window?: string|null,
 * }} KairosObservation
 */

/**
 * @typedef {{
 *   id: string,
 *   start_time: string,
 *   end_time: string,
 *   window_end: string,
 *   apps: string[],
 *   observations: KairosObservation[],
 * }} ObservationCluster
 */

module.exports = {
  EPISTEMIC_OBSERVATION,
  EPISTEMIC_INTERPRETATION,
};
