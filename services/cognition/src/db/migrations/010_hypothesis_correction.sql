-- A human correction: the person says what is true instead of what was
-- recorded.
--
-- The corrected wording IS their verdict, so it needs no column of its own —
-- the statement carries it and status/confirmed_at tell the rest. The "why"
-- does: rejection_reason belongs to rejections, and the sources jsonb has its
-- own contract, so the correction gets its own pair of fields. corrected_at is
-- separate from confirmed_at so the record still shows the difference between
-- "settled once" and "settled differently afterwards" — the mirror in
-- reasoning/cognitionSync.js retires the superseded wording on exactly that.
ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS correction_reason TEXT,
  ADD COLUMN IF NOT EXISTS corrected_at      TIMESTAMPTZ;
