import { describe, expect, it, vi } from "vitest";
import { createJobClaimer, createWorkspaceJobQueue, startQueueSyncRun, invalidateQueuePull, readQueueProjection } from "@triagepilot/db";
import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import { createWorkerPullRequestSync } from "../src/pull-request-sync";
import { runWorkerOnce } from "../src/runner";
import { runWorkerMaintenance, runWorkerStartup } from "../src/maintenance";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("queue worker loop", () => {
  it("yields between provider pages to routing and maintenance, and persists rate-limit backoff", async () => withPostgresTestDatabase(async db => {
    const workspace = await db.insertInto("workspaces").values({ external_key: "worker-sync-loop" }).returning("id").executeTakeFirstOrThrow();
    const connection = await db.insertInto("provider_connections").values({ workspace_id: workspace.id, provider: "github", external_connection_id: "99", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    const scope = { workspaceId: workspace.id, providerConnectionId: connection.id, externalInstallationId: "99" };
    const run = await startQueueSyncRun(db, scope);
    const calls: number[] = [];
    const requester = { async request(_route: string, params: Record<string, unknown>) {
      const page = Number(params.page); calls.push(page);
      if (page === 2) throw { status: 429, response: { headers: { "retry-after": "120" } } };
      return { data: { total_count: 101, repositories: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `repo${i + 1}`, owner: { login: "acme" } })) } };
    } };
    const sync = createWorkerPullRequestSync({ db, github: { appId: "1", privateKey: "key" }, githubOrganization: "acme", createRequester: (async () => requester) as never });
    const claimer = createJobClaimer(db), queue = createWorkspaceJobQueue(db, workspace.id);
    const routing = vi.fn(async () => {});
    const heartbeat = vi.fn(async () => {});
    const maintenance = { recoverStaleJobs: vi.fn(async () => {}), cleanupRevokedProviderConnections: vi.fn(async () => {}), applyRetention: vi.fn(async () => {}), updateHeartbeat: heartbeat, drainPlatformOutbox: vi.fn(async () => {}) };
    const now = new Date();
    let state = await runWorkerStartup(maintenance, now);
    const cycle = async () => {
      state = await runWorkerMaintenance(state, maintenance, new Date());
      return runWorkerOnce({ jobClaimer: claimer, workspaceQueue: () => queue, workerId: "worker", now: new Date(Date.now() + 1_000), processRoutingJob: routing, buildRoutingServices: () => ({}) as never,
        async processQueueSyncJob(_job, lease) { await sync.reconcile(scope, run.runId, lease); } });
    };
    expect(await cycle()).toBe(true);
    expect(calls).toEqual([1]);
    await db.insertInto("jobs").values({ workspace_id: workspace.id, provider: "github", provider_connection_id: connection.id, external_installation_id: "99", external_repository_id: "1", kind: "process_pull_request", idempotency_key: "routing-test", payload: { kind: "process_change_request", deliveryId: "delivery", eventName: "pull_request.opened", workspaceId: workspace.id, providerConnectionId: connection.id, changeRequest: { repository: { provider: "github", externalId: "1", owner: "acme", name: "repo1" }, externalId: "7", number: 7, baseRevision: "base", headRevision: "head" }, isDraft: false, routingKey: "routing-test" } }).execute();
    expect(await cycle()).toBe(true);
    expect(routing).toHaveBeenCalledOnce(); expect(calls).toEqual([1]);
    await db.updateTable("jobs").set({ attempt_count: 4 }).where("kind", "=", "reconcile_queue_connection").where("status", "=", "queued").execute();
    expect(await cycle()).toBe(true);
    expect(calls).toEqual([1, 2]);
    expect(heartbeat).toHaveBeenCalledTimes(4);
    const dispatch = await db.selectFrom("jobs").select(["status", "run_at", "last_error", "attempt_count", "max_attempts"]).where("kind", "=", "reconcile_queue_connection").where("status", "=", "queued").executeTakeFirstOrThrow();
    expect(dispatch.run_at.getTime()).toBeGreaterThan(Date.now() + 119_000);
    expect(dispatch.attempt_count).toBe(5);
    expect(dispatch.max_attempts).toBe(20);
    expect(dispatch.last_error).toBeTruthy();
    expect(await cycle()).toBe(false);
  }));
  it("persists each inventory and pull page through a complete empty scan", async () => withPostgresTestDatabase(async db => {
    const workspace = await db.insertInto("workspaces").values({ external_key: "adapter-scan" }).returning("id").executeTakeFirstOrThrow();
    const connection = await db.insertInto("provider_connections").values({ workspace_id: workspace.id, provider: "github", external_connection_id: "99", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    const scope = { workspaceId: workspace.id, providerConnectionId: connection.id, externalInstallationId: "99" };
    const run = await startQueueSyncRun(db, scope), claimer = createJobClaimer(db);
    const request = vi.fn(async (route: string) => ({ data: route.includes("installation") ? { total_count: 1, repositories: [{ id: 1, name: "repo", owner: { login: "acme" } }] } : [] }));
    const sync = createWorkerPullRequestSync({ db, github: { appId: "1", privateKey: "key" }, githubOrganization: "acme", createRequester: (async () => ({ request })) as never });
    for (let i = 0; i < 4; i++) {
      const job = await claimer.claimNext("worker", new Date(Date.now() + 1_000)); expect(job).not.toBeNull();
      await sync.reconcile(scope, run.runId, { jobId: job!.id, workspaceId: job!.workspaceId, provider: job!.provider, providerConnectionId: job!.providerConnectionId, lockedBy: job!.lockedBy!, lockedAt: job!.lockedAt!, attemptCount: job!.attemptCount, maxAttempts: job!.maxAttempts });
    }
    const result = await db.selectFrom("queue_sync_runs").select(["status", "membership_complete", "classification_complete", "verified_at"]).where("id", "=", run.runId).executeTakeFirstOrThrow();
    expect(result).toMatchObject({ status: "succeeded", membership_complete: true, classification_complete: true, verified_at: expect.any(Date) });
    expect(request).toHaveBeenCalledTimes(2);
    expect(await claimer.claimNext("worker", new Date(Date.now() + 1_000))).toBeNull();
  }));

  it("acknowledges a refreshed pull snapshot using the claimed lease", async () => withPostgresTestDatabase(async db => {
    const workspace = await db.insertInto("workspaces").values({ external_key: "adapter-pull" }).returning("id").executeTakeFirstOrThrow();
    const connection = await db.insertInto("provider_connections").values({ workspace_id: workspace.id, provider: "github", external_connection_id: "99", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    const repo = await db.insertInto("repositories").values({ workspace_id: workspace.id, provider: "github", provider_connection_id: connection.id, external_repository_id: "1", owner: "acme", name: "repo", default_branch: null, config_state: "unknown" }).returning("id").executeTakeFirstOrThrow();
    const scope = { workspaceId: workspace.id, providerConnectionId: connection.id, externalInstallationId: "99" }, key = { ...scope, repositoryId: repo.id, externalRepositoryId: "1", pullNumber: 7 };
    await invalidateQueuePull(db, key);
    const claimer = createJobClaimer(db), job = (await claimer.claimNext("worker", new Date(Date.now() + 1_000)))!;
    const request = vi.fn(async () => ({ data: { id: 7, number: 7, state: "open", title: "Draft", user: { id: 12, login: "alex", type: "User" }, created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-02T00:00:00Z", draft: true, base: { sha: "base", repo: { id: 1, name: "repo", owner: { login: "acme" } } }, head: { sha: "head" }, requested_reviewers: [], requested_teams: [] } }));
    const sync = createWorkerPullRequestSync({ db, github: { appId: "1", privateKey: "key" }, githubOrganization: "acme", createRequester: (async () => ({ request })) as never });
    await sync.refresh(key, { jobId: job.id, workspaceId: job.workspaceId, provider: job.provider, providerConnectionId: job.providerConnectionId, lockedBy: job.lockedBy!, lockedAt: job.lockedAt!, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts });
    expect((await readQueueProjection(db, scope)).snapshots).toHaveLength(1);
    expect((await db.selectFrom("jobs").select("status").where("id", "=", job.id).executeTakeFirstOrThrow()).status).toBe("succeeded");
    expect(await claimer.claimNext("worker", new Date(Date.now() + 1_000))).toBeNull();
  }));

});
