CREATE TABLE IF NOT EXISTS hypotheses (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_id             TEXT        NOT NULL,
    statement           TEXT        NOT NULL,
    confidence          REAL        NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    status              TEXT        NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed', 'testing', 'confirmed', 'rejected')),
    verification_plan   TEXT        NOT NULL DEFAULT '',
    evidence_memory_ids TEXT[]      NOT NULL DEFAULT '{}',
    -- Hindsight's retain endpoint never returns the created memory unit's
    -- ID (sync or async) — only success/counts. We set our own document_id
    -- on retain instead, and store that; it's queryable via Hindsight's
    -- /documents/{document_id} endpoints, unlike a memory unit ID we never get.
    confirmed_document_id TEXT      NULL,
    rejection_reason    TEXT        NULL,
    tested_at           TIMESTAMPTZ NULL,
    confirmed_at        TIMESTAMPTZ NULL,
    rejected_at         TIMESTAMPTZ NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS hypotheses_bank_id_status_idx ON hypotheses (bank_id, status) WHERE deleted_at IS NULL;
