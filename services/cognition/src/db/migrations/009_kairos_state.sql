-- Kairos worker watermark — the cursor up to which raw Foundation observations
-- (episode.captured_at) have been folded into Kairos episodes for a bank.
-- Mirrors Foundation's reflection_progress idiom (server/
-- hypothesisReflectionSync.js): the cursor only ever advances to the last
-- SUCCESSFULLY processed observation, so a transient LLM failure loses no
-- observation. System time (captured_at) is the cursor axis because that is
-- what Foundation's read seam (GET /api/memory/episodes?since=) filters on.
CREATE TABLE IF NOT EXISTS kairos_state (
    bank_id             TEXT        PRIMARY KEY,
    last_captured_at    TIMESTAMPTZ NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
