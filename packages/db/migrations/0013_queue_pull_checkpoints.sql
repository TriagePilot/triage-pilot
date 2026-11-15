-- Multi-page provider reads survive worker turns without holding a lease open.
alter table queue_pull_work add column checkpoint jsonb;

-- Membership is scoped to a single run and only used after a repository's last page.
create table queue_sync_scan_members (
  run_id uuid not null references queue_sync_runs(id) on delete cascade,
  repository_id uuid not null,
  external_repository_id text not null,
  pull_number integer not null check (pull_number >= 0),
  primary key (run_id, repository_id, external_repository_id, pull_number)
);

-- Capture repository selection changes across a provider read, including changes
-- made outside the reconciliation process.
alter table provider_connections add column queue_selection_revision bigint not null default 0;
create function bump_queue_selection_revision() returns trigger language plpgsql as $$
begin
  if current_setting('triage.queue_scan_materialization', true) = '1' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and (old.workspace_id, old.provider_connection_id, old.external_repository_id, old.provider, old.owner, old.name)
      is not distinct from (new.workspace_id, new.provider_connection_id, new.external_repository_id, new.provider, new.owner, new.name) then
    return new;
  end if;
  if tg_op <> 'INSERT' then
    update provider_connections set queue_selection_revision = queue_selection_revision + 1
      where workspace_id = old.workspace_id and id = old.provider_connection_id;
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or (old.workspace_id, old.provider_connection_id) is distinct from (new.workspace_id, new.provider_connection_id)) then
    update provider_connections set queue_selection_revision = queue_selection_revision + 1
      where workspace_id = new.workspace_id and id = new.provider_connection_id;
  end if;
  return coalesce(new, old);
end $$;
create trigger repositories_queue_selection_revision after insert or update or delete on repositories
  for each row execute function bump_queue_selection_revision();

-- A complete scan must cover a single, unchanged repository selection.
alter table queue_sync_runs add column selection_revision bigint not null default 0;
