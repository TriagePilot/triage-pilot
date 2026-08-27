create extension if not exists btree_gist;

create table organization_settings (
  id boolean primary key default true check (id),
  timezone text not null default 'UTC',
  updated_at timestamptz not null default now()
);

insert into organization_settings (id, timezone) values (true, 'UTC');

create table reviewer_absences (
  id uuid primary key default gen_random_uuid(),
  reviewer_handle text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'cancelled')),
  revision integer not null default 1 check (revision > 0),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reviewer_absences_normalized_handle
    check (reviewer_handle = lower(reviewer_handle) and reviewer_handle ~ '^@[a-z0-9_.-]+$'),
  constraint reviewer_absences_valid_interval check (end_at > start_at),
  constraint reviewer_absences_cancelled_at check (
    (status = 'scheduled' and cancelled_at is null) or
    (status = 'cancelled' and cancelled_at is not null)
  ),
  constraint reviewer_absences_no_overlap exclude using gist (
    reviewer_handle with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status = 'scheduled')
);

create index reviewer_absences_active_lookup
  on reviewer_absences (reviewer_handle, start_at, end_at)
  where status = 'scheduled';

create table reviewer_replacements (
  id uuid primary key default gen_random_uuid(),
  absence_id uuid not null references reviewer_absences(id),
  absence_revision integer not null check (absence_revision > 0),
  decision_id uuid not null references routing_decisions(id) on delete cascade,
  unavailable_reviewer text not null,
  replacement_reviewer text,
  outcome text not null check (outcome in (
    'replaced', 'simulated_replacement', 'no_replacement_available',
    'skipped_approved', 'skipped_closed', 'skipped_changed_head',
    'skipped_policy_satisfied', 'permanent_failure'
  )),
  reason text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  unique (absence_id, absence_revision, decision_id)
);

create index reviewer_replacements_absence_history
  on reviewer_replacements (absence_id, completed_at desc, id desc);
