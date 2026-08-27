import { sql, type Kysely } from "kysely";
import type { ActionStatus, RepositoryMode, RiskTier, RoutingAction, ScoreComponent } from "@triagepilot/shared";

import type { Database } from "./kysely";

type PolicyCheckState = "not_started" | "in_progress" | "success" | "failure";

export interface RepositoryOverview {
  id: string;
  owner: string;
  name: string;
  configState: string;
  mode: RepositoryMode;
}

export interface DecisionOverview {
  id: string;
  repository: string;
  pullNumber: number | null;
  headSha: string | null;
  runCount: number;
  mode: RepositoryMode;
  action: RoutingAction;
  actionStatus: ActionStatus;
  actionError: string | null;
  policyCheckState: PolicyCheckState;
  riskScore: number;
  riskBreakdown: RiskBreakdown | null;
  selectedReviewer: string | null;
  selectedReviewers: string[];
  requestedReviewerCount: number | null;
  reviewerShortfall: number | null;
  createdAt: string;
}

export interface RiskBreakdown {
  classifierVersion: string;
  tier: RiskTier;
  components: ScoreComponent[];
}

export interface JobFailureOverview {
  id: string;
  error: string;
  failedAt: string;
}

export interface ActionFailureOverview {
  decisionId: string;
  repository: string;
  error: string;
  failedAt: string;
}

export interface OperationsOverview {
  organization: string;
  githubApp: {
    appId: string;
    configured: boolean;
    installationId: string | null;
  };
  repositories: RepositoryOverview[];
  decisions: DecisionOverview[];
  failures: {
    jobs: JobFailureOverview[];
    actions: ActionFailureOverview[];
  };
  worker: {
    available: boolean;
    workerId: string | null;
    lastHeartbeatAt: string | null;
  };
}

export interface ReadOperationsOverviewInput {
  githubOrganization: string;
  githubAppId: string;
  now: Date;
  heartbeatStaleAfterMs: number;
}

