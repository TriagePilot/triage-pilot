import { describe, expect, it, vi } from "vitest";
import { createPullRequestQueueService } from "../src/pull-request-queue.js";

describe("stored queue reads", () => {
  it("schedules manual refresh and returns bootstrap data without a provider call", async () => {
    const scope = { workspaceId: "workspace", providerConnectionId: "connection", externalConnectionId: "123", githubOrganization: "org", knownRepositories: [] } as any;
    const requestRefresh = vi.fn(async () => undefined);
    const provider = vi.fn(() => { throw new Error("provider must not be called"); });
    const service = createPullRequestQueueService({ now: () => new Date("2026-01-01T00:00:00Z"), createSnapshotId: () => "snapshot", resolveScope: async () => scope, assertActive: async () => {}, readProjection: async () => ({ syncRun: null, lastVerifiedAt: null, snapshots: [] }), readAssessments: async () => new Map(), requestRefresh, workerAvailable: async () => false, linksFor: () => ({ provider: "", decision: null }), listRepositories: provider, listOpenPullRequests: provider, readReviewState: provider } as any);
    const result = await service.read({ workspaceId: scope.workspaceId, forceRefresh: true });
    expect(result.status).toBe("unavailable");
    expect(result.syncState).toBe("unavailable");
    expect(result.cacheTtlSeconds).toBe(0);
    expect(requestRefresh).toHaveBeenCalledOnce();
    expect(provider).not.toHaveBeenCalled();
  });
});

it("classifies stored eligible rows and retains incomplete coverage", async () => {
  const { queuePull, queueReviewState, queueAssessment } = await import("../../../test/pull-request-queue-fixtures.js");
  const { queuePullRequestKey } = await import("@triagepilot/contracts");
  const pull = queuePull({ requestedUsers: [{ id: "reviewer", login: "bob", type: "human" }] });
  const scope = { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "99", githubOrganization: "acme", knownRepositories: [{ recordId: "r", repository: pull.repository }] } as any;
  const row = (p: typeof pull, reviewState = queueReviewState()) => ({ snapshot: { pull: p, reviewState, isOpen: true }, desiredGeneration: 1, appliedGeneration: 1 });
  const assessment = queueAssessment({ repositoryConfigRevision: "base", mode: "enforce" });
  const ports = { now: () => new Date("2026-01-01T00:01:00Z"), createSnapshotId: () => "s", resolveScope: async () => scope, assertActive: async () => {}, requestRefresh: async () => {}, workerAvailable: async () => true, readAssessments: async () => new Map([[queuePullRequestKey(pull.repository, pull.number), assessment]]), linksFor: () => ({ provider: "", decision: null }), readProjection: async () => ({ lastVerifiedAt: null, syncRun: { runId: "run", status: "failed" as const, updatedAt: new Date("2026-01-01T00:00:00Z"), membershipComplete: false, classificationComplete: false, verificationError: "private provider error", completedRepositories: 1 }, snapshots: [row(pull), row(queuePull({ number: 2, isDraft: true })), row(queuePull({ number: 3, author: { id: "bot", login: "bot", type: "bot" } }))] }) };
  const result = await createPullRequestQueueService(ports).read({ workspaceId: scope.workspaceId });
  expect(result).toMatchObject({ status: "partial", syncState: "partial", totalOpen: null, refreshError: "Pull request queue synchronization failed" });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.attention).toMatchObject({ group: "reviewers", actorIds: ["reviewer"], assessmentStatus: "current" });
  expect(result.items[0]?.pullRequest.author.login).toBe("alice");
});

