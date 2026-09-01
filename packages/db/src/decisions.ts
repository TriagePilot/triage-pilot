import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { legacyRoutingKey, type ActionStatus, type DecisionEventV1, type RepositoryMode, type RoutingAction, type WorkspaceId } from "@triagepilot/contracts";

import type { Database } from "./kysely.js";
import { stagePlatformEvent } from "./outbox.js";

export interface DecisionInput {
  repositoryId: string;
  deliveryId: string;
  routingKey?: string;
  pullNumber: number;
  headSha: string;
  mode: RepositoryMode;
  action: string;
  actionStatus: ActionStatus;
  riskScore: number;
  selectedReviewers?: string[];
  noHumanReason?: string;
  details: unknown;
  organizationConfigVersion?: string | null;
  repositoryConfigPath?: string | null;
  repositoryConfigRevision?: string | null;
  effectiveConfigHash?: string;
  inheritanceMode?: "legacy" | "defaults" | "organization" | "replace" | "inherit";
  configDiagnostics?: unknown[];
  configSources?: Record<string, unknown>;
}

export interface PersistedDecision {
  decisionId: string;
  actionStatus: ActionStatus;
  actionError: string | null;
  actionAppliedAt: Date | null;
}

export interface HumanReviewPolicyDecision {
  decisionId: string;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  mode: RepositoryMode;
  action: RoutingAction;
  selectedReviewers: string[];
  requiredApprovalCount?: number;
  policyCheckRunId: string | null;
  policyCheckState: "not_started" | "in_progress" | "success" | "failure";
}

type PolicyCheckState = Exclude<HumanReviewPolicyDecision["policyCheckState"], "not_started">;
type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export async function persistDecision(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: DecisionInput,
): Promise<PersistedDecision> {
  return await persistDecisionRecord(db, workspaceId, input);
}

export async function persistDecisionWithEvent(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: {
    decision: DecisionInput;
    event(persisted: PersistedDecision): DecisionEventV1;
  },
): Promise<PersistedDecision> {
  return await db.transaction().execute(async (trx) => {
    const persisted = await persistDecisionRecord(trx, workspaceId, input.decision);
    await stagePlatformEvent(trx, workspaceId, persisted.decisionId, input.event(persisted));
    return persisted;
  });
}

async function persistDecisionRecord(
  db: DatabaseExecutor,
  workspaceId: WorkspaceId,
  input: DecisionInput,
): Promise<PersistedDecision> {
  const selectedReviewers = [...new Set(input.selectedReviewers ?? [])].slice(0, 2);
  const selectedReviewersJson = JSON.stringify(selectedReviewers);
  const routingKey = input.routingKey ?? legacyRoutingKey(input.deliveryId);
  const decision = await db
    .insertInto("routing_decisions")
    .values({
      workspace_id: workspaceId,
      repository_id: input.repositoryId,
      delivery_id: input.deliveryId,
      routing_key: routingKey,
      pull_number: input.pullNumber,
      head_sha: input.headSha,
      mode: input.mode,
      action: input.action,
      action_status: input.actionStatus,
      action_error: null,
      action_applied_at: null,
      action_failed_at: null,
      risk_score: input.riskScore,
      selected_reviewer: selectedReviewers[0] ?? null,
      selected_reviewers: selectedReviewersJson,
      no_human_reason: input.noHumanReason ?? null,
      details: input.details,
      organization_config_version: input.organizationConfigVersion ?? null,
      repository_config_path: input.repositoryConfigPath ?? null,
      repository_config_revision: input.repositoryConfigRevision ?? null,
      effective_config_hash: input.effectiveConfigHash ?? legacyConfigHash(input.details),
      inheritance_mode: input.inheritanceMode ?? "legacy",
      config_diagnostics: input.configDiagnostics ?? [],
      config_sources: input.configSources ?? {},
    })
    .onConflict((conflict) =>
      conflict.columns(["workspace_id", "routing_key"]).doUpdateSet((eb) => ({
        mode: preserveAfterSuccess<RepositoryMode>("mode", input.mode),
        action: preserveAfterSuccess<string>("action", input.action),
        risk_score: preserveAfterSuccess<number>("risk_score", input.riskScore),
        pull_number: preserveAfterSuccess<number>("pull_number", input.pullNumber),
        head_sha: preserveAfterSuccess<string>("head_sha", input.headSha),
        selected_reviewer: preserveAfterSuccess<string | null>(
          "selected_reviewer",
          selectedReviewers[0] ?? null,
        ),
        selected_reviewers: preserveAfterSuccess<unknown>("selected_reviewers", selectedReviewersJson),
        no_human_reason: preserveAfterSuccess<string | null>(
          "no_human_reason",
          input.noHumanReason ?? null,
        ),
        details: preserveAfterSuccess<unknown>("details", input.details),
        organization_config_version: preserveAfterSuccess<string | null>("organization_config_version", input.organizationConfigVersion ?? null),
        repository_config_path: preserveAfterSuccess<string | null>("repository_config_path", input.repositoryConfigPath ?? null),
        repository_config_revision: preserveAfterSuccess<string | null>("repository_config_revision", input.repositoryConfigRevision ?? null),
        effective_config_hash: preserveAfterSuccess<string>("effective_config_hash", input.effectiveConfigHash ?? legacyConfigHash(input.details)),
        inheritance_mode: preserveAfterSuccess<"legacy" | "defaults" | "organization" | "replace" | "inherit">("inheritance_mode", input.inheritanceMode ?? "legacy"),
        config_diagnostics: preserveAfterSuccess<unknown>("config_diagnostics", input.configDiagnostics ?? []),
        config_sources: preserveAfterSuccess<unknown>("config_sources", input.configSources ?? {}),
        action_status: eb
          .case()
          .when("routing_decisions.action_status", "=", "succeeded")
          .then<ActionStatus>("succeeded")
          .else<ActionStatus>(input.actionStatus)
          .end(),
      })),
    )
    .returning(["id", "action_status", "action_error", "action_applied_at"])
    .executeTakeFirstOrThrow();

  return {
    decisionId: decision.id,
    actionStatus: decision.action_status,
    actionError: decision.action_error,
    actionAppliedAt: decision.action_applied_at,
  };
}

