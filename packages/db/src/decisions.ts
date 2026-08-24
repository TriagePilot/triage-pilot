import { sql, type Kysely } from "kysely";
import { legacyRoutingKey, type ActionStatus, type RepositoryMode, type RoutingAction } from "@triagepilot/shared";

import type { Database } from "./kysely";

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
  policyCheckRunId: string | null;
  policyCheckState: "not_started" | "in_progress" | "success" | "failure";
}

type PolicyCheckState = Exclude<HumanReviewPolicyDecision["policyCheckState"], "not_started">;

export async function persistDecision(
  db: Kysely<Database>,
  input: DecisionInput,
): Promise<PersistedDecision> {
  const selectedReviewers = [...new Set(input.selectedReviewers ?? [])].slice(0, 2);
  const selectedReviewersJson = JSON.stringify(selectedReviewers);
  const routingKey = input.routingKey ?? legacyRoutingKey(input.deliveryId);
  const decision = await db
    .insertInto("routing_decisions")
    .values({
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
    })
    .onConflict((conflict) =>
      conflict.column("routing_key").doUpdateSet((eb) => ({
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
  input: { decisionId: string; checkRunId: string; state: PolicyCheckState },
): Promise<void> {
  await db
    .updateTable("routing_decisions")
    .set({ policy_check_run_id: input.checkRunId, policy_check_state: input.state })
    .where((eb) => eb.and([
      eb("id", "=", input.decisionId),
      eb("policy_check_state", "!=", "failure"),
    ]))
    .execute();
}

export async function findLatestHumanReviewPolicyDecision(
  db: Kysely<Database>,
  input: { repositoryId: string; pullNumber: number },
): Promise<HumanReviewPolicyDecision | null> {
  const decision = await db
    .selectFrom("routing_decisions")
    .innerJoin("repositories", "repositories.id", "routing_decisions.repository_id")
    .select([
      "routing_decisions.id as decisionId",
      "repositories.owner",
      "repositories.name as repo",
      "routing_decisions.pull_number as pullNumber",
      "routing_decisions.head_sha as headSha",
      "routing_decisions.mode",
      "routing_decisions.action",
      "routing_decisions.selected_reviewers as selectedReviewers",
      "routing_decisions.policy_check_run_id as policyCheckRunId",
      "routing_decisions.policy_check_state as policyCheckState",
    ])
    .where("routing_decisions.repository_id", "=", input.repositoryId)
    .where("routing_decisions.pull_number", "=", input.pullNumber)
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
    policyCheckRunId: decision.policyCheckRunId,
    policyCheckState: decision.policyCheckState,
  };
}

export async function updatePolicyCheckState(
  db: Kysely<Database>,
  input: { decisionId: string; state: PolicyCheckState },
): Promise<void> {
  await db
    .updateTable("routing_decisions")
    .set({ policy_check_state: input.state })
    .where((eb) => eb.and([
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

export async function markActionSucceeded(db: Kysely<Database>, decisionId: string, at: Date): Promise<void> {
  await db
    .updateTable("routing_decisions")
    .set({
      action_status: "succeeded",
      action_error: null,
      action_applied_at: at,
      action_failed_at: null,
    })
    .where("id", "=", decisionId)
    .where("action_status", "!=", "succeeded")
    .execute();
}

export async function markActionFailed(
  db: Kysely<Database>,
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
    .where("id", "=", decisionId)
    .where("action_status", "!=", "succeeded")
    .execute();
}
