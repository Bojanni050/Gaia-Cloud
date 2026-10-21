-- What a statement's evidence actually SAID, kept beside the ids that cite it.
--
-- evidence_for / evidence_against hold the ids Logos reasoned over in the turn
-- that produced them: `hindsight-1`, `upload-1`, `model-2`. Those are turn-local
-- labels. The text behind them lived only in that one prompt and was gone the
-- moment the turn ended, so a stored id pointed at nothing afterwards — which
-- is why the review card could only ever say "something speaks against this"
-- and never what that something was.
--
-- This column keeps a snapshot — { id, source, content } — for every id the
-- record cites, captured at the moment the id was linked. A snapshot on
-- purpose: it is a quote of what was weighed, not a live reference to a store
-- that may have moved on since.
--
-- Backward compatibility: existing rows keep '[]'. A record with citations but
-- no snapshot reads exactly as it did before, and the card falls back to its
-- plain note.
ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS evidence_items JSONB NOT NULL DEFAULT '[]'::jsonb;
