create table decision_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  decision_id uuid not null,
  schema_version integer not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  available_at timestamptz not null default now(),
  published_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  constraint decision_outbox_workspace_fkey
    foreign key (workspace_id) references workspaces(id) on delete cascade,
  constraint decision_outbox_workspace_decision_fkey
    foreign key (workspace_id, decision_id)
    references routing_decisions(workspace_id, id) on delete cascade,
  constraint decision_outbox_workspace_decision_schema_key
    unique (workspace_id, decision_id, schema_version),
  constraint decision_outbox_attempt_count_check check (attempt_count >= 0)
);

create index decision_outbox_claim_idx
  on decision_outbox (available_at, occurred_at)
  where published_at is null;
