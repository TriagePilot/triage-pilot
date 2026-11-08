import type { ActionStatus, RepositoryMode, RiskTier, RoutingAction } from "./events.js";
import type { ChangeRequestId, ExternalActorId, RepositoryRef, WorkspaceId } from "./ids.js";

export interface QueueActor { id: string; login: string; type: "human" | "bot" | "other" }
export interface QueueRepository { repository: RepositoryRef; recordId: string | null }
export interface QueuePullRequest { repository: RepositoryRef; changeRequestId: ChangeRequestId; number: number; title: string; author: QueueActor; createdAt: string; updatedAt: string; baseRevision: string; headRevision: string; isDraft: boolean; requestedUsers: QueueActor[]; requestedTeams: Array<{ id: string; name: string }> }
export interface QueueReview { id: string; actor: QueueActor; state: string; commitId: string | null; submittedAt: string | null }
export interface QueueReviewState { status: "complete" | "unavailable" | "changed"; reviews: QueueReview[]; observedAt: string | null; lifecycle: { status: "complete" | "unavailable"; openedSince: string | null } }
export interface QueueAssessment { decisionId: string; createdAt: string; headRevision: string | null; repositoryConfigRevision: string | null; mode: RepositoryMode; action: RoutingAction; actionStatus: ActionStatus; policyCheckState: "not_started" | "in_progress" | "success" | "failure"; failureReason: string | null; riskTier: RiskTier | null; requiredReviews: 0 | 1 | 2 | null; selectedActors: ExternalActorId[] }
export type QueueGroup = "reviewers" | "authors" | "reviewer_gap" | "policy_met" | "other";
export interface QueueAttention { group: QueueGroup; badge: "reviewers_move" | "authors_move" | "needs_reviewer" | "policy_met" | "draft" | "status_unknown" | "policy_unknown"; reason: string; actorIds: string[]; teamIds: string[]; secondaryReasons: string[]; approvedCount: number | null; requiredCount: 0 | 1 | 2 | null; assessmentStatus: "current" | "historical" | "missing"; checkUpdatePending: boolean }
export interface QueueItem { pullRequest: QueuePullRequest; reviewState: QueueReviewState; assessment: QueueAssessment | null; attention: QueueAttention; links: { provider: string; decision: string | null } }
export interface PullRequestQueueSnapshot { workspaceId: WorkspaceId; snapshotId: string; status: "complete" | "partial" | "unavailable"; observedAt: string | null; acquiredAt: string; expiresAt: string; cacheTtlSeconds: 60; membershipComplete: boolean; classificationComplete: boolean; repositories: QueueRepository[]; coveredRepositoryIds: string[]; unavailableRepositoryIds: string[]; items: QueueItem[]; totalOpen: number | null; stale: boolean; refreshError: string | null }
export interface PullRequestQueueScope { workspaceId: WorkspaceId; providerConnectionId: string; externalConnectionId: string; githubOrganization: string; knownRepositories: Array<{ recordId: string; repository: RepositoryRef }> }
export function queuePullRequestKey(repository: RepositoryRef, number: number): string { return JSON.stringify([repository.provider, repository.externalId, number]); }
export class PullRequestQueueUnavailableError extends Error {
  constructor(readonly reason: "authority" | "rate_limited" | "provider_unavailable" | "invalid_response" | "timeout") {
    super({ authority: "Pull request queue authority is unavailable", rate_limited: "Pull request queue is rate limited", provider_unavailable: "Pull request queue provider is unavailable", invalid_response: "Pull request queue provider returned an invalid response", timeout: "Pull request queue request timed out" }[reason]);
    this.name = "PullRequestQueueUnavailableError";
  }
}
