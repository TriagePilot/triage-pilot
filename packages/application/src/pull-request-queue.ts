import { queuePullRequestKey, type PullRequestQueueScope, type PullRequestQueueSnapshot, type QueueAssessment, type QueueItem, type QueuePullRequest, type QueueReviewState, type WorkspaceId } from "@triagepilot/contracts";
import { classifyPullRequestAttention } from "./pull-request-attention.js";

export interface PullRequestQueueContext { signal: AbortSignal; assertAuthorized(): Promise<void> }
export interface QueueStoredProjection {
  syncRun: { runId: string; status: "queued" | "running" | "succeeded" | "failed"; updatedAt: Date; membershipComplete: boolean; classificationComplete: boolean; verificationError: string | null; completedRepositories?: number; totalRepositories?: number | null; coveredRepositoryIds?: string[]; retryAt?: Date | null } | null;
  lastVerifiedAt: Date | null;
  runnableClassification?: boolean;
  pendingClassification?: boolean;
  snapshots: Array<{ snapshot: { pull: QueuePullRequest; reviewState: QueueReviewState; isOpen: boolean }; desiredGeneration: number; appliedGeneration: number }>;
}
export interface PullRequestQueuePorts {
  now(): Date;
  createSnapshotId(): string;
  resolveScope(workspaceId: WorkspaceId): Promise<PullRequestQueueScope>;
  assertActive(scope: PullRequestQueueScope): Promise<void>;
  readProjection(scope: PullRequestQueueScope): Promise<QueueStoredProjection>;
  requestRefresh(scope: PullRequestQueueScope): Promise<unknown>;
  workerAvailable(): Promise<boolean>;
  readAssessments(scope: PullRequestQueueScope, pulls: QueuePullRequest[]): Promise<Map<string, QueueAssessment>>;
  linksFor(scope: PullRequestQueueScope, pull: QueuePullRequest, assessment: QueueAssessment | null): QueueItem["links"];
}
export function createPullRequestQueueService(ports: PullRequestQueuePorts) {
  async function read(input: { workspaceId: WorkspaceId; forceRefresh?: boolean; progressive?: boolean; signal?: AbortSignal }): Promise<PullRequestQueueSnapshot> {
    input.signal?.throwIfAborted();
    const scope = await ports.resolveScope(input.workspaceId);
    await ports.assertActive(scope);
    if (input.forceRefresh) { try { await ports.requestRefresh(scope); } catch (error) { await ports.assertActive(scope); throw error; } }
    let projection: QueueStoredProjection, workerAvailable: boolean;
    try { [projection, workerAvailable] = await Promise.all([ports.readProjection(scope), ports.workerAvailable()]); }
    catch (error) { await ports.assertActive(scope); throw error; }
    const pulls = projection.snapshots.filter(row => row.snapshot.isOpen && !row.snapshot.pull.isDraft && row.snapshot.pull.author.type !== "bot").map(row => row.snapshot.pull);
    const assessments = await ports.readAssessments(scope, pulls);
    const items = projection.snapshots.filter(row => row.snapshot.isOpen && !row.snapshot.pull.isDraft && row.snapshot.pull.author.type !== "bot").map(({ snapshot, desiredGeneration, appliedGeneration }) => {
      const pull = snapshot.pull;
      const reviewState = snapshot.reviewState ?? { status: "unavailable" as const, reviews: [], observedAt: null, lifecycle: { status: "unavailable" as const, openedSince: null } };
      const assessment = desiredGeneration > appliedGeneration ? null : assessments.get(queuePullRequestKey(pull.repository, pull.number)) ?? null;
      return { pullRequest: pull, reviewState, assessment, attention: classifyPullRequestAttention({ pullRequest: pull, reviewState, assessment }), links: ports.linksFor(scope, pull, assessment) };
    });
    await ports.assertActive(scope);
    input.signal?.throwIfAborted();
    const now = ports.now(), run = projection.syncRun;
    const verified = projection.lastVerifiedAt;
    const lastVerifiedAt = verified?.toISOString() ?? null;
    const stale = !verified || now.getTime() - verified.getTime() >= 1_800_000 || !workerAvailable;
    const active = run?.status === "queued" || run?.status === "running";
    const stalled = Boolean(active && now.getTime() - run!.updatedAt.getTime() >= 120_000 && !(run?.retryAt && run.retryAt > now));
    const healthy = Boolean(active && workerAvailable && !stalled);
    const pending = Boolean(projection.pendingClassification || projection.snapshots.some(row => row.desiredGeneration > row.appliedGeneration));
    const membershipComplete = Boolean(run?.membershipComplete || verified) && !pending;
    const classificationComplete = Boolean(run ? run.classificationComplete : verified) && !pending && items.every(item => item.reviewState.status === "complete" && item.reviewState.lifecycle.status === "complete");
    const coveredRepositoryIds = membershipComplete ? scope.knownRepositories.map(r => r.repository.externalId) : (run?.coveredRepositoryIds ?? []).filter(id => scope.knownRepositories.some(r => r.repository.externalId === id));
    const status = membershipComplete && classificationComplete ? "complete" : items.length || membershipComplete || verified || (run?.completedRepositories ?? 0) > 0 ? "partial" : "unavailable";
    const syncState = healthy ? "syncing" : status === "unavailable" ? "unavailable" : status === "partial" ? "partial" : stale ? "stale" : "current";
    const phase = stalled ? "stalled" : run?.status === "failed" ? "failed" : active ? run!.status as "queued" | "running" : "idle";
    return { workspaceId: input.workspaceId, snapshotId: ports.createSnapshotId(), status, syncState, lastVerifiedAt, workerAvailable, syncProgress: { runId: run?.runId ?? null, phase, updatedAt: run?.updatedAt.toISOString() ?? null, completedRepositories: run?.membershipComplete ? scope.knownRepositories.length : run?.completedRepositories ?? 0, totalRepositories: run?.membershipComplete ? scope.knownRepositories.length : run?.totalRepositories ?? null, retryAt: run?.retryAt?.toISOString() ?? null }, observedAt: lastVerifiedAt, acquiredAt: now.toISOString(), expiresAt: verified ? new Date(verified.getTime() + 1_800_000).toISOString() : now.toISOString(), cacheTtlSeconds: 0, membershipComplete, classificationComplete, repositories: scope.knownRepositories, coveredRepositoryIds, unavailableRepositoryIds: [], items, totalOpen: membershipComplete ? items.length : null, stale, refreshError: run?.verificationError ? "Pull request queue synchronization failed" : run?.status === "failed" ? "Pull request queue synchronization failed" : null, enrichmentPending: workerAvailable && !stalled && (projection.runnableClassification ?? (healthy && projection.snapshots.some(row => row.desiredGeneration > row.appliedGeneration))) };
  }
  return { read, readInitial: read, dispose() {} };
}
