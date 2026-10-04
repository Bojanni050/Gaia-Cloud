-- Provenance for patterns, matching hypotheses.sources: every derived record
-- cites the raw records it was derived from (['chronicle:<id>']).
ALTER TABLE patterns
  ADD COLUMN IF NOT EXISTS sources TEXT[] NOT NULL DEFAULT '{}';
