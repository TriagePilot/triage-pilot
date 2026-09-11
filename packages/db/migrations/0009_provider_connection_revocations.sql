alter table provider_connections
  add constraint provider_connections_status_check
  check (status in ('active', 'suspended', 'revoked')) not valid;

create table provider_connection_revocations (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null,
  external_connection_id text not null,
  revoked_connection_id uuid not null,
  revoked_at timestamptz not null,
  cleanup_completed_at timestamptz,
  primary key (workspace_id, provider, revoked_connection_id),
  unique (workspace_id, provider, external_connection_id)
);

create index provider_connection_revocations_cleanup_idx
  on provider_connection_revocations (workspace_id, revoked_at, revoked_connection_id)
  where cleanup_completed_at is null;
