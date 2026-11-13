create table deferred_pull_request_deliveries (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null,
  delivery_id text not null,
  provider_connection_id uuid not null references provider_connections(id) on delete cascade,
  external_installation_id text not null,
  external_repository_id text not null,
  input jsonb not null,
  dispatch_epoch integer not null default 0,
  dispatch_job_id uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, provider, delivery_id)
);
create index deferred_pull_request_scope_idx on deferred_pull_request_deliveries
  (workspace_id, provider_connection_id, external_installation_id, external_repository_id);
