-- Kairos episodes gain a short, human-readable `title` next to `summary`.
--
-- Why: the card headed each episode with the app name (primary_app), because
-- that was the only short label the synthesizer produced — "Chrome" as a
-- heading says nothing. `title` is the one-line statement of what happened
-- ("Offerte versturen naar Bas"), while `summary` keeps the longer narrative.
--
-- Like summary, it is derived text (epistemic_status is still 'interpretation')
-- and it defaults to '' so an episode written by an older synthesizer, or one
-- where the model omitted a title, stays valid — the client falls back to
-- primary_app. Empty is honest; never guess a title here.
ALTER TABLE kairos_episodes
    ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
