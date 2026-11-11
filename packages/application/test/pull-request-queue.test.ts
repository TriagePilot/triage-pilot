import { afterEach, describe, expect, it, vi } from "vitest";
import { PullRequestQueueUnavailableError, queuePullRequestKey, type PullRequestQueueScope } from "@triagepilot/contracts";
import { queueAssessment, queuePull, queueReviewState } from "../../../test/pull-request-queue-fixtures.js";
import { createPullRequestQueueService, type PullRequestQueuePorts } from "../src/pull-request-queue.js";
const scope: PullRequestQueueScope = { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "1", githubOrganization: "acme", knownRepositories: [] };
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01")); let id = 0;
  const ports = { now: () => new Date(), createSnapshotId: () => String(++id), resolveScope: vi.fn<PullRequestQueuePorts["resolveScope"]>(async () => scope), assertActive: vi.fn(async () => {}), listRepositories: vi.fn<PullRequestQueuePorts["listRepositories"]>(async () => [queuePull().repository]), listOpenPullRequests: vi.fn<PullRequestQueuePorts["listOpenPullRequests"]>(async () => [queuePull()]), readAssessments: vi.fn<PullRequestQueuePorts["readAssessments"]>(async () => new Map()), readReviewState: vi.fn<PullRequestQueuePorts["readReviewState"]>(async () => queueReviewState()), linksFor: vi.fn(() => ({ provider: "https://github.com/acme/api/pull/1", decision: null })) } satisfies PullRequestQueuePorts;
  return { ports, service: createPullRequestQueueService(ports) };
}
afterEach(() => vi.useRealTimers());
describe("queue acquisition", () => {
  it("retries both viewers' details against a manually refreshed list", async () => {
    const { ports, service } = setup(); let release!: (value: ReturnType<typeof queueReviewState>) => void;
    ports.readReviewState.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await service.readInitial({ workspaceId: "w" });
    const old = service.read({ workspaceId: "w", progressive: true });
    const otherViewer = service.read({ workspaceId: "w", progressive: true });
    await vi.advanceTimersByTimeAsync(0);
    ports.listOpenPullRequests.mockResolvedValue([queuePull({ number: 2, changeRequestId: "2" })]);
    const fresh = await service.readInitial({ workspaceId: "w", forceRefresh: true });
    release(queueReviewState());
    expect(fresh.items.map(item => item.pullRequest.number)).toEqual([2]);
    expect((await old).items.map(item => item.pullRequest.number)).toEqual([2]);
    expect((await otherViewer).items.map(item => item.pullRequest.number)).toEqual([2]); service.dispose();
  });
  it("retries both viewers' details when another viewer renews an expired list", async () => {
    const { ports, service } = setup(); let release!: (value: ReturnType<typeof queueReviewState>) => void;
    ports.readReviewState.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await service.readInitial({ workspaceId: "w" });
    await vi.advanceTimersByTimeAsync(59_000);
    const first = service.read({ workspaceId: "w", progressive: true });
    const second = service.read({ workspaceId: "w", progressive: true });
    await vi.advanceTimersByTimeAsync(1_000);
    ports.listOpenPullRequests.mockResolvedValue([queuePull({ number: 2, changeRequestId: "2" })]);
    const fresh = await service.readInitial({ workspaceId: "w" });
    release(queueReviewState());
    expect(fresh.items.map(item => item.pullRequest.number)).toEqual([2]);
    expect((await first).items.map(item => item.pullRequest.number)).toEqual([2]);
    expect((await second).items.map(item => item.pullRequest.number)).toEqual([2]); service.dispose();
  });
  it("revalidates authority when retrying a superseded details acquisition", async () => {
    const { ports, service } = setup();
    ports.readReviewState.mockImplementationOnce(() => new Promise(() => {}));
    await service.readInitial({ workspaceId: "w" });
    const pending = service.read({ workspaceId: "w", progressive: true });
    const rejected = expect(pending).rejects.toMatchObject({ reason: "authority" });
    await vi.advanceTimersByTimeAsync(0);
    // Revoke access while a second viewer's refresh is acquiring the replacement list.
    ports.listOpenPullRequests.mockImplementationOnce(async () => {
      ports.assertActive.mockRejectedValue(new PullRequestQueueUnavailableError("authority"));
      return [queuePull({ number: 2, changeRequestId: "2" })];
    });
    await expect(service.readInitial({ workspaceId: "w", forceRefresh: true })).rejects.toMatchObject({ reason: "authority" });
    await rejected; service.dispose();
  });
  it("reuses a short-lived partial list without losing its coverage warning", async () => {
    const { ports, service } = setup(); const other = { ...queuePull().repository, externalId: "2", name: "other" };
    ports.listRepositories.mockResolvedValue([queuePull().repository, other]);
    ports.listOpenPullRequests.mockImplementation(async (_scope, repo) => {
      if (repo.externalId === "2") throw new PullRequestQueueUnavailableError("provider_unavailable");
      return [queuePull()];
    });
    const initial = await service.readInitial({ workspaceId: "w" });
    expect(initial.membershipComplete).toBe(false); expect(initial.totalOpen).toBeNull(); expect(initial.unavailableRepositoryIds).toEqual(["2"]);
    const partial = await service.read({ workspaceId: "w", progressive: true });
    expect(partial.membershipComplete).toBe(false); expect(partial.totalOpen).toBeNull(); expect(partial.items).toHaveLength(1);
    expect(ports.listOpenPullRequests).toHaveBeenCalledTimes(2); service.dispose();
  });

  it("revalidates authorization before serving the fast list cache", async () => {
    const { ports, service } = setup(); await service.readInitial({ workspaceId: "w" });
    ports.assertActive.mockRejectedValue(new PullRequestQueueUnavailableError("authority"));
    await expect(service.readInitial({ workspaceId: "w" })).rejects.toMatchObject({ reason: "authority" });
    expect(ports.listOpenPullRequests).toHaveBeenCalledTimes(1); service.dispose();
  });
  it("refreshes changed PR status after list expiry and manual refresh", async () => {
    const { ports, service } = setup(); await service.readInitial({ workspaceId: "w" });
    await service.read({ workspaceId: "w", progressive: true }); expect(ports.readReviewState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    ports.listOpenPullRequests.mockResolvedValue([queuePull({ updatedAt: "2026-01-01T00:00:30.000Z" })]);
    await service.readInitial({ workspaceId: "w" }); await service.read({ workspaceId: "w", progressive: true });
    expect(ports.readReviewState).toHaveBeenCalledTimes(2);
    await service.readInitial({ workspaceId: "w", forceRefresh: true }); await service.read({ workspaceId: "w", progressive: true });
    expect(ports.readReviewState).toHaveBeenCalledTimes(3); service.dispose();
  });

  it("rechecks settled review status after list expiry even when PR metadata is unchanged", async () => {
    const { ports, service } = setup();
    await service.readInitial({ workspaceId: "w" });
    await service.read({ workspaceId: "w", progressive: true });
    await vi.advanceTimersByTimeAsync(60000);
    await service.readInitial({ workspaceId: "w" });
    await service.read({ workspaceId: "w", progressive: true });
    expect(ports.readReviewState).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("resumes timed-out review batches without rereading earlier PRs, even when the list expires", async () => {
    const { ports, service } = setup();
    const pulls = Array.from({ length: 11 }, (_, i) => queuePull({ number: i + 1, changeRequestId: String(i + 1) }));
    ports.listOpenPullRequests.mockResolvedValue(pulls);
    ports.readReviewState.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 2000)); return queueReviewState(); });
    await service.readInitial({ workspaceId: "w" });
    const first = service.read({ workspaceId: "w", progressive: true }); await vi.advanceTimersByTimeAsync(5000);
    const part = await first; expect(part.enrichmentPending).toBe(true); expect(part.items.filter(item => item.reviewState.status === "complete")).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(60000); await service.readInitial({ workspaceId: "w" });
    const second = service.read({ workspaceId: "w", progressive: true }); await vi.advanceTimersByTimeAsync(2000);
    const done = await second; expect(done.items.filter(item => item.reviewState.status === "complete")).toHaveLength(11); expect(done.enrichmentPending).toBe(false);
    expect(ports.readReviewState.mock.calls.filter(call => call[1].number === 1)).toHaveLength(1);
    service.dispose();
  });

  it("excludes drafts and bot authors before assessment and review reads", async () => {
    const { ports, service } = setup();
    const human = queuePull(); const draft = queuePull({ number: 2, changeRequestId: "2", isDraft: true });
    const bot = queuePull({ number: 3, changeRequestId: "3", author: { id: "9", login: "dependabot[bot]", type: "bot" } });
    const other = queuePull({ number: 4, changeRequestId: "4", author: { id: "8", login: "org", type: "other" } });
    ports.listOpenPullRequests.mockResolvedValue([human, draft, bot, other]);
    const result = await service.read({ workspaceId: "w" });
    expect(result.items.map(item => item.pullRequest.number)).toEqual([1, 4]); expect(result.totalOpen).toBe(2);
    expect(ports.readAssessments.mock.calls[0][1].map(pull => pull.number)).toEqual([1, 4]);
    expect(ports.readReviewState.mock.calls.map(call => call[1].number)).toEqual([1, 4]);
  });

  it("returns open PRs before slow reviews, caches the list, and enriches without rereading it", async () => {
    const { ports, service } = setup(); let release!: (state: ReturnType<typeof queueReviewState>) => void;
    ports.readReviewState.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = await service.readInitial({ workspaceId: "w" });
    expect(first.items).toHaveLength(1); expect(first.items[0].attention.badge).toBe("checking");
    expect(ports.readReviewState).not.toHaveBeenCalled();
    const second = await service.readInitial({ workspaceId: "w" });
    expect(second.snapshotId).toBe(first.snapshotId); expect(ports.listOpenPullRequests).toHaveBeenCalledTimes(1);
    const detail = service.read({ workspaceId: "w" }); await vi.advanceTimersByTimeAsync(0);
    expect(ports.listOpenPullRequests).toHaveBeenCalledTimes(1);
    release(queueReviewState()); expect((await detail).items[0].reviewState.status).toBe("complete");
  });

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
  it("expires final verification while its provider slot waits behind newer readers", async () => {
    const { ports, service } = setup();
    ports.resolveScope.mockImplementation(async workspaceId => ({ ...scope, workspaceId }));
    ports.listOpenPullRequests.mockResolvedValue(Array.from({ length: 4 }, (_, index) => queuePull({ number: index + 1, changeRequestId: String(index + 1) })));
    ports.readReviewState.mockImplementation(() => new Promise(() => {}));
    ports.listRepositories.mockImplementation(async currentScope => {
      if (currentScope.workspaceId === "w") return [queuePull().repository];
      return new Promise(() => {});
    });
    let settled = false;
    const original = service.read({ workspaceId: "w" }).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(54_000);
    const newer = ["a", "b", "c", "d"].map(workspaceId => service.read({ workspaceId }).catch(error => error));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ports.listRepositories).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(true);
    const result = await original;
    expect(result.status).toBe("unavailable"); expect(result.items).toEqual([]);
    expect(result.acquiredAt).toBe("2026-01-01T00:01:00.000Z");
    // Aborted queued verification never consumes a slot when newer readers release.
    service.dispose(); await Promise.all(newer);
    expect(ports.listRepositories).toHaveBeenCalledTimes(5); expect(vi.getTimerCount()).toBe(0);
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
