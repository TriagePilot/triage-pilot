-- Immutable provider identifiers fence data from in-place connection replacement.
alter table jobs add column external_installation_id text;
alter table jobs add column external_repository_id text;
alter table routing_decisions add column origin_provider_connection_id uuid;
alter table routing_decisions add column origin_external_installation_id text;
alter table routing_decisions add column origin_external_repository_id text;

-- A receipt supplies the external installation identity, while the immutable job
-- payload supplies the external repository identity. Do not infer either from a
-- connection or repository row, which can have been reassigned since ingestion.
update jobs j set external_installation_id = receipt.external_connection_id,
  external_repository_id = j.payload -> 'changeRequest' -> 'repository' ->> 'externalId'
from webhook_receipts receipt
where j.kind in ('process_pull_request', 'evaluate_human_review_policy')
  and receipt.workspace_id = j.workspace_id and receipt.provider = j.provider
  and receipt.delivery_id = j.payload ->> 'deliveryId'
  and receipt.created_at <= j.created_at
  and receipt.external_connection_id is not null
  and j.payload -> 'changeRequest' -> 'repository' ->> 'externalId' is not null;
-- Unknown legacy policy work must not remain queued indefinitely or adopt a new installation.
update jobs set status = 'failed', locked_at = null, locked_by = null,
  last_error = 'legacy policy job lacks immutable installation or repository provenance', updated_at = now()
where kind = 'evaluate_human_review_policy' and status in ('queued', 'running')
  and (external_installation_id is null or external_repository_id is null);
-- Unknown routing jobs likewise cannot safely run under a replacement installation.
update jobs set status = 'failed', locked_at = null, locked_by = null,
  last_error = 'legacy routing job lacks immutable installation or repository provenance', updated_at = now()
where kind = 'process_pull_request' and status in ('queued', 'running')
  and (external_installation_id is null or external_repository_id is null);
update routing_decisions d set origin_provider_connection_id = j.provider_connection_id,
  origin_external_installation_id = j.external_installation_id,
  origin_external_repository_id = j.external_repository_id
from jobs j
where j.workspace_id = d.workspace_id and j.kind = 'process_pull_request'
  and j.idempotency_key = d.routing_key and j.created_at <= d.created_at
  and j.external_installation_id is not null and j.external_repository_id is not null;

create table queue_pull_work (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider_connection_id uuid not null,
  external_installation_id text not null,
  repository_id uuid not null,
  external_repository_id text not null,
  pull_number integer not null check (pull_number > 0),
  desired_generation integer not null default 0,
  applied_generation integer not null default 0,
  snapshot_revision integer not null default 0,
  dispatch_epoch integer not null default 0,
  dispatch_job_id uuid references jobs(id) on delete set null,
  snapshot jsonb,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, provider_connection_id, external_installation_id, repository_id, external_repository_id, pull_number)
);
create index queue_pull_work_scope_idx on queue_pull_work (workspace_id, provider_connection_id, external_installation_id);
create table queue_sync_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider_connection_id uuid not null,
  external_installation_id text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  checkpoint jsonb not null default '{}'::jsonb,
  checkpoint_repository_id uuid,
  checkpoint_external_repository_id text,
  revision integer not null default 0,
  dispatch_epoch integer not null default 1,
  dispatch_job_id uuid references jobs(id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index queue_sync_runs_active_idx on queue_sync_runs (workspace_id, provider_connection_id, external_installation_id) where status in ('queued', 'running');
create index queue_sync_runs_scope_idx on queue_sync_runs (workspace_id, provider_connection_id, external_installation_id, status);
