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
  requiredApprovalCount?: number;
  policyCheckRunId: string | null;
  policyCheckState: "not_started" | "in_progress" | "success" | "failure";
}

export interface ReviewerReplacementCandidate {
  decisionId: string;
  installationId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  mode: RepositoryMode;
  selectedReviewers: string[];
  originalEligibleReviewers: string[];
  requiredApprovalCount: number;
  policyCheckRunId: string | null;
  policyCheckState: HumanReviewPolicyDecision["policyCheckState"];
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
      "routing_decisions.details as details",
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
    requiredApprovalCount: parseRequiredApprovalCount(decision.details, parseSelectedReviewers(decision.selectedReviewers)),
    policyCheckRunId: decision.policyCheckRunId,
    policyCheckState: decision.policyCheckState,
  };
}

export async function findReviewerReplacementCandidates(
  db: Kysely<Database>,
  input: {
    unavailableReviewer: string;
    recordedFor?: { absenceId: string; absenceRevision: number };
  },
): Promise<ReviewerReplacementCandidate[]> {
  const latestDecisions = db
    .selectFrom("routing_decisions")
    .selectAll()
    .where("repository_id", "is not", null)
    .distinctOn(["repository_id", "pull_number"])
    .orderBy("repository_id")
    .orderBy("pull_number")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc");
  const decisions = await db
    .with("latest_decisions", () => latestDecisions)
    .selectFrom("latest_decisions")
    .innerJoin("repositories", "repositories.id", "latest_decisions.repository_id")
    .innerJoin("installations", "installations.id", "repositories.installation_id")
    .select([
      "latest_decisions.id as decisionId",
      "installations.github_installation_id as installationId",
      "repositories.github_repository_id as repositoryId",
      "repositories.owner",
      "repositories.name as repo",
      "latest_decisions.pull_number as pullNumber",
      "latest_decisions.head_sha as headSha",
      "latest_decisions.mode",
      "latest_decisions.selected_reviewers as selectedReviewers",
      "latest_decisions.details",
      "latest_decisions.policy_check_run_id as policyCheckRunId",
      "latest_decisions.policy_check_state as policyCheckState",
      "latest_decisions.created_at as createdAt",
    ])
    .where("latest_decisions.action", "=", "request_human_review")
    .where("latest_decisions.head_sha", "is not", null)
    .where((eb) => eb.or([
      eb.and([
        eb("latest_decisions.mode", "=", "enforce"),
        eb("latest_decisions.policy_check_state", "=", "in_progress"),
      ]),
      eb.and([
        eb("latest_decisions.mode", "=", "shadow"),
        eb("latest_decisions.policy_check_state", "=", "not_started"),
      ]),
    ]))
    .orderBy("latest_decisions.created_at", "desc")
    .orderBy("latest_decisions.id", "desc")
    .execute();

  const freshCandidates = decisions.flatMap((decision) => {
    const selectedReviewers = parseStrictReviewerArray(decision.selectedReviewers);
    const original = parseOriginalReviewerPool(decision.details);
    if (
      decision.pullNumber === null ||
      decision.headSha === null ||
      selectedReviewers === null ||
      !selectedReviewers.includes(input.unavailableReviewer) ||
      original === null ||
      (decision.mode !== "enforce" && decision.mode !== "shadow") ||
      (decision.policyCheckState !== "in_progress" && decision.policyCheckState !== "not_started")
    ) return [];

    return [{
      decisionId: decision.decisionId,
      installationId: decision.installationId,
      repositoryId: decision.repositoryId,
      owner: decision.owner,
      repo: decision.repo,
      pullNumber: decision.pullNumber,
      headSha: decision.headSha,
      mode: decision.mode,
      selectedReviewers,
      originalEligibleReviewers: original.eligibleReviewers,
      requiredApprovalCount: original.requestedReviewerCount,
      policyCheckRunId: decision.policyCheckRunId,
      policyCheckState: decision.policyCheckState,
    }];
  });

  if (input.recordedFor === undefined) return freshCandidates;

  const recordedCandidates = await findRecordedReviewerReplacementCandidates(db, {
    unavailableReviewer: input.unavailableReviewer,
    ...input.recordedFor,
  });
  const recordedDecisionIds = new Set(recordedCandidates.map((candidate) => candidate.decisionId));
  return [
    ...recordedCandidates,
    ...freshCandidates.filter((candidate) => !recordedDecisionIds.has(candidate.decisionId)),
  ];
}

