-- Terugkomen op een open vraag: hoe vaak Gaia hem zelf op tafel legde.
--
-- v1.4: een open vraag wordt geïdentificeerd en bewaard, maar nooit door Gaia
-- gesteld ("unresolved questions — identified, never asked here"). Zodra ze er
-- wél op terug mag komen, moet dat telbaar zijn — anders zeurt ze of herhaalt
-- ze zich eindeloos:
--
--   raised_count — hoe vaak ZIJ deze vraag zelf op tafel legde (hard maximum 3);
--   raised_at    — wanneer voor het laatst, zodat een nieuwe poging pas na een
--                  periode stilte volgt.
--
-- De mens sluit de vraag af (`answer` + `answered_at`); deze twee kolommen
-- vertellen alleen wat zíj deed. Cognition blijft opslag: het stampt de telling
-- die Logos hem geeft.

ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS raised_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS raised_at TIMESTAMPTZ NULL;

-- De opzoekquery van de heropenlus: onbeantwoorde open vragen die hun maximum
-- nog niet bereikt hebben, oudste stilte eerst.
CREATE INDEX IF NOT EXISTS hypotheses_open_question_raise_idx
  ON hypotheses (bank_id, raised_count, raised_at)
  WHERE kind = 'open_question' AND answered_at IS NULL AND deleted_at IS NULL;
