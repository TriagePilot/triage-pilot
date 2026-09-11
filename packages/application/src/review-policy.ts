import type {
  ChangeRequestId,
  HumanReviewPolicyJobPayload,
  RepositoryMode,
  RepositoryRef,
  RoutingAction,
  WorkspaceId,
} from "@triagepilot/contracts";
import {
  evaluateHumanReviewPolicy,
  type HumanReviewPolicyState,
  type ReviewMetadata,
} from "@triagepilot/core";

export interface ReviewPolicyDecision {
  decisionId: string;
  workspaceId: WorkspaceId;
  repository: RepositoryRef;
  changeRequestId: ChangeRequestId;
  changeRequestNumber: number;
  headRevision: string;
  mode: RepositoryMode;
  action: RoutingAction;
  selectedActors: string[];
  requiredApprovalCount?: number;
  policyCheckRunId: string | null;
  policyCheckState: "not_started" | HumanReviewPolicyState;
}

export interface ReviewPolicyApplicationPorts {
  decisions: {
    findLatest(input: {
      workspaceId: WorkspaceId;
      repository: RepositoryRef;
      changeRequestId: ChangeRequestId;
      changeRequestNumber: number;
    }): Promise<ReviewPolicyDecision | null>;
    persistState(input: {
      workspaceId: WorkspaceId;
      decisionId: string;
      state: HumanReviewPolicyState;
    }): Promise<void>;
  };
  provider: {
    fetchChangeRequestState(job: HumanReviewPolicyJobPayload): Promise<{
      state: "open" | "closed" | string;
      currentHeadRevision: string;
    }>;
    fetchReviews(job: HumanReviewPolicyJobPayload): Promise<ReviewMetadata[]>;
    updatePolicyCheck(input: {
      decision: ReviewPolicyDecision;
      state: HumanReviewPolicyState;
      summary: string;
    }): Promise<void>;
  };
}

export type ReviewPolicyOutcome =
  | {
    status: "skipped";
    reason: "no_decision" | "shadow" | "terminal_failure" | "unsupported_action" | "closed" | "stale_revision";
  }
  | { status: "evaluated"; decisionId: string; state: HumanReviewPolicyState };

export async function evaluateReviewPolicy(
  job: HumanReviewPolicyJobPayload,
  ports: ReviewPolicyApplicationPorts,
): Promise<ReviewPolicyOutcome> {
  const decision = await ports.decisions.findLatest({
    workspaceId: job.workspaceId,
    repository: job.changeRequest.repository,
    changeRequestId: job.changeRequest.externalId,
    changeRequestNumber: job.changeRequest.number,
  });
  if (decision === null) return { status: "skipped", reason: "no_decision" };
  if (decision.mode !== "enforce") return { status: "skipped", reason: "shadow" };
  if (decision.policyCheckState === "failure") return { status: "skipped", reason: "terminal_failure" };

  const route = routeForAction(decision.action);
  if (route === null) return { status: "skipped", reason: "unsupported_action" };

  const initialState = await ports.provider.fetchChangeRequestState(job);
  if (initialState.state !== "open") return { status: "skipped", reason: "closed" };
  if (initialState.currentHeadRevision !== decision.headRevision) {
    return { status: "skipped", reason: "stale_revision" };
  }

  const evaluation = evaluateHumanReviewPolicy({
    route,
    selectedReviewers: decision.selectedActors,
    ...(decision.requiredApprovalCount === undefined ? {} : { requiredApprovalCount: decision.requiredApprovalCount }),
    reviews: await ports.provider.fetchReviews(job),
  });
  if (evaluation.state === "success") {
    const currentState = await ports.provider.fetchChangeRequestState(job);
    if (currentState.state !== "open") return { status: "skipped", reason: "closed" };
    if (currentState.currentHeadRevision !== decision.headRevision) {
      return { status: "skipped", reason: "stale_revision" };
    }
  }

  await ports.provider.updatePolicyCheck({
    decision,
    state: evaluation.state,
    summary: evaluation.summary,
  });
  await ports.decisions.persistState({
    workspaceId: job.workspaceId,
    decisionId: decision.decisionId,
    state: evaluation.state,
  });
  return { status: "evaluated", decisionId: decision.decisionId, state: evaluation.state };
}

function routeForAction(action: RoutingAction): "no_human" | "human_review" | "no_eligible_reviewer" | null {
  if (action === "policy_approval") return "no_human";
  if (action === "request_human_review") return "human_review";
  if (action === "no_eligible_reviewer") return "no_eligible_reviewer";
  return null;
}
