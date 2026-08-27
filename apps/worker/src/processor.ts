import { parseTriagePilotConfig } from "@triagepilot/config";
import {
  availableReviewerHandlesAt,
  decideRouting,
  matchOwnership,
  scorePullRequestRisk,
  type ChangedFileMetadata,
} from "@triagepilot/core";
import type { ReviewerAbsenceWindow } from "@triagepilot/db";
import {
  legacyRoutingKey,
  type ActionStatus,
  type GitHubId,
  type HumanReviewPolicyJobPayload,
  type RepositoryMode,
  type RiskTier,
  type RoutingJobPayload,
  type ScoreComponent,
} from "@triagepilot/shared";
import { minimatch } from "minimatch";

export type RoutingJobMessage = RoutingJobPayload;

export interface RoutingJobServices {
  fetchConfig(input: RoutingJobMessage): Promise<string>;
  fetchChangedFiles(input: RoutingJobMessage): Promise<ChangedFileMetadata[]>;
  fetchCommitMessages(input: RoutingJobMessage): Promise<string[]>;
  fetchPullRequestMetadata(input: RoutingJobMessage): Promise<{
    authorLogin: string;
    authorHandle: string;
    branchName: string;
    targetBranchName: string;
  }>;
  fetchActiveApprovedReviewers(input: RoutingJobMessage): Promise<string[]>;
  now(): Date;
  listReviewerAbsences(input: {
    reviewers: string[];
    endingAfter: Date;
  }): Promise<ReviewerAbsenceWindow[]>;
  enqueueHumanReviewPolicyEvaluation(
    input: Omit<HumanReviewPolicyJobPayload, "kind">,
  ): Promise<void>;
  getReviewerLoad(input: { installationId: GitHubId; reviewers: string[] }): Promise<Record<string, number>>;
  updateRepositoryConfigState(input: {
    configState: "valid" | "invalid";
    mode: RepositoryMode;
  }): Promise<void>;
  persistDecision(input: {
    deliveryId: string;
    routingKey: string;
    pullNumber: number;
    headSha: string;
    mode: RepositoryMode;
    action: string;
    actionStatus: ActionStatus;
    riskScore: number;
    selectedReviewers?: string[];
    noHumanReason?: string;
    details: unknown;
  }): Promise<{
    decisionId: string;
    actionStatus: ActionStatus;
    actionError: string | null;
    actionAppliedAt: Date | null;
  }>;
  applyDecisionActions(input: {
    action: string;
    expectedHeadSha: string;
    riskTier: RiskTier;
    risk?: {
      score: number;
      classifierVersion: string;
      components: ScoreComponent[];
    };
    selectedReviewers?: string[];
    reviewersToRequest?: string[];
    noHumanReason?: string;
    decisionId: string;
  }): Promise<void>;
  markActionSucceeded(decisionId: string, at: Date): Promise<void>;
  markActionFailed(decisionId: string, error: string, at: Date): Promise<void>;
  failPolicyCheck?(summary: string): Promise<void>;
}

