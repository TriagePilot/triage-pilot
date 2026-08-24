create extension if not exists pgcrypto;

create table installations (
  id uuid primary key default gen_random_uuid(),
  github_installation_id bigint unique not null,
  account_login text not null,
  account_type text not null,
  status text not null,
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index one_active_installation_idx on installations (status) where status = 'active';

create table repositories (
  id uuid primary key default gen_random_uuid(),
  installation_id uuid not null references installations(id) on delete cascade,
  github_repository_id bigint unique not null,
  owner text not null,
  name text not null,
  default_branch text,
  config_state text not null default 'unknown',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_config_mode text not null default 'shadow' check (last_config_mode in ('shadow', 'enforce'))
);

create table webhook_receipts (
  delivery_id text primary key,
  event_name text not null,
  installation_id bigint,
  payload_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  payload jsonb not null,
  idempotency_key text not null unique,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_claim_idx on jobs (status, run_at) where status = 'queued';

create table routing_decisions (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid references repositories(id) on delete set null,
  delivery_id text not null,
  action text not null,
  risk_score integer not null,
  selected_reviewer text,
  no_human_reason text,
  details jsonb not null,
  created_at timestamptz not null default now(),
  mode text not null default 'shadow' check (mode in ('shadow', 'enforce')),
  action_status text not null default 'not_applied'
    check (action_status in ('not_applied', 'pending', 'succeeded', 'failed')),
  action_error text,
  action_applied_at timestamptz,
  action_failed_at timestamptz
);

create unique index routing_decisions_delivery_idx on routing_decisions (delivery_id);

create table worker_heartbeat (
  id boolean primary key default true check (id),
  worker_id text not null,
  heartbeat_at timestamptz not null
);
