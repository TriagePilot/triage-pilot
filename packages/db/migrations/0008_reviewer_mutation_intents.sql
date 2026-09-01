alter table repositories
  add constraint repositories_mutation_intent_source_key
  unique (workspace_id, provider, provider_connection_id, id, external_repository_id);

alter table routing_decisions
  add constraint routing_decisions_mutation_intent_source_key
  unique (workspace_id, id, repository_id);

create table reviewer_mutation_intents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null,
  provider_connection_id uuid not null,
  absence_id uuid not null,
  absence_revision integer not null check (absence_revision > 0),
  decision_id uuid not null,
  repository_record_id uuid not null,
  repository_id text not null check (length(btrim(repository_id)) > 0),
  change_request_id text not null check (length(btrim(change_request_id)) > 0),
  expected_head_revision text not null check (length(btrim(expected_head_revision)) > 0),
  unavailable_actor_id text not null check (length(btrim(unavailable_actor_id)) > 0),
  replacement_actor_id text not null check (length(btrim(replacement_actor_id)) > 0),
  created_at timestamptz not null default now(),
  constraint reviewer_mutation_intents_workspace_provider_connection_fkey
    foreign key (workspace_id, provider, provider_connection_id)
    references provider_connections(workspace_id, provider, id) on delete cascade,
  constraint reviewer_mutation_intents_scoped_absence_fkey
    foreign key (workspace_id, provider, provider_connection_id, absence_id)
    references reviewer_absences(workspace_id, provider, provider_connection_id, id),
  constraint reviewer_mutation_intents_workspace_decision_fkey
    foreign key (workspace_id, decision_id, repository_record_id)
    references routing_decisions(workspace_id, id, repository_id),
  constraint reviewer_mutation_intents_scoped_repository_fkey
    foreign key (workspace_id, provider, provider_connection_id, repository_record_id, repository_id)
    references repositories(workspace_id, provider, provider_connection_id, id, external_repository_id),
  constraint reviewer_mutation_intents_source_key
    unique (workspace_id, provider_connection_id, absence_id, absence_revision, decision_id),
  constraint reviewer_mutation_intents_link_key
    unique (
      workspace_id, provider, provider_connection_id,
      absence_id, absence_revision, decision_id, id
    )
);

create function validate_reviewer_mutation_intent_insert() returns trigger
language plpgsql as $$
declare
  current_revision integer;
begin
  select revision into current_revision
  from reviewer_absences
  where workspace_id = new.workspace_id
    and provider = new.provider
    and provider_connection_id = new.provider_connection_id
    and id = new.absence_id
  for update;
  if current_revision is null or current_revision <> new.absence_revision then
    raise exception 'reviewer mutation intent absence revision is not current';
  end if;
  return new;
end;
$$;

create trigger reviewer_mutation_intents_validate_insert
before insert on reviewer_mutation_intents
for each row execute function validate_reviewer_mutation_intent_insert();

create function reject_reviewer_mutation_intent_update() returns trigger
language plpgsql as $$
begin
  raise exception 'reviewer mutation intents are immutable';
end;
$$;

create trigger reviewer_mutation_intents_reject_update
before update on reviewer_mutation_intents
for each row execute function reject_reviewer_mutation_intent_update();

alter table reviewer_replacements add column mutation_intent_id uuid;
alter table reviewer_replacements
  add constraint reviewer_replacements_mutation_intent_fkey
  foreign key (
    workspace_id, provider, provider_connection_id,
    absence_id, absence_revision, decision_id, mutation_intent_id
  ) references reviewer_mutation_intents (
    workspace_id, provider, provider_connection_id,
    absence_id, absence_revision, decision_id, id
  );
alter table reviewer_replacements
  add constraint reviewer_replacements_replaced_intent_check
  check (outcome <> 'replaced' or mutation_intent_id is not null) not valid;

alter table reviewer_replacements
  add constraint reviewer_replacements_state_outcome_check
  check (
    (state = 'finalizer_pending'
      and outcome in ('replaced', 'skipped_policy_satisfied', 'no_replacement_available')
      and last_error is null)
    or (state = 'completed' and outcome <> 'permanent_failure' and last_error is null)
    or (state = 'permanent_failure'
      and last_error is not null and length(btrim(last_error)) > 0)
  ) not valid;

create function validate_reviewer_replacement_insert() returns trigger
language plpgsql as $$
begin
  if new.outcome = 'permanent_failure' then
    if new.state <> 'permanent_failure' or new.last_error is null or length(btrim(new.last_error)) = 0 then
      raise exception 'permanent reviewer failure requires permanent_failure state and error';
    end if;
  elsif new.outcome in ('replaced', 'skipped_policy_satisfied', 'no_replacement_available') then
    if new.state <> 'finalizer_pending' or new.last_error is not null then
      raise exception 'mapped reviewer finalizer outcome requires finalizer_pending state';
    end if;
  elsif new.state <> 'completed' or new.last_error is not null then
    raise exception 'reviewer outcome without finalizer requires completed state';
  end if;
  return new;
end;
$$;

create trigger reviewer_replacements_validate_insert
before insert on reviewer_replacements
for each row execute function validate_reviewer_replacement_insert();

create function validate_reviewer_replacement_update() returns trigger
language plpgsql as $$
begin
  if (new.id, new.workspace_id, new.provider, new.provider_connection_id,
      new.absence_id, new.absence_revision, new.decision_id,
      new.unavailable_actor_id, new.replacement_actor_id, new.mutation_intent_id,
      new.outcome, new.reason, new.started_at, new.completed_at)
    is distinct from
     (old.id, old.workspace_id, old.provider, old.provider_connection_id,
      old.absence_id, old.absence_revision, old.decision_id,
      old.unavailable_actor_id, old.replacement_actor_id, old.mutation_intent_id,
      old.outcome, old.reason, old.started_at, old.completed_at) then
    raise exception 'reviewer replacement provenance is immutable';
  end if;
  if old.state <> 'finalizer_pending' then
    raise exception 'terminal reviewer replacement is immutable';
  end if;
  if new.state = 'completed' then
    if new.outcome = 'permanent_failure' or new.last_error is not null then
      raise exception 'completed reviewer replacement state is malformed';
    end if;
  elsif new.state = 'permanent_failure' then
    if new.last_error is null or length(btrim(new.last_error)) = 0 then
      raise exception 'permanent reviewer replacement state requires an error';
    end if;
  else
    raise exception 'reviewer replacement may only leave finalizer_pending';
  end if;
  return new;
end;
$$;

create trigger reviewer_replacements_validate_update
before update on reviewer_replacements
for each row execute function validate_reviewer_replacement_update();