export async function recordPolicyCheck(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: { decisionId: string; checkRunId: string; state: PolicyCheckState },
): Promise<void> {
  await db
    .updateTable("routing_decisions")
    .set({ policy_check_run_id: input.checkRunId, policy_check_state: input.state })
    .where((eb) => eb.and([
      eb("workspace_id", "=", workspaceId),
      eb("id", "=", input.decisionId),
      eb("policy_check_state", "!=", "failure"),
    ]))
    .execute();
}

export async function findLatestHumanReviewPolicyDecision(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: { repositoryId: string; pullNumber: number },
): Promise<HumanReviewPolicyDecision | null> {
  const decision = await db
    .selectFrom("routing_decisions")
    .innerJoin("repositories", (join) => join
      .onRef("repositories.id", "=", "routing_decisions.repository_id")
      .onRef("repositories.workspace_id", "=", "routing_decisions.workspace_id"))
    .select([
      "routing_decisions.id as decisionId",
      "repositories.owner",
      "repositories.name as repo",
      "routing_decisions.pull_number as pullNumber",
      "routing_decisions.head_sha as headSha",
      "routing_decisions.mode",
      "routing_decisions.action",
      "routing_decisions.selected_reviewers as selectedReviewers",
      "routing_decisions.details as details",
      "routing_decisions.policy_check_run_id as policyCheckRunId",
      "routing_decisions.policy_check_state as policyCheckState",
    ])
    .where("routing_decisions.workspace_id", "=", workspaceId)
    .where((eb) => eb.and([
      eb("routing_decisions.repository_id", "=", input.repositoryId),
      eb("routing_decisions.pull_number", "=", input.pullNumber),
    ]))
    .orderBy("routing_decisions.created_at", "desc")
    .executeTakeFirst();

  if (
    !decision ||
    decision.pullNumber === null ||
    decision.headSha === null ||
    decision.mode !== "enforce"
  ) return null;

  return {
    decisionId: decision.decisionId,
    owner: decision.owner,
    repo: decision.repo,
    pullNumber: decision.pullNumber,
    headSha: decision.headSha,
    mode: decision.mode,
    action: decision.action as RoutingAction,
    selectedReviewers: parseSelectedReviewers(decision.selectedReviewers),
    requiredApprovalCount: parseRequiredApprovalCount(decision.details, parseSelectedReviewers(decision.selectedReviewers)),
    policyCheckRunId: decision.policyCheckRunId,
    policyCheckState: decision.policyCheckState,
  };
}

function parseRequiredApprovalCount(details: unknown, selectedReviewers: string[]): number {
  if (
    typeof details === "object" &&
    details !== null &&
    "routing" in details &&
    typeof details.routing === "object" &&
    details.routing !== null &&
    "requestedReviewerCount" in details.routing &&
    (details.routing.requestedReviewerCount === 1 || details.routing.requestedReviewerCount === 2)
  ) return details.routing.requestedReviewerCount;

  return selectedReviewers.length;
}

export async function updatePolicyCheckState(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: { decisionId: string; state: PolicyCheckState },
): Promise<void> {
  await db
    .updateTable("routing_decisions")
    .set({ policy_check_state: input.state })
    .where((eb) => eb.and([
      eb("workspace_id", "=", workspaceId),
      eb("id", "=", input.decisionId),
      eb("policy_check_state", "!=", "failure"),
    ]))
    .execute();
}

function parseSelectedReviewers(value: unknown): string[] {
  const reviewers = typeof value === "string" ? parseJsonArray(value) : value;
  return Array.isArray(reviewers) ? reviewers.filter((reviewer): reviewer is string => typeof reviewer === "string") : [];
}

function parseJsonArray(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

function preserveAfterSuccess<T>(column: string, nextValue: T) {
  return sql<T>`case
    when routing_decisions.action_status = 'succeeded' then ${sql.ref(`routing_decisions.${column}`)}
    else ${nextValue}
  end`;
}

export async function markActionSucceeded(db: Kysely<Database>, workspaceId: WorkspaceId, decisionId: string, at: Date): Promise<void> {
  await db
    .updateTable("routing_decisions")
    .set({
      action_status: "succeeded",
      action_error: null,
      action_applied_at: at,
      action_failed_at: null,
    })
    .where((eb) => eb.and([
      eb("workspace_id", "=", workspaceId),
      eb("id", "=", decisionId),
      eb("action_status", "!=", "succeeded"),
    ]))
    .execute();
}

export async function markActionFailed(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  decisionId: string,
  error: string,
  at: Date,
): Promise<void> {
  await db
    .updateTable("routing_decisions")
    .set({
      action_status: "failed",
      action_error: error,
      action_applied_at: null,
      action_failed_at: at,
    })
    .where((eb) => eb.and([
      eb("workspace_id", "=", workspaceId),
      eb("id", "=", decisionId),
      eb("action_status", "!=", "succeeded"),
    ]))
    .execute();
}

function legacyConfigHash(details: unknown): string {
  return createHash("sha256").update(JSON.stringify(details)).digest("hex");
}
