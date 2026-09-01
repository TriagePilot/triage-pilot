import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  legacyRoutingKey,
  type ActionStatus,
  type DecisionEventV1,
  type ProviderConnectionId,
  type ProviderKind,
  type RepositoryMode,
  type RoutingAction,
  type WorkspaceId,
} from "@triagepilot/contracts";

import type { Database } from "./kysely.js";
import { stagePlatformEvent } from "./outbox.js";

export interface DecisionInput {
  repositoryId: string;
  deliveryId: string;
  changeRequestId: string;
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

export class DecisionValidationError extends Error {}

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

export interface ReviewerReplacementCandidateDecision {
  decisionId: string;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  repositoryRecordId: string;
  repositoryId: string;
  owner: string;
  repositoryName: string;
  changeRequestId: string;
  changeRequestNumber: number;
  routedHeadRevision: string;
  mode: RepositoryMode;
  selectedActors: string[];
  originalPreferredActors: string[];
  originalEligibleActors: string[];
  requestedReviewerCount: 1 | 2;
  policyCheckRunId: string | null;
  policyCheckState: HumanReviewPolicyDecision["policyCheckState"];
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
    const effective = await trx
      .selectFrom("routing_decisions")
      .innerJoin("repositories", (join) => join
        .onRef("repositories.workspace_id", "=", "routing_decisions.workspace_id")
        .onRef("repositories.id", "=", "routing_decisions.repository_id"))
      .select([
        "routing_decisions.id",
        "routing_decisions.workspace_id",
        "routing_decisions.change_request_id",
        "routing_decisions.routing_key",
        "routing_decisions.mode",
        "routing_decisions.action",
        "routing_decisions.risk_score",
        "routing_decisions.selected_reviewers",
        "routing_decisions.effective_config_hash",
        "repositories.provider",
        "repositories.external_repository_id",
      ])
      .where("routing_decisions.workspace_id", "=", workspaceId)
      .where("routing_decisions.id", "=", persisted.decisionId)
      .forUpdate("routing_decisions")
      .executeTakeFirstOrThrow();
    const event = input.event(persisted);
    assertDecisionEventMatches(effective, event);
    await stagePlatformEvent(trx, workspaceId, persisted.decisionId, event);
    return persisted;
  });
}

