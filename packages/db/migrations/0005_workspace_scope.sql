create table workspaces (
  id uuid primary key default gen_random_uuid(),
  external_key text not null unique,
  created_at timestamptz not null default now()
);

insert into workspaces (external_key) values ('self-hosted');

alter table installations rename to provider_connections;
alter table provider_connections add column workspace_id uuid;
alter table provider_connections add column provider text default 'github';
alter table provider_connections rename column github_installation_id to external_connection_id;
alter table provider_connections alter column external_connection_id type text using external_connection_id::text;
alter table provider_connections rename column account_login to workspace_login;

update provider_connections
set workspace_id = (select id from workspaces where external_key = 'self-hosted');

alter table provider_connections alter column workspace_id set not null;
alter table provider_connections alter column provider set not null;
alter table provider_connections alter column provider drop default;
alter table provider_connections
  add constraint provider_connections_workspace_fkey
  foreign key (workspace_id) references workspaces(id) on delete cascade;
alter table provider_connections
  add constraint provider_connections_workspace_id_key unique (workspace_id, id);
alter table provider_connections drop constraint installations_github_installation_id_key;
alter table provider_connections
  add constraint provider_connections_workspace_external_key
  unique (workspace_id, provider, external_connection_id);
drop index one_active_installation_idx;
create unique index one_active_provider_connection_idx
  on provider_connections (workspace_id, status) where status = 'active';

alter table repositories add column workspace_id uuid;
alter table repositories add column provider text default 'github';
alter table repositories rename column installation_id to provider_connection_id;
alter table repositories rename column github_repository_id to external_repository_id;
alter table repositories alter column external_repository_id type text using external_repository_id::text;

update repositories repositories
set workspace_id = provider_connections.workspace_id,
    provider = provider_connections.provider
from provider_connections
where provider_connections.id = repositories.provider_connection_id;

alter table repositories alter column workspace_id set not null;
alter table repositories alter column provider set not null;
alter table repositories alter column provider drop default;
alter table repositories drop constraint repositories_installation_id_fkey;
alter table repositories drop constraint repositories_github_repository_id_key;
alter table repositories
  add constraint repositories_workspace_fkey
  foreign key (workspace_id) references workspaces(id) on delete cascade;
alter table repositories
  add constraint repositories_workspace_provider_connection_fkey
  foreign key (workspace_id, provider_connection_id)
  references provider_connections(workspace_id, id) on delete cascade;
alter table repositories
  add constraint repositories_workspace_id_key unique (workspace_id, id);
alter table repositories
  add constraint repositories_workspace_provider_repository_key
  unique (workspace_id, provider, external_repository_id);

alter table webhook_receipts add column id uuid default gen_random_uuid();
alter table webhook_receipts add column workspace_id uuid;
alter table webhook_receipts add column provider text default 'github';
alter table webhook_receipts rename column installation_id to external_connection_id;
alter table webhook_receipts alter column external_connection_id type text using external_connection_id::text;

update webhook_receipts
set workspace_id = (select id from workspaces where external_key = 'self-hosted');

alter table webhook_receipts alter column id set not null;
alter table webhook_receipts alter column workspace_id set not null;
alter table webhook_receipts alter column provider set not null;
alter table webhook_receipts alter column provider drop default;
alter table webhook_receipts drop constraint webhook_receipts_pkey;
alter table webhook_receipts add constraint webhook_receipts_pkey primary key (id);
alter table webhook_receipts
  add constraint webhook_receipts_workspace_fkey
  foreign key (workspace_id) references workspaces(id) on delete cascade;
alter table webhook_receipts
  add constraint webhook_receipts_workspace_provider_delivery_key
  unique (workspace_id, provider, delivery_id);

alter table jobs add column workspace_id uuid;
alter table jobs add column provider text default 'github';
alter table jobs add column provider_connection_id uuid;

update jobs jobs
set workspace_id = (select id from workspaces where external_key = 'self-hosted'),
    provider = coalesce(jobs.payload -> 'changeRequest' -> 'repository' ->> 'provider', 'github'),
    provider_connection_id = provider_connections.id
from provider_connections
where provider_connections.workspace_id = (select id from workspaces where external_key = 'self-hosted')
  and provider_connections.external_connection_id = jobs.payload ->> 'providerConnectionId';

