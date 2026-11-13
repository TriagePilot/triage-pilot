import { describe, expect, it, vi } from "vitest";
import { createPullRequestSyncService, type PullRequestSyncPorts, type SyncPullKey, type SyncSnapshot } from "../src/pull-request-sync.js";
import { PullRequestQueueUnavailableError, type QueuePullRequest } from "@triagepilot/contracts";
const repository = { provider: "github" as const, externalId: "1", owner: "acme", name: "repo" };
const key: SyncPullKey = { workspaceId: "w", providerConnectionId: "c", externalInstallationId: "i", repositoryId: "r", externalRepositoryId: "1", pullNumber: 1 };
const pull: QueuePullRequest = { repository, changeRequestId: "1", number: 1, title: "test", author: { id: "u", login: "user", type: "human" }, createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-02T00:00:00Z", baseRevision: "base", headRevision: "head", isDraft: false, requestedUsers: [], requestedTeams: [] };
function fixture() {
  let checkpoint: unknown = null, generation = 1; let committed: SyncSnapshot | undefined; let runCheckpoint: unknown = null;
  const effects: unknown[] = []; const reads: string[] = [];
  const ports: PullRequestSyncPorts<string, string, number> = {
    now: () => new Date("2020-03-01T00:00:00Z"), resolveRepository: async () => repository, assertAuthorized: vi.fn(async () => {}),
    claimPull: async (_key, lease) => ({ token: { generation, snapshotRevision: 0, lease }, checkpoint, snapshot: null }),
    continuePull: async (_key, token, value) => { if (token.generation !== generation) return false; checkpoint = value; return true; },
    commitPull: async (_key, token, value) => { if (token.generation !== generation) return false; committed = value; return true; },
    readPull: async () => { reads.push("pull"); return { status: "open", pull }; },
    listReviews: async ({ page }) => { reads.push(`reviews${page}`); return { reviews: [], nextPage: page === 1 ? 2 : null }; },
    listLifecycle: async () => { reads.push("lifecycle"); return { reopenedAt: ["2020-02-01T00:00:00Z"], nextPage: null }; },
    claimRun: async () => ({ token: 1, checkpoint: runCheckpoint }),
    commitRunPage: async (_scope, _id, _token, next, effect) => { runCheckpoint = effect.type === "missing" ? effect.nextCheckpoint : next; effects.push(effect); return true; },
    listRepositories: async (_scope, { page }) => ({ repositories: page === 1 ? [repository] : [], totalCount: 1, nextPage: page === 1 ? 2 : null }),
    listPulls: async () => ({ pulls: [], nextPage: null }),
  };
  return { ports, reads, effects, get committed() { return committed; }, invalidate() { generation++; }, get checkpoint() { return checkpoint; } };
}
describe("pull request synchronization chunks", () => {
  it("reads one page per chunk and confirms current lifecycle before committing", async () => {
    const f = fixture(), service = createPullRequestSyncService(f.ports);
    for (let i = 0; i < 5; i++) expect(await service.refreshPullChunk(key, "lease")).toEqual({ done: i === 4 });
    expect(f.reads).toEqual(["pull", "reviews1", "reviews2", "lifecycle", "pull"]);
    expect(f.committed?.reviewState.lifecycle).toEqual({ status: "complete", openedSince: "2020-02-01T00:00:00Z" });
  });
  it("does not enrich drafts or bots, but enriches a pull that becomes ready", async () => {
    for (const excluded of [{ ...pull, isDraft: true }, { ...pull, author: { ...pull.author, type: "bot" as const } }]) {
      const f = fixture(); f.ports.readPull = async () => ({ status: "open", pull: excluded });
      expect(await createPullRequestSyncService(f.ports).refreshPullChunk(key, "lease")).toEqual({ done: true });
      expect(f.reads).toEqual([]); expect(f.committed?.reviewState.status).toBe("unavailable");
    }
    const f = fixture(); await createPullRequestSyncService(f.ports).refreshPullChunk(key, "lease");
    expect(f.reads).toEqual(["pull"]); expect(f.checkpoint).toMatchObject({ stage: "reviews" });
  });
  it("retains data when an individual read is missing or access is revoked", async () => {
    const f = fixture(); f.ports.readPull = async () => ({ status: "missing" });
    await expect(createPullRequestSyncService(f.ports).refreshPullChunk(key, "lease")).rejects.toMatchObject({ reason: "authority" });
    expect(f.committed).toBeUndefined();
    const g = fixture(); g.ports.assertAuthorized = async () => { throw new Error("revoked"); };
    await expect(createPullRequestSyncService(g.ports).refreshPullChunk(key, "lease")).rejects.toThrow("revoked"); expect(g.reads).toEqual([]);
  });
  it("discards an event-raced provider read and leaves acknowledgement to reschedule", async () => {
    const f = fixture(); f.ports.readPull = async () => { f.invalidate(); return { status: "open", pull }; };
    expect(await createPullRequestSyncService(f.ports).refreshPullChunk(key, "lease")).toEqual({ done: true });
    expect(f.checkpoint).toBeNull(); expect(f.committed).toBeUndefined();
  });
  it("restarts after an invalidation and never applies a stale checkpoint", async () => {
    const f = fixture(), service = createPullRequestSyncService(f.ports);
    await service.refreshPullChunk(key, "lease"); f.invalidate(); await service.refreshPullChunk(key, "new lease");
    expect(f.reads).toEqual(["pull", "pull"]); expect(f.committed).toBeUndefined();
  });
  it("keeps lifecycle unknown on failure but propagates rate limiting", async () => {
    const f = fixture(), service = createPullRequestSyncService(f.ports);
    f.ports.listLifecycle = async () => { throw new PullRequestQueueUnavailableError("provider_unavailable"); };
    for (let i = 0; i < 5; i++) await service.refreshPullChunk(key, "lease");
    expect(f.committed?.reviewState.lifecycle).toEqual({ status: "unavailable", openedSince: null });
    const g = fixture(), retry = createPullRequestSyncService(g.ports); g.ports.listLifecycle = async () => { throw new PullRequestQueueUnavailableError("rate_limited"); };
    for (let i = 0; i < 3; i++) await retry.refreshPullChunk(key, "lease");
    await expect(retry.refreshPullChunk(key, "lease")).rejects.toMatchObject({ reason: "rate_limited" });
  });
  it("materializes inventory pages including an empty repository, then records completed scans", async () => {
    const f = fixture(), service = createPullRequestSyncService(f.ports);
    for (let i = 0; i < 5; i++) await service.reconcileConnectionChunk("scope", "run", "lease");
    expect(f.effects).toEqual([{ type: "inventory", repositories: [repository] }, { type: "inventory", repositories: [] }, { type: "pulls", repository, pulls: [], complete: true }, { type: "missing", repository, nextCheckpoint: { stage: "pulls", repositories: [repository], index: 1, page: 1 } }, { type: "finish" }]);
  });
  it("does not advance a failed later scan page", async () => {
    const f = fixture(), service = createPullRequestSyncService(f.ports); await service.reconcileConnectionChunk("scope", "run", "lease");
    f.ports.listRepositories = async () => { throw new PullRequestQueueUnavailableError("provider_unavailable"); };
    await expect(service.reconcileConnectionChunk("scope", "run", "lease")).rejects.toThrow(); expect(f.effects).toHaveLength(1);
  });
  it("rejects a truncated final inventory page before reconciling removals", async () => {
    const f = fixture(); f.ports.listRepositories = async () => ({ repositories: [], totalCount: 1, nextPage: null });
    await expect(createPullRequestSyncService(f.ports).reconcileConnectionChunk("scope", "run", "lease")).rejects.toMatchObject({ reason: "invalid_response" });
    expect(f.effects).toEqual([]);
  });

});