export async function processRoutingJob(message: RoutingJobMessage, services: RoutingJobServices): Promise<void> {
  const routingKey = message.routingKey ?? legacyRoutingKey(message.deliveryId);
  const configSource = await services.fetchConfig(message);
  const configResult = parseTriagePilotConfig(configSource);
  if (!configResult.ok) {
    await services.persistDecision({
      deliveryId: message.deliveryId,
      routingKey,
      pullNumber: message.pullNumber,
      headSha: message.headSha,
      mode: "shadow",
      action: "configuration_failure",
      actionStatus: "not_applied",
      riskScore: 0,
      details: { pullNumber: message.pullNumber, diagnostics: configResult.diagnostics },
    });
    await services.updateRepositoryConfigState({ configState: "invalid", mode: "shadow" });
    return;
  }

  const publicMode: RepositoryMode = configResult.config.mode;
  await services.updateRepositoryConfigState({ configState: "valid", mode: publicMode });
  if (message.isDraft && !configResult.config.routing.includeDraftPullRequests) {
    return;
  }
  const pullRequestMetadata = await services.fetchPullRequestMetadata(message);
  if (
    configResult.config.routing.excludeTargetBranches.includes(pullRequestMetadata.targetBranchName) ||
    configResult.config.routing.excludeSourceBranchPatterns.some((pattern) =>
      minimatch(pullRequestMetadata.branchName, pattern, { dot: true }),
    )
  ) {
    return;
  }

  const [changedFiles, commitMessages] = await Promise.all([
    services.fetchChangedFiles(message),
    services.fetchCommitMessages(message),
  ]);

  const ownership = matchOwnership({
    files: changedFiles.map((file) => file.path),
    rules: configResult.config.ownership.rules,
    fallbackReviewers: configResult.config.ownership.fallbackReviewers,
  });
  const availabilityEvaluatedAt = services.now();
  const absenceWindows = await services.listReviewerAbsences({
    reviewers: ownership.eligibleReviewers,
    endingAfter: availabilityEvaluatedAt,
  });
  const canonicalEligibleReviewers = availableReviewerHandlesAt({
    reviewers: ownership.eligibleReviewers,
    absences: [],
    now: availabilityEvaluatedAt,
  });
  const availableEligibleReviewers = availableReviewerHandlesAt({
    reviewers: ownership.eligibleReviewers,
    absences: absenceWindows,
    now: availabilityEvaluatedAt,
  });
  const availablePreferredReviewers = availableReviewerHandlesAt({
    reviewers: ownership.preferredReviewers,
    absences: absenceWindows,
    now: availabilityEvaluatedAt,
  });
  const excludedReviewers = canonicalEligibleReviewers.filter(
    (reviewer) => !availableEligibleReviewers.includes(reviewer),
  );
  const reviewerLoad = await services.getReviewerLoad({
    installationId: message.installationId,
    reviewers: availableEligibleReviewers,
  });
  const risk = scorePullRequestRisk({
    files: changedFiles,
    author: pullRequestMetadata.authorLogin,
    branchName: pullRequestMetadata.branchName,
    commitMessages,
    config: configResult.config.risk,
  });
  const existingApprovedReviewers = risk.tier === "low" ? [] : await services.fetchActiveApprovedReviewers(message);
  const routing = decideRouting({
    risk,
    author: pullRequestMetadata.authorHandle,
    eligibleReviewers: availableEligibleReviewers,
    preferredReviewers: availablePreferredReviewers,
    existingApprovedReviewers,
    load: reviewerLoad,
    highRiskReviewers: configResult.config.routing.highRiskReviewers,
    selectionKey: `${message.owner}/${message.repo}#${message.pullNumber}`,
  });

  const decisionInput: Parameters<RoutingJobServices["persistDecision"]>[0] = {
    deliveryId: message.deliveryId,
    routingKey,
    pullNumber: message.pullNumber,
    headSha: message.headSha,
    mode: publicMode,
    action: routing.action,
    actionStatus: publicMode === "enforce" && routing.action !== "no_eligible_reviewer" ? "pending" : "not_applied",
    riskScore: risk.score,
    details: {
      pullNumber: message.pullNumber,
      risk,
      ownership,
      availability: {
        evaluatedAt: availabilityEvaluatedAt.toISOString(),
        excludedReviewers,
      },
      routing,
    },
  };
  if (routing.selectedReviewers.length > 0) decisionInput.selectedReviewers = routing.selectedReviewers;
  if (routing.noHumanReason) decisionInput.noHumanReason = routing.noHumanReason;

  const persisted = await services.persistDecision(decisionInput);
  if (persisted.actionStatus === "succeeded") return;

  if (publicMode === "enforce") {
    const actionInput: Parameters<RoutingJobServices["applyDecisionActions"]>[0] = {
      action: routing.action,
      decisionId: persisted.decisionId,
      expectedHeadSha: message.headSha,
      riskTier: risk.tier,
      risk,
    };
    if (routing.selectedReviewers.length > 0) actionInput.selectedReviewers = routing.selectedReviewers;
    actionInput.reviewersToRequest = routing.reviewersToRequest;
    if (routing.noHumanReason) actionInput.noHumanReason = routing.noHumanReason;
    try {
      await services.applyDecisionActions(actionInput);
      if (routing.action === "request_human_review") {
        await services.enqueueHumanReviewPolicyEvaluation({
          deliveryId: `routing-policy:${message.deliveryId}`,
          installationId: message.installationId,
          repositoryId: message.repositoryId,
          owner: message.owner,
          repo: message.repo,
          pullNumber: message.pullNumber,
        });
      }
    } catch (error) {
      await services.markActionFailed(
        persisted.decisionId,
        error instanceof Error ? error.message : "GitHub action failed",
        new Date(),
      );
      throw error;
    }
    if (persisted.actionStatus === "pending") {
      await services.markActionSucceeded(persisted.decisionId, new Date());
    }
  }
}
