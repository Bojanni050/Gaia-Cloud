-- V3 derived-knowledge lifecycle.
--
-- Adds:
--   * the machine tier 'corroborated' (soft-promotion, C >= 0.80) BELOW the
--     human-only 'confirmed' tier — Absolute Override stays intact;
--   * verwerp_bron — who/why a statement was rejected ('mens' | 'consolidatie');
--   * sources — provenance back to the raw record (['chronicle:<id>']);
--   * kind — hypothesis | mental_model | relationship (candidate derived
--     records share this table and lifecycle);
--   * supersedes_id / superseded_by_id — consolidation links between statements.
--
-- Cognition remains storage-only: it persists what Logos derived and the
-- human confirmed/rejected; it never reasons.

ALTER TABLE hypotheses DROP CONSTRAINT IF EXISTS hypotheses_status_check;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_status_check
  CHECK (status IN ('proposed', 'testing', 'corroborated', 'confirmed', 'rejected'));

ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS kind            TEXT   NOT NULL DEFAULT 'hypothesis',
  ADD COLUMN IF NOT EXISTS verwerp_bron    TEXT   NULL,
  ADD COLUMN IF NOT EXISTS sources         TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS supersedes_id   UUID   NULL REFERENCES hypotheses(id),
  ADD COLUMN IF NOT EXISTS superseded_by_id UUID  NULL REFERENCES hypotheses(id);

ALTER TABLE hypotheses DROP CONSTRAINT IF EXISTS hypotheses_kind_check;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_kind_check
  CHECK (kind IN ('hypothesis', 'mental_model', 'relationship'));

ALTER TABLE hypotheses DROP CONSTRAINT IF EXISTS hypotheses_verwerp_bron_check;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_verwerp_bron_check
  CHECK (verwerp_bron IS NULL OR verwerp_bron IN ('mens', 'consolidatie'));

CREATE INDEX IF NOT EXISTS hypotheses_bank_id_kind_status_idx
  ON hypotheses (bank_id, kind, status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS hypotheses_superseded_by_idx
  ON hypotheses (superseded_by_id) WHERE superseded_by_id IS NOT NULL;
