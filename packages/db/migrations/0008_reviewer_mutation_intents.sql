create table reviewer_mutation_intents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null,
  provider_connection_id uuid not null,
  absence_id uuid not null,
  absence_revision integer not null check (absence_revision > 0),
  decision_id uuid not null,
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
    foreign key (workspace_id, decision_id)
    references routing_decisions(workspace_id, id) on delete cascade,
  constraint reviewer_mutation_intents_workspace_repository_fkey
    foreign key (workspace_id, provider, repository_id)
    references repositories(workspace_id, provider, external_repository_id),
  constraint reviewer_mutation_intents_source_key
    unique (workspace_id, provider_connection_id, absence_id, absence_revision, decision_id),
  constraint reviewer_mutation_intents_link_key
    unique (
      workspace_id, provider, provider_connection_id,
      absence_id, absence_revision, decision_id, id
    )
);

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
