-- Recall ground for observations: a second, recall-derived way for two
-- observations to share ground.
--
-- The formation pass grouped observations on evidence_items[].sourceRef alone,
-- which only Hindsight recall results carry. An observation that stood on a
-- mental model, an upload, a conversation turn or a tool result had no
-- store-side identity, so it could never aggregate. This column holds the
-- Hindsight memory-unit ids a recall of the observation's statement returned
-- ("what does the store already say that is like this") — derived ground,
-- merged idempotently, so a repeated pass adds nothing new.
--
-- NULL means "no recall pass has run (yet)" — an honest unknown, not a
-- negative answer. The formation pass treats NULL and '[]' the same: no
-- recall-derived ground. Only a populated list can connect observations.
ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS recall_ground TEXT[] NULL;
