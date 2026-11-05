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

/** Validate the serialized observation without treating unavailable data as zero load. */
export function isReviewerLoadObservation(value: unknown): value is ReviewerLoadObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const observation = value as Record<string, unknown>;
  const instant = (input: unknown): input is string => typeof input === "string"
    && Number.isFinite(Date.parse(input)) && new Date(input).toISOString() === input;
  if (observation.source !== "tracked_github_pending" || !instant(observation.trackedSince)
    || typeof observation.loads !== "object" || observation.loads === null || Array.isArray(observation.loads)
    || !Object.entries(observation.loads).every(([actor, count]) => actor.trim() === actor && actor.length > 0
      && typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return false;
  if (observation.status === "complete") {
    return observation.reason === null && instant(observation.observedAt)
      && observation.trackedSince <= observation.observedAt;
  }
  return observation.status === "fallback" && observation.observedAt === null
    && Object.keys(observation.loads).length === 0
    && ["timeout", "rate_limited", "provider_unavailable", "invalid_response"].includes(observation.reason as string);
}
