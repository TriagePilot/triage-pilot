alter table routing_decisions
  add column selected_reviewers jsonb not null default '[]'::jsonb,
  add constraint routing_decisions_selected_reviewers_array
    check (jsonb_typeof(selected_reviewers) = 'array'),
  add constraint routing_decisions_selected_reviewers_limit
    check (jsonb_array_length(selected_reviewers) <= 2);

update routing_decisions
set selected_reviewers = jsonb_build_array(selected_reviewer)
where selected_reviewer is not null;