it("keeps unavailable review data and unmatched assessments unknown", async () => {
  const { queuePull, queueReviewState, queueAssessment } = await import("../../../test/pull-request-queue-fixtures.js");
  const { queuePullRequestKey } = await import("@triagepilot/contracts");
  const pull = queuePull();
  const scope = { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "99", githubOrganization: "acme", knownRepositories: [{ recordId: "r", repository: pull.repository }] } as any;
  const row = { snapshot: { pull, reviewState: queueReviewState({ status: "unavailable" }), isOpen: true }, desiredGeneration: 1, appliedGeneration: 1 };
  const ports = { now: () => new Date("2026-01-01T00:30:00Z"), createSnapshotId: () => "s", resolveScope: async () => scope, assertActive: async () => {}, requestRefresh: async () => {}, workerAvailable: async () => true, readAssessments: async () => new Map([[queuePullRequestKey(pull.repository, pull.number), queueAssessment({ headRevision: "old", repositoryConfigRevision: "base", mode: "enforce" })]]), linksFor: () => ({ provider: "", decision: null }), readProjection: async () => ({ lastVerifiedAt: new Date("2026-01-01T00:00:00Z"), syncRun: null, snapshots: [row] }) };
  const result = await createPullRequestQueueService(ports).read({ workspaceId: scope.workspaceId });
  expect(result).toMatchObject({ status: "partial", syncState: "partial", stale: true, totalOpen: 1 });
  expect(result.items[0]?.attention).toMatchObject({ badge: "status_unknown", assessmentStatus: "historical" });
});

it.each([true, false])("does not report a dirty row as classified when refresh is runnable=%s", async runnable => {
  const { queuePull, queueReviewState, queueAssessment } = await import("../../../test/pull-request-queue-fixtures.js");
  const { queuePullRequestKey } = await import("@triagepilot/contracts");
  const pull = queuePull();
  const scope = { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "99", githubOrganization: "acme", knownRepositories: [{ recordId: "r", repository: pull.repository }] } as any;
  const row = { snapshot: { pull, reviewState: queueReviewState(), isOpen: true }, desiredGeneration: 2, appliedGeneration: 1 };
  const assessment = queueAssessment({ repositoryConfigRevision: "base", mode: "enforce", requiredReviews: 0, action: "policy_approval" });
  const ports = { now: () => new Date("2026-01-01T00:01:00Z"), createSnapshotId: () => "s", resolveScope: async () => scope, assertActive: async () => {}, requestRefresh: async () => {}, workerAvailable: async () => true, readAssessments: async () => new Map([[queuePullRequestKey(pull.repository, pull.number), assessment]]), linksFor: (_scope: unknown, _pull: unknown, current: unknown) => ({ provider: "", decision: current ? "/decision" : null }), readProjection: async () => ({ lastVerifiedAt: new Date("2026-01-01T00:00:00Z"), syncRun: null, runnableClassification: runnable, snapshots: [row] }) };
  const result = await createPullRequestQueueService(ports).read({ workspaceId: scope.workspaceId });
  expect(result).toMatchObject({ status: "partial", syncState: "partial", classificationComplete: false, enrichmentPending: runnable });
  expect(result.items[0]).toMatchObject({ assessment: null, attention: { assessmentStatus: "missing", badge: "policy_unknown" }, links: { decision: null } });
});

it("rechecks authority when projection fails during revocation", async () => {
  const { PullRequestQueueUnavailableError } = await import("@triagepilot/contracts");
  const scope = { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "99", githubOrganization: "acme", knownRepositories: [] } as any;
  const assertActive = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PullRequestQueueUnavailableError("authority"));
  const service = createPullRequestQueueService({ now: () => new Date(), createSnapshotId: () => "s", resolveScope: async () => scope, assertActive, readProjection: async () => { throw new Error("queue authority unavailable"); }, requestRefresh: async () => {}, workerAvailable: async () => true, readAssessments: async () => new Map(), linksFor: () => ({ provider: "", decision: null }) });
  await expect(service.read({ workspaceId: scope.workspaceId })).rejects.toMatchObject({ reason: "authority" });
});

