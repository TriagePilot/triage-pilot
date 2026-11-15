create table queue_sync_schedule (
  workspace_id uuid not null,
  provider_connection_id uuid not null,
  external_installation_id text not null,
  next_due timestamptz not null,
  selection_revision bigint not null,
  last_manual timestamptz,
  primary key (workspace_id, provider_connection_id, external_installation_id)
);