export async function readOperationsOverview(
  db: Kysely<Database>,
  input: ReadOperationsOverviewInput,
): Promise<OperationsOverview> {
  const configuredOrganization = sql<boolean>`lower(installations.account_login) = lower(${input.githubOrganization})`;
  const [installation, repositories, decisions, jobFailures, actionFailures, heartbeat] =
    await Promise.all([
      db
        .selectFrom("installations")
        .select("github_installation_id")
        .where("status", "=", "active")
        .where(sql<boolean>`lower(account_login) = lower(${input.githubOrganization})`)
        .executeTakeFirst(),
      db
        .selectFrom("repositories")
        .innerJoin("installations", "installations.id", "repositories.installation_id")
        .select([
          "repositories.id",
          "repositories.owner",
          "repositories.name",
          "repositories.config_state",
          "repositories.last_config_mode",
        ])
        .where("installations.status", "=", "active")
        .where(configuredOrganization)
        .orderBy("repositories.owner", "asc")
        .orderBy("repositories.name", "asc")
        .execute(),
      readGroupedDecisions(db, input.githubOrganization),
      db
        .selectFrom("jobs")
        .select(["id", "last_error", "updated_at"])
        .where("status", "=", "failed")
        .orderBy("updated_at", "desc")
        .orderBy("id", "desc")
        .limit(25)
        .execute(),
      db
        .selectFrom("routing_decisions")
        .innerJoin("repositories", "repositories.id", "routing_decisions.repository_id")
        .innerJoin("installations", "installations.id", "repositories.installation_id")
        .select([
          "routing_decisions.id",
          "repositories.owner",
          "repositories.name",
          "routing_decisions.action_error",
          "routing_decisions.action_failed_at",
        ])
        .where("routing_decisions.action_status", "=", "failed")
        .where("routing_decisions.action_failed_at", "is not", null)
        .where("installations.status", "=", "active")
        .where(configuredOrganization)
        .orderBy("routing_decisions.action_failed_at", "desc")
        .orderBy("routing_decisions.id", "desc")
        .limit(25)
        .execute(),
      db
        .selectFrom("worker_heartbeat")
        .select(["worker_id", "heartbeat_at"])
        .executeTakeFirst(),
    ]);

  return {
    organization: input.githubOrganization,
    githubApp: {
      appId: input.githubAppId,
      configured: input.githubAppId.length > 0,
      installationId: installation?.github_installation_id ?? null,
    },
    repositories: repositories.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      configState: repository.config_state,
      mode: repository.last_config_mode,
    })),
    decisions: decisions.map((decision) => {
      const selectedReviewers = readSelectedReviewers(decision.selected_reviewers, decision.selected_reviewer);
      const reviewerRequirement = readReviewerRequirement(decision.details, selectedReviewers.length);
      return {
        id: decision.id,
        repository: `${decision.owner}/${decision.name}`,
        pullNumber: decision.pull_number,
        headSha: decision.head_sha,
        runCount: Number(decision.run_count),
        mode: decision.mode,
        action: decision.action as RoutingAction,
        actionStatus: decision.action_status,
        actionError: decision.action_error,
        policyCheckState: normalizePolicyCheckState(decision.policy_check_state),
        riskScore: decision.risk_score,
        riskBreakdown: readRiskBreakdown(decision.details),
        selectedReviewer: decision.selected_reviewer,
        selectedReviewers,
        ...reviewerRequirement,
        createdAt: decision.created_at.toISOString(),
      };
    }),
    failures: {
      jobs: jobFailures.map((failure) => ({
        id: failure.id,
        error: failure.last_error ?? "Unknown job failure",
        failedAt: failure.updated_at.toISOString(),
      })),
      actions: actionFailures.map((failure) => ({
        decisionId: failure.id,
        repository: `${failure.owner}/${failure.name}`,
        error: failure.action_error ?? "Unknown action failure",
        failedAt: failure.action_failed_at!.toISOString(),
      })),
    },
    worker: {
      available:
        heartbeat !== undefined &&
        input.now.getTime() - heartbeat.heartbeat_at.getTime() <= input.heartbeatStaleAfterMs,
      workerId: heartbeat?.worker_id ?? null,
      lastHeartbeatAt: heartbeat?.heartbeat_at.toISOString() ?? null,
    },
  };
}

interface GroupedDecisionRow {
  id: string;
  owner: string;
  name: string;
  mode: RepositoryMode;
  action: string;
  action_status: ActionStatus;
  action_error: string | null;
  policy_check_state: string;
  risk_score: number;
  selected_reviewer: string | null;
  selected_reviewers: unknown;
  details: unknown;
  created_at: Date;
  pull_number: number | null;
  head_sha: string | null;
  run_count: string | number;
}

