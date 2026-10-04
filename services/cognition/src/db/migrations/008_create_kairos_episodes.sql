-- Kairos episodes — Gaia's NARRATIVE synthesis of a cluster of raw
-- observations. This is deliberately NOT Foundation's `episode` table: that
-- table holds a frozen RAW observation (epistemic status "observation"). A
-- Kairos episode is a DERIVED statement about a span of observations and is
-- therefore always epistemic_status 'interpretation'. The name is kept
-- distinct (kairos_episode) so the two can never be confused in code or
-- conversation.
--
-- `sources` is provenance back to the raw records, in the house convention
-- (['chronicle:<ingest_object-id>']) — mirrors patterns.sources / hypotheses
-- .sources. The id is assigned by the writer (Kairos worker) so re-processing
-- the same cluster is an idempotent upsert, not a duplicate row.
CREATE TABLE IF NOT EXISTS kairos_episodes (
    id                  TEXT        NOT NULL,
    bank_id             TEXT        NOT NULL,
    start_time          TIMESTAMPTZ NOT NULL,
    end_time            TIMESTAMPTZ NOT NULL,
    summary             TEXT        NOT NULL,
    primary_app         TEXT        NOT NULL DEFAULT '',
    involved_apps       TEXT[]      NOT NULL DEFAULT '{}',
    epistemic_status    TEXT        NOT NULL DEFAULT 'interpretation'
                          CHECK (epistemic_status = 'interpretation'),
    sources             TEXT[]      NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bank_id, id)
);

CREATE INDEX IF NOT EXISTS kairos_episodes_bank_start_idx
    ON kairos_episodes (bank_id, start_time DESC);
