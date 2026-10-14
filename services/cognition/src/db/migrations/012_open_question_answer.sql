-- Open questions become answerable by the person.
--
-- v1.2: Logos states WHICH KIND OF question each open question is, so the
-- desktop review card can offer the control the question actually needs instead
-- of always Ja/Nee (a yes/no question is answered with the Ja/Nee pair, an open
-- one with free text, a choice one with a button per option):
--
--   question_shape    — 'yes_no' | 'open' | 'choice' (NULL for other kinds, and
--                       for records written before the field existed; the
--                       gaia-api review surface fills those from the statement);
--   question_options  — the alternatives of a choice question;
--   answer/answered_at — the human's answer, and when they gave it. Answering is
--                       NOT a lifecycle transition: the statement keeps its
--                       status. A question with an answer has been dealt with,
--                       so it leaves the review surface.
--
-- Cognition remains storage-only: it persists what Logos derived and what the
-- human answered; it never reasons about either.

ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS question_shape   TEXT   NULL,
  ADD COLUMN IF NOT EXISTS question_options TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS answer           TEXT   NULL,
  ADD COLUMN IF NOT EXISTS answered_at      TIMESTAMPTZ NULL;

ALTER TABLE hypotheses DROP CONSTRAINT IF EXISTS hypotheses_question_shape_check;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_question_shape_check
  CHECK (question_shape IS NULL OR question_shape IN ('yes_no', 'open', 'choice'));

-- The review surface reads the unanswered questions in a bank; that is the one
-- query this index exists for.
CREATE INDEX IF NOT EXISTS hypotheses_unanswered_question_idx
  ON hypotheses (bank_id, kind, question_shape)
  WHERE answered_at IS NULL AND deleted_at IS NULL;
