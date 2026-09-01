import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";
import type {
  ActionStatus,
  PlatformEventV1,
  ProviderKind,
  RepositoryMode,
  ReviewerReplacementOutcome,
} from "@triagepilot/contracts";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, unknown, unknown>;
type NullableBigInt = ColumnType<string | null, string | null, string | null>;
type NullableString = ColumnType<string | null, string | null | undefined, string | null>;
type HumanReviewPolicyCheckState = "not_started" | "in_progress" | "success" | "failure";
type InheritanceMode = "legacy" | "defaults" | "organization" | "replace" | "inherit";

export interface WorkspacesTable {
  id: Generated<string>;
  external_key: string;
  created_at: Timestamp;
}

export interface ProviderConnectionsTable {
  id: Generated<string>;
  workspace_id: string;
  provider: ProviderKind;
  external_connection_id: string;
  workspace_login: string;
  account_type: string;
  status: string;
  permissions: Json;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RepositoriesTable {
  id: Generated<string>;
  workspace_id: string;
  provider: ProviderKind;
  provider_connection_id: string;
  external_repository_id: string;
  owner: string;
  name: string;
  default_branch: string | null;
  config_state: string;
  last_config_mode: Generated<RepositoryMode>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WebhookReceiptsTable {
  id: Generated<string>;
  workspace_id: string;
  provider: ProviderKind;
  delivery_id: string;
  event_name: string;
  event_action: string | null;
  hook_id: string | null;
  external_connection_id: string | null;
  payload_summary: Json;
  created_at: Timestamp;
}

export interface JobsTable {
  id: Generated<string>;
  workspace_id: string;
  provider: ProviderKind;
  provider_connection_id: string;
  kind: string;
  status: Generated<"queued" | "running" | "succeeded" | "failed">;
  payload: Json;
  idempotency_key: string;
  attempt_count: Generated<number>;
  max_attempts: Generated<number>;
  run_at: Timestamp;
  locked_at: NullableTimestamp;
  locked_by: string | null;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RoutingDecisionsTable {
  id: Generated<string>;
  workspace_id: string;
  repository_id: string | null;
  delivery_id: string;
  routing_key: string;
  action: string;
  risk_score: number;
  selected_reviewer: string | null;
  selected_reviewers: ColumnType<unknown, unknown | undefined, unknown>;
  no_human_reason: string | null;
  pull_number: number | null;
  head_sha: string | null;
  policy_check_run_id: NullableBigInt;
  policy_check_state: Generated<HumanReviewPolicyCheckState>;
  details: Json;
  mode: Generated<RepositoryMode>;
  action_status: Generated<ActionStatus>;
  action_error: string | null;
  action_applied_at: NullableTimestamp;
  action_failed_at: NullableTimestamp;
  organization_config_version: string | null;
  repository_config_path: string | null;
  repository_config_revision: string | null;
  effective_config_hash: string;
  inheritance_mode: InheritanceMode;
  config_diagnostics: Json;
  config_sources: Json;
  created_at: Timestamp;
}

export interface WorkspaceOperationalSettingsTable {
  workspace_id: string;
  timezone: Generated<string>;
  updated_at: Timestamp;
}

export interface ReviewerAbsencesTable {
  id: Generated<string>;
  workspace_id: string;
  provider: ProviderKind;
  provider_connection_id: string;
  external_actor_id: string;
  start_at: Timestamp;
  end_at: Timestamp;
  status: Generated<"scheduled" | "cancelled">;
  revision: Generated<number>;
  cancelled_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ReviewerReplacementsTable {
  id: Generated<string>;
  workspace_id: string;
  provider: ProviderKind;
  provider_connection_id: string;
  absence_id: string;
  absence_revision: number;
  decision_id: string;
  unavailable_actor_id: string;
  replacement_actor_id: NullableString;
  outcome: ReviewerReplacementOutcome;
  reason: string;
  state: Generated<string>;
  last_error: NullableString;
  started_at: Timestamp;
  completed_at: Timestamp;
}

export interface DecisionOutboxTable {
  id: Generated<string>;
  workspace_id: string;
  decision_id: NullableString;
  reviewer_replacement_id: NullableString;
  event_id: string;
  event_type: PlatformEventV1["eventType"];
  schema_version: number;
  payload: Json;
  occurred_at: Timestamp;
  available_at: Timestamp;
  published_at: NullableTimestamp;
  attempt_count: Generated<number>;
  last_error: string | null;
}

export interface WorkerHeartbeatTable {
  id: ColumnType<boolean, boolean | undefined, never>;
  worker_id: string;
  heartbeat_at: Timestamp;
}

export interface Database {
  workspaces: WorkspacesTable;
  provider_connections: ProviderConnectionsTable;
  repositories: RepositoriesTable;
  webhook_receipts: WebhookReceiptsTable;
  jobs: JobsTable;
  routing_decisions: RoutingDecisionsTable;
  workspace_operational_settings: WorkspaceOperationalSettingsTable;
  reviewer_absences: ReviewerAbsencesTable;
  reviewer_replacements: ReviewerReplacementsTable;
  decision_outbox: DecisionOutboxTable;
  worker_heartbeat: WorkerHeartbeatTable;
}

export type JobRow = Selectable<JobsTable>;
export type NewJobRow = Insertable<JobsTable>;
export type JobRowUpdate = Updateable<JobsTable>;
