-- Observations: what the machine saw in one conversation, with the exact
-- evidence it stood on, waiting to be aggregated.
--
-- Why this is not a hypothesis. A hypothesis born inside one turn is a claim
-- derived from one recall slice: 206 of them in a month, 206 distinct wordings,
-- zero of which ever came back. A belief is not the output of one moment; it is
-- what survives several. So the per-turn phase now leaves its raw material here
-- — small, evidence-linked, disposable — and a periodic pass forms a statement
-- only when the SAME underlying evidence (sourceRef) shows up in more than one
-- conversation. `consumed_by_id` records which statement an observation fed, so
-- nothing is aggregated twice.
--
-- Why here and not Foundation. Foundation already receives the unlinked record
-- (source 'gaia-observation'); this is the working set for aggregation: the same
-- observation, but carrying the assembled evidence it stood on, so it can be
-- grouped by what it was ABOUT rather than by how the sentence was worded.
-- Cognition stays storage-only — this table has no lifecycle, no status and no
-- mirror to Hindsight.
CREATE TABLE IF NOT EXISTS observations (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_id          TEXT        NOT NULL,
    statement        TEXT        NOT NULL,
    evidence_items   JSONB       NOT NULL DEFAULT '[]'::jsonb,
    conversation_id  TEXT        NULL,
    observed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_by_id   UUID        NULL REFERENCES hypotheses(id) ON DELETE SET NULL,
    consumed_at      TIMESTAMPTZ NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The pass reads unconsumed observations, newest first, per bank.
CREATE INDEX IF NOT EXISTS observations_open_idx
  ON observations (bank_id, observed_at DESC)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS observations_conversation_idx
  ON observations (bank_id, conversation_id);