async function persistDecisionRecord(
  db: DatabaseExecutor,
  workspaceId: WorkspaceId,
  input: DecisionInput,
): Promise<PersistedDecision> {
  validateChangeRequestId(input.changeRequestId);
  const selectedReviewers = [...new Set(input.selectedReviewers ?? [])].slice(0, 2);
  const selectedReviewersJson = JSON.stringify(selectedReviewers);
  const configDiagnosticsJson = JSON.stringify(input.configDiagnostics ?? []);
  const routingKey = input.routingKey ?? legacyRoutingKey(input.deliveryId);
  const decision = await db
    .insertInto("routing_decisions")
    .values({
      workspace_id: workspaceId,
      repository_id: input.repositoryId,
      delivery_id: input.deliveryId,
      routing_key: routingKey,
      change_request_id: input.changeRequestId,
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
      config_diagnostics: configDiagnosticsJson,
      config_sources: input.configSources ?? {},
    })
    .onConflict((conflict) =>
      conflict.columns(["workspace_id", "routing_key"]).doUpdateSet((eb) => ({
        mode: preserveAfterSuccess<RepositoryMode>("mode", input.mode),
        action: preserveAfterSuccess<string>("action", input.action),
        risk_score: preserveAfterSuccess<number>("risk_score", input.riskScore),
        pull_number: preserveAfterSuccess<number>("pull_number", input.pullNumber),
        change_request_id: preserveAfterSuccess<string>("change_request_id", input.changeRequestId),
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
        config_diagnostics: preserveAfterSuccess<unknown>("config_diagnostics", configDiagnosticsJson),
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

function validateChangeRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DecisionValidationError("changeRequestId must be a non-empty provider identifier");
  }
}

function assertDecisionEventMatches(
  decision: {
    id: string;
    workspace_id: string;
    change_request_id: string | null;
    routing_key: string;
    mode: RepositoryMode;
    action: string;
    risk_score: number;
    selected_reviewers: unknown;
    effective_config_hash: string;
    provider: ProviderKind;
    external_repository_id: string;
  },
  event: DecisionEventV1,
): void {
  const selectedActors = parseStrictActorList(decision.selected_reviewers);
  if (
    event.schemaVersion !== 1
    || event.eventType !== "routing_decision"
    || event.decisionId !== decision.id
    || event.workspaceId !== decision.workspace_id
    || event.provider !== decision.provider
    || event.repositoryId !== decision.external_repository_id
    || event.changeRequestId !== decision.change_request_id
    || event.routingKey !== decision.routing_key
    || event.mode !== decision.mode
    || event.action !== decision.action
    || event.riskScore !== decision.risk_score
    || selectedActors === null
    || !isDeepStrictEqual(event.selectedActors, selectedActors)
    || event.effectiveConfigurationHash !== decision.effective_config_hash
  ) throw new DecisionValidationError("routing decision event does not match persisted decision");
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

export async function findReviewerReplacementCandidates(
  db: DatabaseExecutor,
  workspaceId: WorkspaceId,
  input: {
    provider: ProviderKind;
    providerConnectionId: ProviderConnectionId;
    unavailableActorId: string;
    recordedFor: { absenceId: string; absenceRevision: number };
  },
): Promise<ReviewerReplacementCandidateDecision[]> {
  const unavailableActorId = parseExternalActorId(input.unavailableActorId);
  if (unavailableActorId === null) return [];

  const latestDecisions = db
    .selectFrom("routing_decisions")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("repository_id", "is not", null)
    .distinctOn(["repository_id", "pull_number"])
    .orderBy("repository_id")
    .orderBy("pull_number")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc");
  let query = db
    .with("latest_decisions", () => latestDecisions)
    .selectFrom("latest_decisions")
    .innerJoin("repositories", (join) => join
      .onRef("repositories.workspace_id", "=", "latest_decisions.workspace_id")
      .onRef("repositories.id", "=", "latest_decisions.repository_id"))
    .innerJoin("provider_connections", (join) => join
      .onRef("provider_connections.workspace_id", "=", "repositories.workspace_id")
      .onRef("provider_connections.provider", "=", "repositories.provider")
      .onRef("provider_connections.id", "=", "repositories.provider_connection_id"))
    .select([
      "latest_decisions.id as decisionId",
      "repositories.provider",
      "repositories.provider_connection_id as providerConnectionId",
      "repositories.id as repositoryRecordId",
      "repositories.external_repository_id as repositoryId",
      "repositories.owner",
      "repositories.name as repositoryName",
      "latest_decisions.change_request_id as changeRequestId",
      "latest_decisions.pull_number as changeRequestNumber",
      "latest_decisions.head_sha as routedHeadRevision",
      "latest_decisions.mode",
      "latest_decisions.selected_reviewers as selectedActors",
      "latest_decisions.details",
      "latest_decisions.policy_check_run_id as policyCheckRunId",
      "latest_decisions.policy_check_state as policyCheckState",
    ])
    .where("latest_decisions.workspace_id", "=", workspaceId)
    .where("repositories.provider", "=", input.provider)
    .where("repositories.provider_connection_id", "=", input.providerConnectionId)
    .where("provider_connections.status", "=", "active")
    .where("latest_decisions.action", "=", "request_human_review")
    .where("latest_decisions.head_sha", "is not", null);
  query = query.where(({ exists, not, selectFrom }) => not(exists(
    selectFrom("reviewer_replacements")
      .select("reviewer_replacements.id")
      .whereRef("reviewer_replacements.workspace_id", "=", "latest_decisions.workspace_id")
      .where("reviewer_replacements.provider", "=", input.provider)
      .where("reviewer_replacements.provider_connection_id", "=", input.providerConnectionId)
      .where("reviewer_replacements.absence_id", "=", input.recordedFor.absenceId)
      .where("reviewer_replacements.absence_revision", "=", input.recordedFor.absenceRevision)
      .whereRef("reviewer_replacements.decision_id", "=", "latest_decisions.id"),
  )));
  const rows = await query
    .orderBy("repositories.external_repository_id", "asc")
    .orderBy("latest_decisions.pull_number", "asc")
    .orderBy("latest_decisions.id", "asc")
    .execute();

  return rows.flatMap((row) => {
    const selectedActors = parseStrictActorList(row.selectedActors);
    const original = parseOriginalReviewerPool(row.details);
    if (
      row.changeRequestNumber === null
      || row.changeRequestId === null
      || row.routedHeadRevision === null
      || selectedActors === null
      || !selectedActors.includes(unavailableActorId)
      || original === null
    ) return [];

    return [{
      decisionId: row.decisionId,
      provider: row.provider,
      providerConnectionId: row.providerConnectionId,
      repositoryRecordId: row.repositoryRecordId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repositoryName: row.repositoryName,
      changeRequestId: row.changeRequestId,
      changeRequestNumber: row.changeRequestNumber,
      routedHeadRevision: row.routedHeadRevision,
      mode: row.mode,
      selectedActors,
      originalPreferredActors: original.preferredActors,
      originalEligibleActors: original.eligibleActors,
      requestedReviewerCount: original.requestedReviewerCount,
      policyCheckRunId: row.policyCheckRunId,
      policyCheckState: row.policyCheckState,
    }];
  });
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

export function parseStrictActorList(value: unknown): string[] | null {
  const actors = typeof value === "string" ? parseJsonArray(value) : value;
  if (!Array.isArray(actors) || !actors.every((actor) => typeof actor === "string")) return null;
  const parsed = actors.map(parseExternalActorId);
  if (parsed.some((actor) => actor === null)) return null;
  return [...new Set(parsed as string[])];
}

export function parseOriginalReviewerPool(details: unknown): {
  eligibleActors: string[];
  preferredActors: string[];
  requestedReviewerCount: 1 | 2;
} | null {
  if (
    typeof details !== "object"
    || details === null
    || !("ownership" in details)
    || typeof details.ownership !== "object"
    || details.ownership === null
    || !("eligibleReviewers" in details.ownership)
    || !("routing" in details)
    || typeof details.routing !== "object"
    || details.routing === null
    || !("requestedReviewerCount" in details.routing)
  ) return null;

  const eligibleActors = parseStrictActorList(details.ownership.eligibleReviewers);
  const preferredActors = "preferredReviewers" in details.ownership
    ? parseStrictActorList(details.ownership.preferredReviewers)
    : eligibleActors;
  const requestedReviewerCount = details.routing.requestedReviewerCount;
  if (
    eligibleActors === null
    || preferredActors === null
    || (requestedReviewerCount !== 1 && requestedReviewerCount !== 2)
  ) return null;
  return { eligibleActors, preferredActors, requestedReviewerCount };
}

export function parseExternalActorId(value: string): string | null {
  return value.trim() === "" ? null : value;
}

function parseJsonArray(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
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
