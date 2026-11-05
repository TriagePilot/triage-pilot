import type { ChangeRequestId, ExternalActorId, ProviderConnectionId, RepositoryRef, WorkspaceId } from "./ids.js";

export interface TrackedPullRequest {
  repositoryRecordId: string;
  repository: RepositoryRef;
  providerConnectionId: ProviderConnectionId;
  changeRequestId: ChangeRequestId;
  changeRequestNumber: number;
}

export interface AnalyticsRepositoryScope {
  workspaceId: WorkspaceId;
  providerConnectionId: ProviderConnectionId;
  externalConnectionId: string;
  repositories: Array<{ recordId: string; repository: RepositoryRef }>;
}

export interface ReviewerLoadObservation {
  status: "complete" | "fallback";
  source: "tracked_github_pending";
  observedAt: string | null;
  trackedSince: string;
  loads: Record<string, number>;
  reason: "timeout" | "rate_limited" | "provider_unavailable" | "invalid_response" | null;
}

export interface CurrentBacklogSnapshot {
  status: "complete" | "partial" | "unavailable";
  observedAt: string | null;
  trackedSince: string;
  scope: AnalyticsRepositoryScope;
  pairs: Array<{ changeRequest: TrackedPullRequest; actor: ExternalActorId }>;
  knownActors: ExternalActorId[];
  coveredRepositoryIds: string[];
  unavailableRepositoryIds: string[];
}

export interface ReviewerBacklogScopeRequest {
  workspaceId: WorkspaceId;
  providerConnectionId: ProviderConnectionId;
  repositoryIds: string[];
}

export interface ReviewerLoadRequest {
  workspaceId: WorkspaceId;
  providerConnectionId: ProviderConnectionId;
  actors: ExternalActorId[];
  exclude: TrackedPullRequest;
}

export interface OpenReviewRequest {
  changeRequestId: ChangeRequestId;
  changeRequestNumber: number;
  requestedActors: ExternalActorId[];
}
