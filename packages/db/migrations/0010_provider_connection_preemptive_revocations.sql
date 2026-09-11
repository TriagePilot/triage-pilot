alter table provider_connection_revocations
  add column physical_connection_id uuid;

update provider_connection_revocations
set physical_connection_id = revoked_connection_id;

alter table provider_connection_revocations
  alter column revoked_connection_id set default gen_random_uuid();

create unique index provider_connection_revocations_physical_key
  on provider_connection_revocations (workspace_id, provider, physical_connection_id)
  where physical_connection_id is not null;