it.each(["unseen opening", "dirty closed snapshot"])("does not claim complete membership for %s", async scenario => {
  const { queuePull, queueReviewState } = await import("../../../test/pull-request-queue-fixtures.js");
  const pull = queuePull();
  const scope = { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "99", githubOrganization: "acme", knownRepositories: [{ recordId: "r", repository: pull.repository }] } as any;
  const snapshots = scenario === "dirty closed snapshot" ? [{ snapshot: { pull, reviewState: queueReviewState(), isOpen: false }, desiredGeneration: 2, appliedGeneration: 1 }] : [];
  const service = createPullRequestQueueService({ now: () => new Date("2026-01-01T00:01:00Z"), createSnapshotId: () => "s", resolveScope: async () => scope, assertActive: async () => {}, requestRefresh: async () => {}, workerAvailable: async () => true, readAssessments: async () => new Map(), linksFor: () => ({ provider: "", decision: null }), readProjection: async () => ({ lastVerifiedAt: new Date("2026-01-01T00:00:00Z"), syncRun: null, pendingClassification: true, runnableClassification: false, snapshots }) });
  expect(await service.read({ workspaceId: scope.workspaceId })).toMatchObject({ membershipComplete: false, totalOpen: null, classificationComplete: false });
});

it.each(["running", "failed"] as const)("does not identify unscanned repositories as unavailable when a sync is %s", async status => {
  const repo = (id: string) => ({ recordId: id, repository: { provider: "github" as const, externalId: id, owner: "acme", name: id } });
  const scope = { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "99", githubOrganization: "acme", knownRepositories: [repo("covered"), repo("waiting"), repo("later")] };
  const service = createPullRequestQueueService({ now: () => new Date("2026-01-01T00:01:00Z"), createSnapshotId: () => "s", resolveScope: async () => scope, assertActive: async () => {}, requestRefresh: async () => {}, workerAvailable: async () => true, readAssessments: async () => new Map(), linksFor: () => ({ provider: "", decision: null }), readProjection: async () => ({ lastVerifiedAt: null, syncRun: { runId: "run", status, updatedAt: new Date("2026-01-01T00:00:30Z"), membershipComplete: false, classificationComplete: false, verificationError: status === "failed" ? "sync failed" : null, completedRepositories: 1, totalRepositories: 3, coveredRepositoryIds: ["covered"] }, snapshots: [] }) });
  const result = await service.read({ workspaceId: scope.workspaceId });
  expect(result).toMatchObject({ coveredRepositoryIds: ["covered"], unavailableRepositoryIds: [], membershipComplete: false, totalOpen: null, syncProgress: { completedRepositories: 1, totalRepositories: 3 } });
  if (status === "failed") expect(result.refreshError).toBeTruthy();
});

it("does not report current classification after lifecycle verification fails without an assessment", async () => {
  const { queuePull, queueReviewState } = await import("../../../test/pull-request-queue-fixtures.js");
  const pull = queuePull();
  const scope = { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "99", githubOrganization: "acme", knownRepositories: [{ recordId: "r", repository: pull.repository }] } as any;
  const service = createPullRequestQueueService({ now: () => new Date("2026-01-01T00:01:00Z"), createSnapshotId: () => "s", resolveScope: async () => scope, assertActive: async () => {}, requestRefresh: async () => {}, workerAvailable: async () => true, readAssessments: async () => new Map(), linksFor: () => ({ provider: "", decision: null }), readProjection: async () => ({ lastVerifiedAt: new Date("2026-01-01T00:00:00Z"), syncRun: { runId: "run", status: "failed" as const, updatedAt: new Date("2026-01-01T00:00:59Z"), membershipComplete: true, classificationComplete: false, verificationError: "classification failed" }, snapshots: [{ snapshot: { pull, reviewState: queueReviewState({ lifecycle: { status: "unavailable", openedSince: null } }), isOpen: true }, desiredGeneration: 1, appliedGeneration: 1 }] }) });
  expect(await service.read({ workspaceId: scope.workspaceId })).toMatchObject({ classificationComplete: false, status: "partial", syncState: "partial" });
});
