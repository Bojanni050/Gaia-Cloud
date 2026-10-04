-- Route Logos's open questions and relationships through Cognition too, as
-- first-class derived kinds (observations go to Foundation instead).
ALTER TABLE hypotheses DROP CONSTRAINT IF EXISTS hypotheses_kind_check;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_kind_check
  CHECK (kind IN ('hypothesis', 'mental_model', 'relationship', 'open_question'));
