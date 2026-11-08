import { afterEach, describe, expect, it, vi } from "vitest";
import { PullRequestQueueUnavailableError, queuePullRequestKey, type PullRequestQueueScope } from "@triagepilot/contracts";
import { queueAssessment, queuePull, queueReviewState } from "../../../test/pull-request-queue-fixtures.js";
import { createPullRequestQueueService, type PullRequestQueuePorts } from "../src/pull-request-queue.js";
const scope: PullRequestQueueScope = { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "1", githubOrganization: "acme", knownRepositories: [] };
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01")); let id = 0;
  const ports = { now: () => new Date(), createSnapshotId: () => String(++id), resolveScope: vi.fn<PullRequestQueuePorts["resolveScope"]>(async () => scope), assertActive: vi.fn(async () => {}), listRepositories: vi.fn(async () => [queuePull().repository]), listOpenPullRequests: vi.fn<PullRequestQueuePorts["listOpenPullRequests"]>(async () => [queuePull()]), readAssessments: vi.fn<PullRequestQueuePorts["readAssessments"]>(async () => new Map()), readReviewState: vi.fn<PullRequestQueuePorts["readReviewState"]>(async () => queueReviewState()), linksFor: vi.fn(() => ({ provider: "https://github.com/acme/api/pull/1", decision: null })) } satisfies PullRequestQueuePorts;
  return { ports, service: createPullRequestQueueService(ports) };
}
afterEach(() => vi.useRealTimers());
describe("queue acquisition", () => {
  it("starts TTL at completion and explicitly forced reads bypass completed entries", async () => {
    const { ports, service } = setup();
    ports.listOpenPullRequests.mockImplementationOnce(async () => { await new Promise(r => setTimeout(r, 5000)); return [queuePull()]; });
    const pending = service.read({ workspaceId: "w" }); await vi.advanceTimersByTimeAsync(5000); const first = await pending;
    expect(first.acquiredAt).toBe("2026-01-01T00:00:05.000Z"); expect(first.expiresAt).toBe("2026-01-01T00:01:05.000Z");
    expect((await service.read({ workspaceId: "w", forceRefresh: true })).snapshotId).not.toBe(first.snapshotId);
    expect(Object.keys(ports.listOpenPullRequests.mock.calls[0][2]).sort()).toEqual(["assertAuthorized", "signal"]);
  });
  it("bounds provider concurrency at four and disposes owned acquisitions", async () => {
    const { ports, service } = setup();
    ports.listRepositories.mockResolvedValue(Array.from({length: 8}, (_, i) => ({...queuePull().repository, externalId: String(i)})));
    let active = 0, peak = 0;
    ports.listOpenPullRequests.mockImplementation(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--; return []; });
    const pending = service.read({workspaceId: "w"}); await vi.advanceTimersByTimeAsync(30); expect((await pending).status).toBe("complete"); expect(peak).toBe(4);
    ports.listOpenPullRequests.mockImplementation(() => new Promise(() => {}));
    const abandoned = service.read({workspaceId: "w", forceRefresh: true}); const rejected = expect(abandoned).rejects.toMatchObject({reason: "authority"});
    await vi.advanceTimersByTimeAsync(0); service.dispose(); await rejected; expect(vi.getTimerCount()).toBe(0);
  });
  it("restarts on changed inventory and never caches an obsolete generation", async () => {
    const { ports, service } = setup(); const firstRepo = queuePull().repository; const secondRepo = {...firstRepo, externalId: "2", name: "web"};
    let release!: () => void;
    ports.listOpenPullRequests.mockImplementationOnce(async () => { await new Promise<void>(r => {release = r;}); return [queuePull()]; });
    const old = service.read({workspaceId: "w"}); await vi.advanceTimersByTimeAsync(0);
    ports.listRepositories.mockResolvedValue([secondRepo]); ports.listOpenPullRequests.mockImplementation(async (_scope, repository) => [queuePull({repository})]);
    const current = await service.read({workspaceId: "w"}); release();
    expect(current.items[0].pullRequest.repository.externalId).toBe("2");
    expect((await old).items[0].pullRequest.repository.externalId).toBe("2");
    expect((await service.read({workspaceId: "w"})).snapshotId).toBe(current.snapshotId);
  });
  it("evicts least recently used complete snapshots after four entries", async () => {
    const { ports, service } = setup(); ports.resolveScope.mockImplementation(async (workspaceId: string) => ({...scope, workspaceId}));
    const first = await service.read({workspaceId: "1"});
    for (const workspaceId of ["2", "3", "4", "5"]) await service.read({workspaceId});
    expect((await service.read({workspaceId: "1"})).snapshotId).not.toBe(first.snapshotId);
  });
  it("uses fixed completion TTL, expires at equality, and never polls", async () => {
    const { ports, service } = setup(); const first = await service.read({ workspaceId: "w" });
    expect(first.repositories[0].recordId).toBeNull();
    await vi.advanceTimersByTimeAsync(59_999); expect((await service.read({ workspaceId: "w" })).snapshotId).toBe(first.snapshotId);
    await vi.advanceTimersByTimeAsync(1); expect((await service.read({ workspaceId: "w" })).snapshotId).not.toBe(first.snapshotId);
    await vi.advanceTimersByTimeAsync(120_000); expect(ports.listOpenPullRequests).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("coalesces forced and ordinary reads while a canceled viewer leaves others running", async () => {
    const { ports, service } = setup(); let release!: () => void;
    ports.listOpenPullRequests.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return [queuePull()]; });
    const controller = new AbortController(); const one = service.read({ workspaceId: "w", signal: controller.signal });
    const rejected = expect(one).rejects.toMatchObject({ name: "AbortError" });
    const two = service.read({ workspaceId: "w", forceRefresh: true }); await vi.advanceTimersByTimeAsync(0);
    controller.abort(); release(); await rejected; expect((await two).totalOpen).toBe(1); expect(ports.listOpenPullRequests).toHaveBeenCalledTimes(1);
  });
  it("distinguishes list failure from unknown review details and excludes closed pulls", async () => {
    const { ports, service } = setup(); ports.listOpenPullRequests.mockRejectedValueOnce(new PullRequestQueueUnavailableError("provider_unavailable"));
    expect((await service.read({ workspaceId: "w" })).totalOpen).toBeNull();
    ports.readReviewState.mockRejectedValueOnce(new PullRequestQueueUnavailableError("provider_unavailable"));
    const partial = await service.read({ workspaceId: "w" }); expect(partial.totalOpen).toBe(1); expect(partial.items[0].attention.badge).toBe("status_unknown");
    ports.readReviewState.mockResolvedValueOnce({ status: "closed" } as never); expect((await service.read({ workspaceId: "w" })).totalOpen).toBe(0);
  });
  it("fails closed within the overall deadline if final inventory cannot be revalidated", async () => {
    const { ports, service } = setup();
    ports.readReviewState.mockImplementationOnce(() => new Promise(() => {}));
    ports.listRepositories.mockImplementationOnce(async () => [queuePull().repository]).mockImplementationOnce(() => new Promise(() => {}));
    const pending = service.read({workspaceId: "w"}); await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending; expect(result.status).toBe("unavailable"); expect(result.items).toEqual([]); expect(result.totalOpen).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retains metadata at deadline even when provider ignores cancellation", async () => {
    const { ports, service } = setup(); ports.readReviewState.mockImplementationOnce(() => new Promise(() => {}));
    const pending = service.read({ workspaceId: "w" }); await vi.advanceTimersByTimeAsync(60_000); const result = await pending;
    expect(result.items).toHaveLength(1); expect(result.classificationComplete).toBe(false); expect(result.items[0].attention.badge).toBe("status_unknown");
  });
  it("rejects revoked scope on cache hits and revalidates before stale fallback", async () => {
    const { ports, service } = setup(); const first = await service.read({ workspaceId: "w" });
    ports.listOpenPullRequests.mockRejectedValueOnce(new PullRequestQueueUnavailableError("rate_limited"));
    const stale = await service.read({ workspaceId: "w", forceRefresh: true }); expect(stale.stale).toBe(true); expect(stale.acquiredAt).toBe(first.acquiredAt);
    ports.assertActive.mockRejectedValue(new PullRequestQueueUnavailableError("authority")); await expect(service.read({ workspaceId: "w" })).rejects.toMatchObject({ reason: "authority" });
  });
  it("keeps repository-scoped assessment keys for identical PR numbers", async () => {
    const { ports, service } = setup(); const a = queuePull(); const b = queuePull({ repository: { ...a.repository, externalId: "2", name: "web" } });
    ports.listRepositories.mockResolvedValue([a.repository, b.repository]); ports.listOpenPullRequests.mockImplementation(async (_s, repo) => [repo.externalId === "1" ? a : b]);
    ports.readAssessments.mockResolvedValue(new Map([[queuePullRequestKey(b.repository, b.number), queueAssessment({ decisionId: "only-b" })]]));
    const result = await service.read({ workspaceId: "w" }); expect(result.items.map(i => i.assessment?.decisionId ?? null)).toEqual([null, "only-b"]);
  });
});
