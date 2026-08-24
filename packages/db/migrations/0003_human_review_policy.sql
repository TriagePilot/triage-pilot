alter table routing_decisions
  add column pull_number integer,
  add column head_sha text,
  add column policy_check_run_id bigint,
  add column policy_check_state text not null default 'not_started',
  add constraint routing_decisions_policy_check_state
    check (policy_check_state in ('not_started', 'in_progress', 'success', 'failure'));

create index routing_decisions_human_review_policy_lookup
  on routing_decisions (repository_id, pull_number, created_at desc);
