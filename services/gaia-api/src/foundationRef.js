'use strict';

/**
 * Foundation provenance references — the single source of truth for how a
 * derived record cites the raw Foundation observation it was built from.
 *
 * A canonical reference is `foundation:<uuid>`, where `<uuid>` is Foundation's
 * `ingest_object.id` (a bare `gen_random_uuid()`; see Foundation's
 * `GET /api/ingest-logs/:id`). Foundation has two id spaces, which is exactly
 * what made the old scheme drift:
 *
 *   ingest_object.id       -> bare uuid        (what we cite, and what
 *                                               /api/ingest-logs/:id expects)
 *   episode.bron_object_id -> "ingest:<uuid>"  (the episode layer's id)
 *
 * The prefix used to be `chronicle:` — a legacy name (the owning layer is
 * Foundation, not Chronicle) and, worse, ambiguous: the Kairos worker stored
 * `chronicle:ingest:<uuid>` while the evidence route stripped only the first
 * segment and handed `ingest:<uuid>` to an endpoint that wants the bare uuid,
 * so the drill-down silently returned nothing. One seam, shared by the producer
 * and the consumer, is what keeps that from drifting again.
 *
 * `ingestObjectId` also tolerates the legacy `chronicle:` shape so a database
 * written before the prefix migration still resolves; `isFoundationRef` is the
 * strict check for the canonical form only.
 */

const PREFIX = 'foundation:';
const LEGACY_PREFIX = 'chronicle:';

/**
 * Build the canonical source reference for a raw Foundation observation.
 * Tolerates a leading `ingest:` on the input (Foundation's episode id shape).
 * @param {string|null|undefined} bronObjectId
 * @returns {string} `foundation:<uuid>`, or '' when there is no id
 */
function toSourceRef(bronObjectId) {
  const uuid = String(bronObjectId == null ? '' : bronObjectId).trim().replace(/^ingest:/, '').trim();
  return uuid ? `${PREFIX}${uuid}` : '';
}

/**
 * True only for the canonical `foundation:<uuid>` form. Legacy `chronicle:`
 * references return false — they still resolve through `ingestObjectId`, but
 * they are not what we want to write.
 * @param {unknown} ref
 * @returns {boolean}
 */
function isFoundationRef(ref) {
  return typeof ref === 'string' && ref.startsWith(PREFIX) && ref.length > PREFIX.length;
}

/**
 * The Foundation ingest_object id (bare uuid) a reference points at, or null
 * when it is not a recognised Foundation reference. Accepts the canonical form
 * and the legacy `chronicle:` shapes (`chronicle:<uuid>` and
 * `chronicle:ingest:<uuid>`) so pre-migration rows keep resolving. The id it
 * returns is what `GET /api/ingest-logs/:id` expects.
 * @param {unknown} ref
 * @returns {string|null}
 */
function ingestObjectId(ref) {
  if (typeof ref !== 'string') return null;
  const prefix = ref.startsWith(PREFIX) ? PREFIX
    : ref.startsWith(LEGACY_PREFIX) ? LEGACY_PREFIX
      : null;
  if (!prefix) return null;
  const uuid = ref.slice(prefix.length).replace(/^ingest:/, '').trim();
  return uuid || null;
}

module.exports = { PREFIX, LEGACY_PREFIX, toSourceRef, isFoundationRef, ingestObjectId };