async function readGroupedDecisions(
  db: Kysely<Database>,
  githubOrganization: string,
): Promise<GroupedDecisionRow[]> {
  const result = await sql<GroupedDecisionRow>`
    with normalized as (
      select
        routing_decisions.id,
        routing_decisions.repository_id,
        routing_decisions.created_at,
        coalesce(
          routing_decisions.pull_number,
          case
            when jsonb_typeof(routing_decisions.details -> 'pullNumber') = 'number'
              and routing_decisions.details ->> 'pullNumber' ~ '^[1-9][0-9]{0,9}$'
              and (routing_decisions.details ->> 'pullNumber')::numeric <= 2147483647
            then (routing_decisions.details ->> 'pullNumber')::integer
            else null
          end
        ) as effective_pull_number
      from routing_decisions
      inner join repositories on repositories.id = routing_decisions.repository_id
      inner join installations on installations.id = repositories.installation_id
      where installations.status = 'active'
        and lower(installations.account_login) = lower(${githubOrganization})
    ), identified as (
      select
        id,
        repository_id,
        created_at,
        effective_pull_number,
        coalesce(effective_pull_number::text, 'legacy:' || id::text) as group_identity
      from normalized
    ), latest_groups as (
      select
        repository_id,
        group_identity,
        max(created_at) as group_created_at,
        count(*) as run_count
      from identified
      group by repository_id, group_identity
      order by group_created_at desc, repository_id, group_identity
      limit 50
    ), selected_groups as (
      select
        *,
        row_number() over (
          order by group_created_at desc, repository_id, group_identity
        ) as group_rank
      from latest_groups
    ), ranked_ids as (
      select
        identified.id,
        identified.effective_pull_number,
        selected_groups.run_count,
        selected_groups.group_rank,
        row_number() over (
          partition by identified.repository_id, identified.group_identity
          order by identified.created_at desc, identified.id desc
        ) as revision_rank
      from identified
      inner join selected_groups
        on selected_groups.repository_id = identified.repository_id
       and selected_groups.group_identity = identified.group_identity
    ), selected_ids as (
      select * from ranked_ids where revision_rank <= 10
    )
    select
      routing_decisions.id,
      repositories.owner,
      repositories.name,
      routing_decisions.mode,
      routing_decisions.action,
      routing_decisions.action_status,
      routing_decisions.action_error,
      routing_decisions.policy_check_state,
      routing_decisions.risk_score,
      routing_decisions.selected_reviewer,
      routing_decisions.selected_reviewers,
      routing_decisions.details,
      routing_decisions.created_at,
      selected_ids.effective_pull_number as pull_number,
      routing_decisions.head_sha,
      selected_ids.run_count
    from selected_ids
    inner join routing_decisions on routing_decisions.id = selected_ids.id
    inner join repositories on repositories.id = routing_decisions.repository_id
    order by selected_ids.group_rank asc, selected_ids.revision_rank asc
  `.execute(db);
  return result.rows;
}

function normalizePolicyCheckState(value: string): PolicyCheckState {
  switch (value) {
    case "in_progress":
    case "success":
    case "failure":
      return value;
    default:
      return "not_started";
  }
}

function readRiskBreakdown(details: unknown): RiskBreakdown | null {
  const risk = readRecord(readRecord(details)?.risk);
  if (!risk || !isRiskTier(risk.tier) || typeof risk.classifierVersion !== "string") return null;
  if (!Array.isArray(risk.components) || !risk.components.every(isScoreComponent)) return null;

  return {
    classifierVersion: risk.classifierVersion,
    tier: risk.tier,
    components: risk.components,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRiskTier(value: unknown): value is RiskTier {
  return value === "low" || value === "medium" || value === "high";
}

function isScoreComponent(value: unknown): value is ScoreComponent {
  const component = readRecord(value);
  return (
    component !== null &&
    typeof component.reason === "string" &&
    typeof component.detail === "string" &&
    typeof component.score === "number" &&
    Number.isFinite(component.score)
  );
}

function readSelectedReviewers(value: unknown, legacyReviewer: string | null): string[] {
  if (Array.isArray(value)) {
    return value.filter((reviewer): reviewer is string => typeof reviewer === "string").slice(0, 2);
  }
  return legacyReviewer ? [legacyReviewer] : [];
}

function readReviewerRequirement(
  details: unknown,
  selectedReviewerCount: number,
): Pick<DecisionOverview, "requestedReviewerCount" | "reviewerShortfall"> {
  const routing = readRecord(readRecord(details)?.routing);
  const requestedReviewerCount = routing?.requestedReviewerCount;
  if (
    requestedReviewerCount !== 0 &&
    requestedReviewerCount !== 1 &&
    requestedReviewerCount !== 2
  ) {
    return { requestedReviewerCount: null, reviewerShortfall: null };
  }

  const recordedShortfall = routing?.reviewerShortfall;
  const reviewerShortfall =
    typeof recordedShortfall === "number" && Number.isInteger(recordedShortfall) && recordedShortfall >= 0
      ? recordedShortfall
      : Math.max(requestedReviewerCount - selectedReviewerCount, 0);
  return { requestedReviewerCount, reviewerShortfall };
}
