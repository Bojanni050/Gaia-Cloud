-- Normalise the provenance prefix on derived `sources` arrays:
--   chronicle:ingest:<uuid>  ->  foundation:<uuid>
--   chronicle:<uuid>         ->  foundation:<uuid>
--
-- Rationale: the raw store is Foundation, not Chronicle, and a source ref is a
-- routing key (it decides where the evidence drill-down fetches from), so the
-- prefix must name the owning layer. The old Kairos form also carried
-- Foundation's episode-level "ingest:" prefix, which the evidence route handed
-- straight to GET /api/ingest-logs/:id — an endpoint that wants the bare
-- ingest_object uuid. This migration stores the bare uuid, matching the
-- foundationRef seam (services/gaia-api/src/foundationRef.js).
--
-- Only entries that actually carry the prefix are touched; every other entry is
-- left byte-for-byte identical. Historical migrations (003/004/008) keep their
-- original comments — this file is the record of the change.

CREATE FUNCTION _gaia_normalize_source_refs(refs TEXT[])
RETURNS TEXT[] AS $$
  SELECT ARRAY(
    SELECT CASE
             WHEN s LIKE 'chronicle:%'
               THEN 'foundation:' || regexp_replace(s, '^chronicle:(ingest:)?', '')
             ELSE s
           END
      FROM unnest(refs) WITH ORDINALITY AS t(s, ord)
     ORDER BY ord
  );
$$ LANGUAGE sql IMMUTABLE;

UPDATE kairos_episodes
   SET sources = _gaia_normalize_source_refs(sources)
 WHERE EXISTS (SELECT 1 FROM unnest(sources) AS s WHERE s LIKE 'chronicle:%');

UPDATE hypotheses
   SET sources = _gaia_normalize_source_refs(sources)
 WHERE EXISTS (SELECT 1 FROM unnest(sources) AS s WHERE s LIKE 'chronicle:%');

UPDATE patterns
   SET sources = _gaia_normalize_source_refs(sources)
 WHERE EXISTS (SELECT 1 FROM unnest(sources) AS s WHERE s LIKE 'chronicle:%');

DROP FUNCTION _gaia_normalize_source_refs(TEXT[]);