update jobs jobs
set workspace_id = (select id from workspaces where external_key = 'self-hosted'),
    provider = provider_connections.provider,
    provider_connection_id = provider_connections.id
from provider_connections
where jobs.provider_connection_id is null
  and provider_connections.workspace_id = (select id from workspaces where external_key = 'self-hosted')
  and provider_connections.id = (
    select candidate.id
    from provider_connections candidate
    where candidate.workspace_id = provider_connections.workspace_id
    order by (candidate.status = 'active') desc, candidate.created_at, candidate.id
    limit 1
  );

insert into provider_connections (
  workspace_id, provider, external_connection_id, workspace_login, account_type, status, permissions
)
select workspaces.id, 'github', 'legacy', 'self-hosted', 'Organization', 'active', '{}'::jsonb
from workspaces
where workspaces.external_key = 'self-hosted'
  and exists (select 1 from jobs where provider_connection_id is null)
  and not exists (
    select 1 from provider_connections where provider_connections.workspace_id = workspaces.id
  );

update jobs jobs
set workspace_id = provider_connections.workspace_id,
    provider = provider_connections.provider,
    provider_connection_id = provider_connections.id
from provider_connections
where jobs.provider_connection_id is null
  and provider_connections.external_connection_id = 'legacy';

alter table jobs alter column workspace_id set not null;
alter table jobs alter column provider set not null;
alter table jobs alter column provider drop default;
alter table jobs alter column provider_connection_id set not null;
alter table jobs drop constraint jobs_idempotency_key_key;
alter table jobs
  add constraint jobs_workspace_fkey
  foreign key (workspace_id) references workspaces(id) on delete cascade;
alter table jobs
  add constraint jobs_workspace_provider_connection_fkey
  foreign key (workspace_id, provider_connection_id)
  references provider_connections(workspace_id, id) on delete cascade;
alter table jobs
  add constraint jobs_workspace_id_key unique (workspace_id, id);
alter table jobs
  add constraint jobs_workspace_idempotency_key unique (workspace_id, idempotency_key);

alter table routing_decisions add column workspace_id uuid;
alter table routing_decisions add column organization_config_version text;
alter table routing_decisions add column repository_config_path text;
alter table routing_decisions add column repository_config_revision text;
alter table routing_decisions add column effective_config_hash text;
alter table routing_decisions add column inheritance_mode text;
alter table routing_decisions add column config_diagnostics jsonb not null default '[]'::jsonb;
alter table routing_decisions add column config_sources jsonb not null default '{}'::jsonb;

update routing_decisions decisions
set workspace_id = coalesce(
      repositories.workspace_id,
      (select id from workspaces where external_key = 'self-hosted')
    ),
    effective_config_hash = encode(digest(decisions.details::text, 'sha256'), 'hex'),
    inheritance_mode = 'legacy'
from repositories
where repositories.id = decisions.repository_id;

update routing_decisions decisions
set workspace_id = (select id from workspaces where external_key = 'self-hosted'),
    effective_config_hash = encode(digest(decisions.details::text, 'sha256'), 'hex'),
    inheritance_mode = 'legacy'
where decisions.workspace_id is null;

alter table routing_decisions alter column workspace_id set not null;
alter table routing_decisions alter column effective_config_hash set not null;
alter table routing_decisions alter column inheritance_mode set not null;
alter table routing_decisions
  add constraint routing_decisions_inheritance_mode_check
  check (inheritance_mode in ('legacy', 'defaults', 'organization', 'replace', 'inherit'));
alter table routing_decisions drop constraint routing_decisions_repository_id_fkey;
alter table routing_decisions
  add constraint routing_decisions_workspace_fkey
  foreign key (workspace_id) references workspaces(id) on delete cascade;
alter table routing_decisions
  add constraint routing_decisions_workspace_repository_fkey
  foreign key (workspace_id, repository_id)
  references repositories(workspace_id, id) on delete set null (repository_id);
alter table routing_decisions
  add constraint routing_decisions_workspace_id_key unique (workspace_id, id);
drop index routing_decisions_delivery_idx;
create unique index routing_decisions_workspace_delivery_idx
  on routing_decisions (workspace_id, delivery_id);
drop index routing_decisions_routing_key_idx;
create unique index routing_decisions_workspace_routing_key_idx
  on routing_decisions (workspace_id, routing_key);
