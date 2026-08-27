import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";
import type { ActionStatus, RepositoryMode } from "@triagepilot/shared";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, unknown, unknown>;
type BigInt = ColumnType<string, string, string>;
type NullableBigInt = ColumnType<string | null, string | null, string | null>;
type HumanReviewPolicyCheckState = "not_started" | "in_progress" | "success" | "failure";

export interface InstallationsTable {
  id: Generated<string>;
  github_installation_id: BigInt;
  account_login: string;
  account_type: string;
  status: string;
  permissions: Json;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RepositoriesTable {
  id: Generated<string>;
  installation_id: string;
  github_repository_id: BigInt;
  owner: string;
  name: string;
  default_branch: string | null;
  config_state: string;
  last_config_mode: Generated<RepositoryMode>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WebhookReceiptsTable {
  delivery_id: string;
  event_name: string;
  event_action: string | null;
  hook_id: string | null;
  installation_id: NullableBigInt;
  payload_summary: Json;
  created_at: Timestamp;
}

export interface JobsTable {
  id: Generated<string>;
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
  created_at: Timestamp;
}

export interface WorkerHeartbeatTable {
  id: ColumnType<boolean, boolean | undefined, never>;
  worker_id: string;
  heartbeat_at: Timestamp;
}

export interface OrganizationSettingsTable {
  id: ColumnType<boolean, boolean | undefined, boolean>;
  timezone: Generated<string>;
  updated_at: Timestamp;
}

export interface ReviewerAbsencesTable {
  id: Generated<string>;
  reviewer_handle: string;
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
  absence_id: string;
  absence_revision: number;
  decision_id: string;
  unavailable_reviewer: string;
  replacement_reviewer: string | null;
  outcome: string;
  reason: string;
  started_at: Timestamp;
  completed_at: Timestamp;
}

export interface Database {
  installations: InstallationsTable;
  repositories: RepositoriesTable;
  webhook_receipts: WebhookReceiptsTable;
  jobs: JobsTable;
  routing_decisions: RoutingDecisionsTable;
  worker_heartbeat: WorkerHeartbeatTable;
  organization_settings: OrganizationSettingsTable;
  reviewer_absences: ReviewerAbsencesTable;
  reviewer_replacements: ReviewerReplacementsTable;
}

export type JobRow = Selectable<JobsTable>;
export type NewJobRow = Insertable<JobsTable>;
export type JobRowUpdate = Updateable<JobsTable>;
