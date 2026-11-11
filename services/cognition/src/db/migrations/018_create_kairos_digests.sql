-- Kairos day digests — one generated overview per bank per closed day.
--
-- Why a table and not a computed view: the digest is the output of a model
-- call (services/gaia-api/src/kairos/digest.js), and recomputing it on every
-- page load would spend tokens for text that does not change once the day is
-- closed. Storing it also gives the Command Center something stable to show
-- and keeps the day's summary even after individual episodes are re-synthesized.
--
-- Like kairos_episodes this is DERIVED text, never a raw record: the digest
-- names the episodes it was built from (`episode_ids`) so a reader can walk
-- back from the overview to the episodes, and from there to Foundation.
--
-- `digest_date` is TEXT (YYYY-MM-DD), not DATE: the day is a *calendar* day in
-- `timezone`, and the pg driver turns DATE into a JS Date at local midnight,
-- which silently shifts the day by one for negative offsets. An ISO string
-- sorts correctly and cannot be reinterpreted.
CREATE TABLE IF NOT EXISTS kairos_digests (
    id              TEXT        NOT NULL,
    bank_id         TEXT        NOT NULL,
    digest_date     TEXT        NOT NULL
                      CHECK (digest_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    timezone        TEXT        NOT NULL DEFAULT 'Europe/Amsterdam',
    title           TEXT        NOT NULL DEFAULT '',
    summary         TEXT        NOT NULL,
    episode_count   INTEGER     NOT NULL DEFAULT 0,
    episode_ids     TEXT[]      NOT NULL DEFAULT '{}',
    apps            TEXT[]      NOT NULL DEFAULT '{}',
    model           TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bank_id, digest_date)
);

CREATE INDEX IF NOT EXISTS kairos_digests_bank_date_idx
    ON kairos_digests (bank_id, digest_date DESC);
