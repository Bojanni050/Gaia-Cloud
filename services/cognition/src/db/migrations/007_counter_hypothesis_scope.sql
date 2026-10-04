-- V3 anti-lexicographic counter-hypothesis + epistemic entrenchment.
--
-- Adds:
--   * counter_hypothesis — the mandatory opposing reading of the same source,
--     kept in quarantine (surfaced only for human review, never a fact). NULL
--     is honest absence: a hypothesis without one cannot be confirmed.
--   * scope — 'micro' | 'macro'. Micro is low-impact and may soft-promote to
--     'corroborated'; macro (the safe default) always needs the human.
--
-- Cognition stays storage-only: it persists what Logos derived and the human
-- confirmed/rejected; it never invents a counter-hypothesis and never reasons.

ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS counter_hypothesis TEXT NULL,
  ADD COLUMN IF NOT EXISTS scope              TEXT NOT NULL DEFAULT 'macro';

ALTER TABLE hypotheses DROP CONSTRAINT IF EXISTS hypotheses_scope_check;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_scope_check
  CHECK (scope IN ('micro', 'macro'));

CREATE INDEX IF NOT EXISTS hypotheses_scope_status_idx
  ON hypotheses (bank_id, scope, status) WHERE deleted_at IS NULL;