async function findRecordedReviewerReplacementCandidates(
  db: Kysely<Database>,
  input: { unavailableReviewer: string; absenceId: string; absenceRevision: number },
): Promise<ReviewerReplacementCandidate[]> {
  const decisions = await db
    .selectFrom("reviewer_replacements")
    .innerJoin("routing_decisions", "routing_decisions.id", "reviewer_replacements.decision_id")
    .innerJoin("repositories", "repositories.id", "routing_decisions.repository_id")
    .innerJoin("installations", "installations.id", "repositories.installation_id")
    .select([
      "routing_decisions.id as decisionId",
      "installations.github_installation_id as installationId",
      "repositories.github_repository_id as repositoryId",
      "repositories.owner",
      "repositories.name as repo",
      "routing_decisions.pull_number as pullNumber",
      "routing_decisions.head_sha as headSha",
      "routing_decisions.mode",
      "routing_decisions.selected_reviewers as selectedReviewers",
      "routing_decisions.details",
      "routing_decisions.policy_check_run_id as policyCheckRunId",
      "routing_decisions.policy_check_state as policyCheckState",
    ])
    .where("reviewer_replacements.absence_id", "=", input.absenceId)
    .where("reviewer_replacements.absence_revision", "=", input.absenceRevision)
    .where("reviewer_replacements.unavailable_reviewer", "=", input.unavailableReviewer)
    .where("reviewer_replacements.outcome", "in", [
      "replaced",
      "skipped_policy_satisfied",
      "no_replacement_available",
      "permanent_failure",
    ])
    .where("routing_decisions.mode", "=", "enforce")
    .orderBy("routing_decisions.created_at", "desc")
    .orderBy("routing_decisions.id", "desc")
    .execute();

  return decisions.flatMap((decision) => {
    const selectedReviewers = parseStrictReviewerArray(decision.selectedReviewers);
    const original = parseOriginalReviewerPool(decision.details);
    if (
      decision.pullNumber === null ||
      decision.headSha === null ||
      selectedReviewers === null ||
      original === null ||
      decision.mode !== "enforce"
    ) return [];

    return [{
      decisionId: decision.decisionId,
      installationId: decision.installationId,
      repositoryId: decision.repositoryId,
      owner: decision.owner,
      repo: decision.repo,
      pullNumber: decision.pullNumber,
      headSha: decision.headSha,
      mode: decision.mode,
      selectedReviewers,
      originalEligibleReviewers: original.eligibleReviewers,
      requiredApprovalCount: original.requestedReviewerCount,
      policyCheckRunId: decision.policyCheckRunId,
      policyCheckState: decision.policyCheckState,
    }];
  });
}

export async function replaceDecisionReviewerCohort(
  db: Kysely<Database>,
  input: { decisionId: string; unavailableReviewer: string; replacementReviewer: string },
): Promise<void> {
  const decision = await db
    .selectFrom("routing_decisions")
    .select("selected_reviewers")
    .where("id", "=", input.decisionId)
    .forUpdate()
    .executeTakeFirst();
  const selectedReviewers = decision ? parseStrictReviewerArray(decision.selected_reviewers) : null;
  if (selectedReviewers === null || !selectedReviewers.includes(input.unavailableReviewer)) return;

  const nextReviewers = selectedReviewers.map((reviewer) => (
    reviewer === input.unavailableReviewer ? input.replacementReviewer : reviewer
  ));
  await db
    .updateTable("routing_decisions")
    .set({
      selected_reviewers: JSON.stringify(nextReviewers),
      selected_reviewer: nextReviewers[0] ?? null,
    })
    .where("id", "=", input.decisionId)
    .execute();
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

function parseStrictReviewerArray(value: unknown): string[] | null {
  const reviewers = typeof value === "string" ? parseJsonArray(value) : value;
  return Array.isArray(reviewers) && reviewers.every((reviewer) => typeof reviewer === "string")
    ? reviewers
    : null;
}

function parseOriginalReviewerPool(
  details: unknown,
): { eligibleReviewers: string[]; requestedReviewerCount: number } | null {
  if (
    typeof details !== "object" ||
    details === null ||
    !("ownership" in details) ||
    typeof details.ownership !== "object" ||
    details.ownership === null ||
    !("eligibleReviewers" in details.ownership) ||
    !("routing" in details) ||
    typeof details.routing !== "object" ||
    details.routing === null ||
    !("requestedReviewerCount" in details.routing)
  ) return null;

  const eligibleReviewers = parseReviewerList(details.ownership.eligibleReviewers);
  const requestedReviewerCount = details.routing.requestedReviewerCount;
  if (
    eligibleReviewers === null ||
    (requestedReviewerCount !== 1 && requestedReviewerCount !== 2)
  ) return null;

  return { eligibleReviewers, requestedReviewerCount };
}

function parseReviewerList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((reviewer) => typeof reviewer === "string")
    ? value
    : null;
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
