-- A run is verified only after inventory and all resulting PR work have settled.
alter table queue_sync_runs add column membership_complete boolean not null default false;
alter table queue_sync_runs add column classification_complete boolean not null default false;
alter table queue_sync_runs add column verified_at timestamptz;
alter table queue_sync_scan_members add column missing boolean not null default false;
alter table queue_sync_runs add column verification_error text;
