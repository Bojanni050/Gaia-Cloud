-- Expiry — a hypothesis that gathered no evidence and was never touched again
-- lapses, instead of lingering in `proposed` for ever.
--
-- v1.3. A statement formed as a possible explanation is not knowledge on its
-- own: `propose` asks for no evidence at all, so the store fills up with
-- readings that no one ever weighed. The lifecycle already says a proposal
-- only becomes `testing` when its first evidence lands; the piece that was
-- missing is what happens when that never comes. Expiry is that answer, and
-- it is deliberately not rejection:
--
--   status 'expired'    a NEW status, never `rejected`. `rejected` means there
--                       was a substantive reason to dismiss the statement (a
--                       person, or a newer statement superseding it); expired
--                       means nothing happened at all — no evidence arrived
--                       and nothing moved. It is not a quarantine: `rejected`
--                       stays terminal for every automatic path, while an
--                       expired statement is revived to `testing` by later
--                       evidence, because a lapsed hypothesis is not a false
--                       one.
--   verwerp_bron 'verlopen'
--                       why it lapsed, kept distinguishable from 'mens' (a
--                       person rejected it) and 'consolidatie' (a newer
--                       statement superseded it).
--   expired_at          when it lapsed, so the decision stays checkable and a
--                       cleanup pass can be idempotent (it only ever touches
--                       rows that have no expired_at yet).
--
-- The rules live in Logos (services/gaia-api): only the machine lapses a
-- statement, and only from `proposed` with no supporting evidence and no
-- meaningful activity for the configured term. A hypothesis WITH evidence is
-- never touched by this rule — it keeps the ordinary
-- proposed → testing → confirmed/rejected cycle. Cognition remains
-- storage-only: it persists the lapse it is told about, it never decides one.

ALTER TABLE hypotheses DROP CONSTRAINT IF EXISTS hypotheses_status_check;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_status_check
  CHECK (status IN ('proposed', 'testing', 'corroborated', 'confirmed', 'rejected', 'expired'));

ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ NULL;

ALTER TABLE hypotheses DROP CONSTRAINT IF EXISTS hypotheses_verwerp_bron_check;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_verwerp_bron_check
  CHECK (verwerp_bron IS NULL OR verwerp_bron IN ('mens', 'consolidatie', 'verlopen'));

-- One query exists for this index: the expiry pass reads the statements that
-- have been sitting in `proposed` without ever lapsed, oldest activity first.
CREATE INDEX IF NOT EXISTS hypotheses_expiry_candidate_idx
  ON hypotheses (bank_id, updated_at)
  WHERE status = 'proposed' AND expired_at IS NULL AND deleted_at IS NULL;
