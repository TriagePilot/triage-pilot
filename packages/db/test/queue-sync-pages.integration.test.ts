import { describe, expect, it } from "vitest";
import { withPostgresTestDatabase } from "./postgres";
import { claimQueueSyncCheckpoint, commitQueueSyncPage, startQueueSyncRun } from "../src/queue-sync-runs";
import { claimQueuePullChunk, continueQueuePullChunk, invalidateQueuePull } from "../src/pull-request-projection";

const ref = { provider: "github" as const, externalId: "1", owner: "acme", name: "repo" };
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("queue page persistence", () => {
  it("atomically materializes empty inventory and rejects a selection change during a read", async () => withPostgresTestDatabase(async db => {
    const w = await db.insertInto("workspaces").values({ external_key: "pages" }).returning("id").executeTakeFirstOrThrow();
    const c = await db.insertInto("provider_connections").values({ workspace_id: w.id, provider: "github", external_connection_id: "i", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    const scope = { workspaceId: w.id, providerConnectionId: c.id, externalInstallationId: "i" }, run = await startQueueSyncRun(db, scope), at = new Date();
    await db.updateTable("jobs").set({ status: "running", locked_by: "worker", locked_at: at, attempt_count: 1 }).where("id", "=", run.jobId).execute();
    const lease = { jobId: run.jobId, workspaceId: w.id, provider: "github" as const, providerConnectionId: c.id, lockedBy: "worker", lockedAt: at, attemptCount: 1, maxAttempts: 5 };
    const first = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
    expect(await commitQueueSyncPage(db, scope, run.runId, first, { page: 2 }, { type: "inventory", repositories: [ref] })).toBe(true);
    const repo = await db.selectFrom("repositories").select("id").where("workspace_id", "=", w.id).executeTakeFirstOrThrow();
    const stale = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
    await db.deleteFrom("repositories").where("id", "=", repo.id).execute();
    expect(await commitQueueSyncPage(db, scope, run.runId, stale, { page: 3 }, { type: "inventory", repositories: [ref] })).toBe(false);
    expect(await db.selectFrom("repositories").select("id").where("id", "=", repo.id).executeTakeFirst()).toBeUndefined();
    await expect(claimQueueSyncCheckpoint(db, scope, run.runId, lease)).rejects.toThrow("queue selection changed");
    const { completeQueueSyncChunk } = await import("../src/queue-sync-runs");
    expect(await completeQueueSyncChunk(db, scope, run.runId, lease, { done: true })).toEqual({ state: "stale_lease" });
    expect((await startQueueSyncRun(db, scope)).runId).not.toBe(run.runId);
  }));
  it("persists pull progress only for the current generation and lease", async () => withPostgresTestDatabase(async db => {
    const w = await db.insertInto("workspaces").values({ external_key: "pull-pages" }).returning("id").executeTakeFirstOrThrow();
    const c = await db.insertInto("provider_connections").values({ workspace_id: w.id, provider: "github", external_connection_id: "i", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    const r = await db.insertInto("repositories").values({ workspace_id: w.id, provider: "github", provider_connection_id: c.id, external_repository_id: "1", owner: "acme", name: "repo", default_branch: null, config_state: "unknown" }).returning("id").executeTakeFirstOrThrow();
    const key = { workspaceId: w.id, providerConnectionId: c.id, externalInstallationId: "i", repositoryId: r.id, externalRepositoryId: "1", pullNumber: 1 };
    await invalidateQueuePull(db, key); const row = await db.selectFrom("queue_pull_work").select("dispatch_job_id").executeTakeFirstOrThrow(), at = new Date();
    await db.updateTable("jobs").set({ status: "running", locked_by: "worker", locked_at: at, attempt_count: 1 }).where("id", "=", row.dispatch_job_id!).execute();
    const lease = { jobId: row.dispatch_job_id!, workspaceId: w.id, provider: "github" as const, providerConnectionId: c.id, lockedBy: "worker", lockedAt: at, attemptCount: 1, maxAttempts: 5 };
    const { token } = await claimQueuePullChunk(db, key, lease);
    await invalidateQueuePull(db, key);
    expect(await continueQueuePullChunk(db, key, token, { page: 2 })).toBe(false);
    const fresh = await claimQueuePullChunk(db, key, lease);
    expect(await continueQueuePullChunk(db, key, fresh.token, { page: 2 })).toBe(true);
    expect((await db.selectFrom("queue_pull_work").select(["checkpoint", "dispatch_job_id"]).executeTakeFirstOrThrow())).toMatchObject({ checkpoint: { page: 2 } });
    expect(await continueQueuePullChunk(db, key, fresh.token, { page: 3 })).toBe(false);
  }));
  it("schedules one previously open missing pull per chunk and waits for classification", async () => withPostgresTestDatabase(async db => {
    const w = await db.insertInto("workspaces").values({ external_key: "missing-pages" }).returning("id").executeTakeFirstOrThrow();
    const c = await db.insertInto("provider_connections").values({ workspace_id: w.id, provider: "github", external_connection_id: "i", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    const r = await db.insertInto("repositories").values({ workspace_id: w.id, provider: "github", provider_connection_id: c.id, external_repository_id: "1", owner: "acme", name: "repo", default_branch: null, config_state: "unknown" }).returning("id").executeTakeFirstOrThrow();
    const scope = { workspaceId: w.id, providerConnectionId: c.id, externalInstallationId: "i" }, run = await startQueueSyncRun(db, scope), at = new Date();
    await db.updateTable("jobs").set({ status: "running", locked_by: "worker", locked_at: at, attempt_count: 1 }).where("id", "=", run.jobId).execute();
    const lease = { jobId: run.jobId, workspaceId: w.id, provider: "github" as const, providerConnectionId: c.id, lockedBy: "worker", lockedAt: at, attemptCount: 1, maxAttempts: 5 };
    for (const number of [1, 2, 3]) {
      await invalidateQueuePull(db, { ...scope, repositoryId: r.id, externalRepositoryId: "1", pullNumber: number });
      const snapshot = { isOpen: number !== 3, pull: { isDraft: false, author: { type: "human" } }, reviewState: { status: "complete", lifecycle: { status: "complete" } } };
      await db.updateTable("queue_pull_work").set({ snapshot: JSON.stringify(snapshot), applied_generation: 1 }).where("pull_number", "=", number).execute();
    }
    let token = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
    expect(await commitQueueSyncPage(db, scope, run.runId, token, { stage: "pulls", repositories: [ref], index: 0, page: 1 }, { type: "inventory", repositories: [ref] })).toBe(true);
    token = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
    expect(await commitQueueSyncPage(db, scope, run.runId, token, { stage: "missing", repositories: [ref], index: 0 }, { type: "pulls", repository: ref, pulls: [], complete: true })).toBe(true);
    const missing = { type: "missing" as const, repository: ref, nextCheckpoint: { stage: "pulls", repositories: [ref], index: 1, page: 1 } };
    for (let i = 0; i < 3; i++) {
      token = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
      expect(await commitQueueSyncPage(db, scope, run.runId, token, { stage: "missing", repositories: [ref], index: 0 }, missing)).toBe(true);
      const generations = await db.selectFrom("queue_pull_work").select(["pull_number", "desired_generation"]).orderBy("pull_number").execute();
      expect(generations.map(row => row.desired_generation)).toEqual(i === 0 ? [2, 1, 1] : [2, 2, 1]);
    }
    token = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
    expect(await commitQueueSyncPage(db, scope, run.runId, token, { stage: "done" }, { type: "finish" })).toBe(false);
    let stored = await db.selectFrom("queue_sync_runs").select(["membership_complete", "classification_complete", "verified_at"]).where("id", "=", run.runId).executeTakeFirstOrThrow();
    expect(stored).toEqual({ membership_complete: true, classification_complete: false, verified_at: null });
    await db.updateTable("queue_pull_work").set({ applied_generation: 2 }).where("pull_number", "in", [1, 2]).execute();
    token = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
    expect(await commitQueueSyncPage(db, scope, run.runId, token, { stage: "done" }, { type: "finish" })).toBe(true);
    stored = await db.selectFrom("queue_sync_runs").select(["membership_complete", "classification_complete", "verified_at"]).where("id", "=", run.runId).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ membership_complete: true, classification_complete: true, verified_at: expect.any(Date) });
    const { completeQueueSyncChunk, commitQueueSyncCheckpoint, readQueueSyncRun } = await import("../src/queue-sync-runs");
    expect(await completeQueueSyncChunk(db, scope, run.runId, lease, { done: true })).toEqual({ state: "completed" });
    const next = await startQueueSyncRun(db, scope), nextAt = new Date();
    await db.updateTable("jobs").set({ status: "running", locked_by: "next", locked_at: nextAt, attempt_count: 1 }).where("id", "=", next.jobId).execute();
    const nextLease = { ...lease, jobId: next.jobId, lockedBy: "next", lockedAt: nextAt };
    await db.updateTable("queue_pull_work").set({ snapshot: JSON.stringify({ isOpen: true, pull: { isDraft: false, author: { type: "human" } }, reviewState: { status: "complete", lifecycle: { status: "unavailable" } } }) }).where("pull_number", "=", 1).execute();
    const nextToken = await claimQueueSyncCheckpoint(db, scope, next.runId, nextLease);
    expect(await commitQueueSyncCheckpoint(db, scope, next.runId, nextToken, { stage: "pulls", repositories: [], index: 0, page: 1 })).toBe(true);
    const failedToken = await claimQueueSyncCheckpoint(db, scope, next.runId, nextLease);
    expect(await commitQueueSyncPage(db, scope, next.runId, failedToken, { stage: "done" }, { type: "finish" })).toBe(false);
    expect(await completeQueueSyncChunk(db, scope, next.runId, nextLease, { done: false })).toEqual({ state: "completed" });
    expect(await readQueueSyncRun(db, scope, next.runId)).toMatchObject({ status: "failed", membershipComplete: true, classificationComplete: false, verifiedAt: null, verificationError: "pull request classification incomplete" });
    const { readQueueProjection } = await import("../src/pull-request-projection");
    expect((await readQueueProjection(db, scope)).lastVerifiedAt).toEqual(stored.verified_at);
  }));

  it("retries absent exhausted work with no snapshot or a stale closed snapshot", async () => withPostgresTestDatabase(async db => {
    const w = await db.insertInto("workspaces").values({ external_key: "missing-exhausted" }).returning("id").executeTakeFirstOrThrow();
    const c = await db.insertInto("provider_connections").values({ workspace_id: w.id, provider: "github", external_connection_id: "i", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    const r = await db.insertInto("repositories").values({ workspace_id: w.id, provider: "github", provider_connection_id: c.id, external_repository_id: "1", owner: "acme", name: "repo", default_branch: null, config_state: "unknown" }).returning("id").executeTakeFirstOrThrow();
    const scope = { workspaceId: w.id, providerConnectionId: c.id, externalInstallationId: "i" }, at = new Date();
    for (const pullNumber of [1, 2, 3]) {
      await invalidateQueuePull(db, { ...scope, repositoryId: r.id, externalRepositoryId: "1", pullNumber });
      const row = await db.selectFrom("queue_pull_work").select("dispatch_job_id").where("pull_number", "=", pullNumber).executeTakeFirstOrThrow();
      await db.updateTable("jobs").set({ status: "failed" }).where("id", "=", row.dispatch_job_id!).execute();
      if (pullNumber !== 1) await db.updateTable("queue_pull_work").set({ snapshot: JSON.stringify({ isOpen: false }), applied_generation: pullNumber === 3 ? 1 : 0 }).where("pull_number", "=", pullNumber).execute();
    }
    const run = await startQueueSyncRun(db, scope);
    await db.updateTable("jobs").set({ status: "running", locked_by: "worker", locked_at: at, attempt_count: 1 }).where("id", "=", run.jobId).execute();
    const lease = { jobId: run.jobId, workspaceId: w.id, provider: "github" as const, providerConnectionId: c.id, lockedBy: "worker", lockedAt: at, attemptCount: 1, maxAttempts: 5 };
    let token = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
    expect(await commitQueueSyncPage(db, scope, run.runId, token, { stage: "missing", repositories: [ref], index: 0 }, { type: "inventory", repositories: [ref] })).toBe(true);
    const missing = { type: "missing" as const, repository: ref, nextCheckpoint: { stage: "pulls", repositories: [ref], index: 1, page: 1 } };
    for (let chunk = 0; chunk < 3; chunk++) {
      token = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
      expect(await commitQueueSyncPage(db, scope, run.runId, token, { stage: "missing", repositories: [ref], index: 0 }, missing)).toBe(true);
      const rows = await db.selectFrom("queue_pull_work as w").innerJoin("jobs as j", "j.id", "w.dispatch_job_id").select(["w.pull_number", "w.desired_generation", "j.status"]).orderBy("w.pull_number").execute();
      expect(rows).toEqual(chunk === 0 ? [{ pull_number: 1, desired_generation: 2, status: "queued" }, { pull_number: 2, desired_generation: 1, status: "failed" }, { pull_number: 3, desired_generation: 1, status: "failed" }] : [{ pull_number: 1, desired_generation: 2, status: "queued" }, { pull_number: 2, desired_generation: 2, status: "queued" }, { pull_number: 3, desired_generation: 1, status: "failed" }]);
    }
  }));

  it("removes repositories omitted from a completed authoritative inventory", async () => withPostgresTestDatabase(async db => {
    const w = await db.insertInto("workspaces").values({ external_key: "inventory-removal" }).returning("id").executeTakeFirstOrThrow();
    const c = await db.insertInto("provider_connections").values({ workspace_id: w.id, provider: "github", external_connection_id: "i", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    const repo = await db.insertInto("repositories").values({ workspace_id: w.id, provider: "github", provider_connection_id: c.id, external_repository_id: "1", owner: "acme", name: "repo", default_branch: null, config_state: "unknown" }).returning("id").executeTakeFirstOrThrow();
    const scope = { workspaceId: w.id, providerConnectionId: c.id, externalInstallationId: "i" };
    await invalidateQueuePull(db, { ...scope, repositoryId: repo.id, externalRepositoryId: "1", pullNumber: 1 });
    const { queuePull, queueReviewState } = await import("../../../test/pull-request-queue-fixtures.js");
    await db.updateTable("queue_pull_work").set({ snapshot: JSON.stringify({ pull: queuePull({ repository: ref }), reviewState: queueReviewState(), isOpen: true, verifiedAt: new Date() }), applied_generation: 1 }).where("repository_id", "=", repo.id).execute();
    const { readQueueProjection } = await import("../src/pull-request-projection");
    expect((await readQueueProjection(db, scope)).snapshots).toHaveLength(1);
    const run = await startQueueSyncRun(db, scope), at = new Date();
    await db.updateTable("jobs").set({ status: "running", locked_by: "worker", locked_at: at, attempt_count: 1 }).where("id", "=", run.jobId).execute();
    const lease = { jobId: run.jobId, workspaceId: w.id, provider: "github" as const, providerConnectionId: c.id, lockedBy: "worker", lockedAt: at, attemptCount: 1, maxAttempts: 5 };
    const token = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
    expect(await commitQueueSyncPage(db, scope, run.runId, token, { stage: "pulls", repositories: [], index: 0, page: 1 }, { type: "inventory", repositories: [] })).toBe(true);
    expect(await db.selectFrom("repositories").select("id").where("workspace_id", "=", w.id).execute()).toHaveLength(0);
    expect((await readQueueProjection(db, scope)).snapshots).toHaveLength(0);
  }));

  it("exposes discovered metadata while review enrichment is pending", async () => withPostgresTestDatabase(async db => {
    const { queuePull } = await import("../../../test/pull-request-queue-fixtures.js");
    const w = await db.insertInto("workspaces").values({ external_key: "early-pull" }).returning("id").executeTakeFirstOrThrow();
    const c = await db.insertInto("provider_connections").values({ workspace_id: w.id, provider: "github", external_connection_id: "i", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    const scope = { workspaceId: w.id, providerConnectionId: c.id, externalInstallationId: "i" }, run = await startQueueSyncRun(db, scope), at = new Date();
    await db.updateTable("jobs").set({ status: "running", locked_by: "worker", locked_at: at, attempt_count: 1 }).where("id", "=", run.jobId).execute();
    const lease = { jobId: run.jobId, workspaceId: w.id, provider: "github" as const, providerConnectionId: c.id, lockedBy: "worker", lockedAt: at, attemptCount: 1, maxAttempts: 5 };
    let token = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
    await commitQueueSyncPage(db, scope, run.runId, token, { stage: "pulls", repositories: [ref], index: 0, page: 1 }, { type: "inventory", repositories: [ref] });
    token = await claimQueueSyncCheckpoint(db, scope, run.runId, lease);
    await commitQueueSyncPage(db, scope, run.runId, token, { stage: "missing", repositories: [ref], index: 0 }, { type: "pulls", repository: ref, pulls: [queuePull({ repository: ref })], complete: true });
    const { readQueueProjection } = await import("../src/pull-request-projection");
    const result = await readQueueProjection(db, scope);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({ snapshot: { isOpen: true, reviewState: { status: "unavailable" } }, desiredGeneration: 1, appliedGeneration: 0 });
  }));

});
