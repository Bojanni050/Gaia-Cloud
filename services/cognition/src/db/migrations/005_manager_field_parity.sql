-- Phase 4 cutover: bring Cognition to field parity with the Logos reasoning
-- manager so the deferred writer can persist there losslessly.
--
-- hypotheses gains the manager's evidence/durability/method axes. Patterns
-- gain the status + hypothesis membership the pattern manager uses.

ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS evidence_for     TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS evidence_against TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS persistence      TEXT   NOT NULL DEFAULT 'ephemeral',
  ADD COLUMN IF NOT EXISTS method           TEXT   NOT NULL DEFAULT 'asserted';

ALTER TABLE hypotheses DROP CONSTRAINT IF EXISTS hypotheses_persistence_check;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_persistence_check
  CHECK (persistence IN ('ephemeral', 'durable'));

ALTER TABLE hypotheses DROP CONSTRAINT IF EXISTS hypotheses_method_check;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_method_check
  CHECK (method IN ('asserted', 'derived', 'tested'));

ALTER TABLE patterns
  ADD COLUMN IF NOT EXISTS status          TEXT   NOT NULL DEFAULT 'candidate',
  ADD COLUMN IF NOT EXISTS hypothesis_ids  TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE patterns DROP CONSTRAINT IF EXISTS patterns_status_check;
ALTER TABLE patterns
  ADD CONSTRAINT patterns_status_check
  CHECK (status IN ('candidate', 'supported', 'established'));
