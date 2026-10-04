CREATE TABLE IF NOT EXISTS patterns (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_id           TEXT        NOT NULL,
    content           TEXT        NOT NULL,
    confidence        REAL        NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    coherence_score   REAL        NOT NULL DEFAULT 0.0,
    source_memory_ids TEXT[]      NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS patterns_bank_id_idx ON patterns (bank_id) WHERE deleted_at IS NULL;
