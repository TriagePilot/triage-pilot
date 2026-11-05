-- Operational selection provenance; immutable intents retain the pre-mutation observation.
ALTER TABLE reviewer_replacements
  ADD COLUMN selection_context JSONB,
  ADD CONSTRAINT reviewer_replacements_selection_context_object
    CHECK (selection_context IS NULL OR jsonb_typeof(selection_context) = 'object');

ALTER TABLE reviewer_mutation_intents
  ADD COLUMN selection_context JSONB,
  ADD CONSTRAINT reviewer_mutation_intents_selection_context_object
    CHECK (selection_context IS NULL OR jsonb_typeof(selection_context) = 'object');
