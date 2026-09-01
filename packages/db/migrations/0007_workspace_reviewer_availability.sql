create table workspace_operational_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  timezone text not null default 'UTC',
  updated_at timestamptz not null default now()
);

insert into workspace_operational_settings (workspace_id, timezone, updated_at)
select workspaces.id, organization_settings.timezone, organization_settings.updated_at
from workspaces
cross join organization_settings
where organization_settings.id = true;

drop table organization_settings;

alter table reviewer_absences drop constraint reviewer_absences_no_overlap;
drop index reviewer_absences_active_lookup;

alter table reviewer_absences
  add column workspace_id uuid,
  add column provider text,
  add column provider_connection_id uuid;

update reviewer_absences
set workspace_id = local_connection.workspace_id,
    provider = local_connection.provider,
    provider_connection_id = local_connection.id
from (
  select connections.id, connections.workspace_id, connections.provider
  from provider_connections connections
  join workspaces on workspaces.id = connections.workspace_id
  where workspaces.external_key = 'self-hosted'
    and connections.status = 'active'
  order by connections.created_at, connections.id
  limit 1
) local_connection;

alter table reviewer_absences rename column reviewer_handle to external_actor_id;
alter table reviewer_absences drop constraint reviewer_absences_normalized_handle;
alter table reviewer_absences alter column workspace_id set not null;
alter table reviewer_absences alter column provider set not null;
alter table reviewer_absences alter column provider_connection_id set not null;
alter table reviewer_absences
  add constraint reviewer_absences_workspace_fkey
  foreign key (workspace_id) references workspaces(id) on delete cascade;
alter table reviewer_absences
  add constraint reviewer_absences_workspace_provider_connection_fkey
  foreign key (workspace_id, provider, provider_connection_id)
  references provider_connections(workspace_id, provider, id) on delete cascade;
alter table reviewer_absences
  add constraint reviewer_absences_scoped_id_key
  unique (workspace_id, provider, provider_connection_id, id);
alter table reviewer_absences
  add constraint reviewer_absences_no_overlap exclude using gist (
    workspace_id with =,
    provider with =,
    provider_connection_id with =,
    external_actor_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status = 'scheduled');

create index reviewer_absences_active_lookup
  on reviewer_absences (
    workspace_id, provider, provider_connection_id, external_actor_id, start_at, end_at
  )
  where status = 'scheduled';

alter table reviewer_replacements
  add column workspace_id uuid,
  add column provider text,
  add column provider_connection_id uuid,
  add column state text not null default 'completed',
  add column last_error text;

update reviewer_replacements replacements
set workspace_id = absences.workspace_id,
    provider = absences.provider,
    provider_connection_id = absences.provider_connection_id
from reviewer_absences absences
where absences.id = replacements.absence_id;

alter table reviewer_replacements rename column unavailable_reviewer to unavailable_actor_id;
alter table reviewer_replacements rename column replacement_reviewer to replacement_actor_id;
alter table reviewer_replacements alter column workspace_id set not null;
alter table reviewer_replacements alter column provider set not null;
alter table reviewer_replacements alter column provider_connection_id set not null;
alter table reviewer_replacements drop constraint reviewer_replacements_absence_id_fkey;
alter table reviewer_replacements drop constraint reviewer_replacements_decision_id_fkey;
do $$
declare
  historical_source_key name;
begin
  select constraint_name into historical_source_key
  from information_schema.table_constraints
  where table_schema = 'public'
    and table_name = 'reviewer_replacements'
    and constraint_type = 'UNIQUE';
  execute format(
    'alter table reviewer_replacements drop constraint %I',
    historical_source_key
  );
end
$$;
alter table reviewer_replacements
  add constraint reviewer_replacements_workspace_fkey
  foreign key (workspace_id) references workspaces(id) on delete cascade;
alter table reviewer_replacements
  add constraint reviewer_replacements_workspace_provider_connection_fkey
  foreign key (workspace_id, provider, provider_connection_id)
  references provider_connections(workspace_id, provider, id) on delete cascade;
alter table reviewer_replacements
  add constraint reviewer_replacements_scoped_absence_fkey
  foreign key (workspace_id, provider, provider_connection_id, absence_id)
  references reviewer_absences(workspace_id, provider, provider_connection_id, id);
alter table reviewer_replacements
  add constraint reviewer_replacements_workspace_decision_fkey
  foreign key (workspace_id, decision_id)
  references routing_decisions(workspace_id, id) on delete cascade;
alter table reviewer_replacements
  add constraint reviewer_replacements_scoped_source_key
  unique (
    workspace_id, provider, provider_connection_id,
    absence_id, absence_revision, decision_id
  );
alter table reviewer_replacements
  add constraint reviewer_replacements_workspace_id_key
  unique (workspace_id, id);

drop index reviewer_replacements_absence_history;
create index reviewer_replacements_absence_history
  on reviewer_replacements (
    workspace_id, provider, provider_connection_id, absence_id, completed_at desc, id desc
  );

alter table routing_decisions add column change_request_id text;

update routing_decisions decisions
set change_request_id = outbox.payload ->> 'changeRequestId'
from decision_outbox outbox
where outbox.workspace_id = decisions.workspace_id
  and outbox.decision_id = decisions.id
  and outbox.schema_version = 1
  and jsonb_typeof(outbox.payload -> 'changeRequestId') = 'string'
  and length(outbox.payload ->> 'changeRequestId') > 0;

alter table decision_outbox
  add column event_id text,
  add column event_type text,
  add column reviewer_replacement_id uuid;

update decision_outbox
set event_id = coalesce(
      payload ->> 'eventId',
      'decision:' || decision_id::text || ':v' || schema_version::text
    ),
    event_type = coalesce(payload ->> 'eventType', 'routing_decision'),
    payload = payload || jsonb_build_object(
      'eventId', coalesce(
        payload ->> 'eventId',
        'decision:' || decision_id::text || ':v' || schema_version::text
      ),
      'eventType', coalesce(payload ->> 'eventType', 'routing_decision')
    );

alter table decision_outbox alter column event_id set not null;
alter table decision_outbox alter column event_type set not null;
alter table decision_outbox alter column decision_id drop not null;
alter table decision_outbox drop constraint decision_outbox_workspace_decision_fkey;
alter table decision_outbox drop constraint decision_outbox_workspace_decision_schema_key;
alter table decision_outbox
  add constraint decision_outbox_workspace_decision_fkey
  foreign key (workspace_id, decision_id)
  references routing_decisions(workspace_id, id) on delete cascade;
alter table decision_outbox
  add constraint decision_outbox_workspace_reviewer_replacement_fkey
  foreign key (workspace_id, reviewer_replacement_id)
  references reviewer_replacements(workspace_id, id) on delete cascade;
alter table decision_outbox
  add constraint decision_outbox_exactly_one_source
  check (num_nonnulls(decision_id, reviewer_replacement_id) = 1);
alter table decision_outbox
  add constraint decision_outbox_event_type_check
  check (event_type in ('routing_decision', 'reviewer_replacement'));
alter table decision_outbox
  add constraint decision_outbox_event_source_check
  check (
    num_nonnulls(decision_id, reviewer_replacement_id) <> 1 or
    (event_type = 'routing_decision' and decision_id is not null) or
    (event_type = 'reviewer_replacement' and reviewer_replacement_id is not null)
  );
alter table decision_outbox
  add constraint decision_outbox_workspace_event_key
  unique (workspace_id, event_id);
