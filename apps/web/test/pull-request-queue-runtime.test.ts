import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRepositories, ensureLocalWorkspace } from "@triagepilot/db";
import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import { createPullRequestQueueRuntime } from "../src/pull-request-queue-runtime";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("stored pull request queue runtime", () => {
  it("returns bootstrap and schedules a coalesced manual refresh without provider access", async () => withPostgresTestDatabase(async db => {
    const workspaceId = await ensureLocalWorkspace(db), repositories = createWorkspaceRepositories(db, workspaceId);
    await repositories.activateConfiguredProviderConnection({ provider: "github", externalConnectionId: "99", workspaceLogin: "acme", accountType: "Organization" });
    const createRequester = vi.fn(() => { throw new Error("unexpected provider request"); });
    const runtime = createPullRequestQueueRuntime({ db, workspaceId, githubOrganization: "acme", github: { appId: "123", privateKey: "unused", webhookSecret: "secret" }, now: () => new Date(), createRequester: createRequester as never });
    try {
      expect(await runtime.readPullRequestQueue({ forceRefresh: false })).toMatchObject({ status: "unavailable", syncState: "unavailable", totalOpen: null, workerAvailable: false });
      await runtime.readPullRequestQueue({ forceRefresh: true });
      await runtime.readPullRequestQueue({ forceRefresh: true });
      expect(await db.selectFrom("queue_sync_runs").selectAll().execute()).toHaveLength(1);
      expect(createRequester).not.toHaveBeenCalled();
      await repositories.suspendConfiguredProviderConnection({ provider: "github", externalConnectionId: "99", workspaceLogin: "acme", accountType: "Organization" });
      await expect(runtime.readPullRequestQueue({ forceRefresh: false })).rejects.toMatchObject({ reason: "authority" });
    } finally { runtime.disposePullRequestQueue(); }
  }));
});

it.runIf(Boolean(process.env.TEST_DATABASE_URL))("reads persisted rows, reports partial scan progress, and fences an in-place reinstall", async () => withPostgresTestDatabase(async db => {
  const { queuePull, queueReviewState } = await import("../../../test/pull-request-queue-fixtures");
  const workspaceId = await ensureLocalWorkspace(db), repos = createWorkspaceRepositories(db, workspaceId);
  await repos.activateConfiguredProviderConnection({ provider: "github", externalConnectionId: "99", workspaceLogin: "acme", accountType: "Organization" });
  const connection = await db.selectFrom("provider_connections").selectAll().where("workspace_id", "=", workspaceId).executeTakeFirstOrThrow();
  const addRepo = async (externalId: string) => db.insertInto("repositories").values({ workspace_id: workspaceId, provider: "github", provider_connection_id: connection.id, external_repository_id: externalId, owner: "acme", name: externalId, default_branch: "main", config_state: "valid" }).returning("id").executeTakeFirstOrThrow();
  const api = await addRepo("api"), other = await addRepo("other");
  const apiRef = { provider: "github" as const, externalId: "api", owner: "acme", name: "api" }, otherRef = { ...apiRef, externalId: "other", name: "other" };
  const pull = queuePull({ number: 7, repository: apiRef, requestedUsers: [{ id: "reviewer", login: "bob", type: "human" }] });
  const insertSnapshot = async (installation: string, item: ReturnType<typeof queuePull>, reviewState = queueReviewState()) => db.insertInto("queue_pull_work").values({ workspace_id: workspaceId, provider_connection_id: connection.id, external_installation_id: installation, repository_id: api.id, external_repository_id: "api", pull_number: item.number, desired_generation: 1, applied_generation: 1, snapshot_revision: 1, snapshot: { pull: item, reviewState, isOpen: true, verifiedAt: "2026-01-01T00:00:00.000Z" }, verified_at: new Date("2026-01-01T00:00:00Z") }).execute();
  await insertSnapshot("99", pull);
  await insertSnapshot("99", queuePull({ ...pull, number: 8, isDraft: true }));
  await insertSnapshot("99", queuePull({ ...pull, number: 9, author: { id: "bot", login: "bot", type: "bot" } }));
  await db.insertInto("routing_decisions").values({ workspace_id: workspaceId, repository_id: api.id, origin_provider_connection_id: connection.id, origin_external_installation_id: "99", origin_external_repository_id: "api", delivery_id: "delivery", routing_key: "decision", action: "request_human_review", risk_score: 1, selected_reviewer: "bob", selected_reviewers: JSON.stringify(["bob"]), no_human_reason: null, pull_number: 7, change_request_id: "7", head_sha: "head", mode: "enforce", action_status: "succeeded", action_error: null, details: { risk: { tier: "medium" }, routing: { requestedReviewerCount: 1, selectedReviewers: ["bob"] } }, effective_config_hash: "hash", inheritance_mode: "legacy", repository_config_revision: "base", policy_check_state: "success", created_at: new Date("2026-01-01T00:00:00Z") }).execute();
  const selected = await db.selectFrom("provider_connections").select("queue_selection_revision").where("id", "=", connection.id).executeTakeFirstOrThrow();
  await db.insertInto("queue_sync_runs").values({ workspace_id: workspaceId, provider_connection_id: connection.id, external_installation_id: "99", status: "running", checkpoint: { stage: "pulls", page: 1, index: 1, repositories: [apiRef, otherRef] }, selection_revision: selected.queue_selection_revision, updated_at: new Date("2026-01-01T00:01:00Z") }).execute();
  const createRequester = vi.fn(() => { throw new Error("unexpected provider access"); });
  const runtime = createPullRequestQueueRuntime({ db, workspaceId, githubOrganization: "acme", github: { appId: "123", privateKey: "unused", webhookSecret: "secret" }, now: () => new Date("2026-01-01T00:01:10Z"), createRequester: createRequester as never });
  try {
    const partial = await runtime.readPullRequestQueue({ forceRefresh: false });
    expect(partial).toMatchObject({ status: "partial", totalOpen: null, coveredRepositoryIds: ["api"], unavailableRepositoryIds: [], syncProgress: { completedRepositories: 1, totalRepositories: 2 } });
    expect(partial.items).toHaveLength(1);
    expect(partial.items[0]).toMatchObject({ pullRequest: { author: { login: "alice" }, requestedUsers: [{ login: "bob" }] }, attention: { assessmentStatus: "current", group: "reviewers" } });
    await db.updateTable("queue_sync_runs").set({ status: "failed", verification_error: "provider request failed" }).where("external_installation_id", "=", "99").execute();
    expect(await runtime.readPullRequestQueue({ forceRefresh: false })).toMatchObject({ coveredRepositoryIds: ["api"], unavailableRepositoryIds: [], refreshError: "Pull request queue synchronization failed" });
    await db.updateTable("queue_sync_runs").set({ status: "running", verification_error: null }).where("external_installation_id", "=", "99").execute();
    await db.insertInto("queue_sync_runs").values({ workspace_id: workspaceId, provider_connection_id: connection.id, external_installation_id: "99", status: "succeeded", checkpoint: { stage: "done" }, selection_revision: selected.queue_selection_revision, membership_complete: true, classification_complete: true, verified_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z") }).execute();
    await db.updateTable("queue_pull_work").set({ desired_generation: 2 }).where("external_installation_id", "=", "99").where("pull_number", "=", 7).execute();
    const exhausted = await runtime.readPullRequestQueue({ forceRefresh: false });
    expect(exhausted).toMatchObject({ status: "partial", membershipComplete: false, totalOpen: null, classificationComplete: false, enrichmentPending: false });
    expect(exhausted.items[0]).toMatchObject({ assessment: null, attention: { assessmentStatus: "missing" } });
    await db.updateTable("queue_pull_work").set({ desired_generation: 1 }).where("external_installation_id", "=", "99").where("pull_number", "=", 7).execute();
    await db.insertInto("queue_pull_work").values({ workspace_id: workspaceId, provider_connection_id: connection.id, external_installation_id: "99", repository_id: api.id, external_repository_id: "api", pull_number: 10, desired_generation: 1, applied_generation: 0, snapshot: null }).execute();
    expect(await runtime.readPullRequestQueue({ forceRefresh: false })).toMatchObject({ status: "partial", membershipComplete: false, totalOpen: null, classificationComplete: false });
    await db.deleteFrom("queue_pull_work").where("external_installation_id", "=", "99").where("pull_number", "=", 10).execute();
    await db.updateTable("queue_pull_work").set({ desired_generation: 2, snapshot: { pull, reviewState: queueReviewState(), isOpen: false, verifiedAt: "2026-01-01T00:00:00.000Z" } }).where("external_installation_id", "=", "99").where("pull_number", "=", 7).execute();
    expect(await runtime.readPullRequestQueue({ forceRefresh: false })).toMatchObject({ membershipComplete: false, totalOpen: null });
    await db.updateTable("provider_connections").set({ external_connection_id: "100" }).where("id", "=", connection.id).execute();
    const empty = await runtime.readPullRequestQueue({ forceRefresh: false });
    expect(empty).toMatchObject({ status: "unavailable", items: [] });
    await insertSnapshot("100", pull, queueReviewState({ status: "unavailable" }));
    const replaced = await runtime.readPullRequestQueue({ forceRefresh: false });
    expect(replaced.items).toHaveLength(1);
    expect(replaced.items[0]).toMatchObject({ assessment: null, attention: { assessmentStatus: "missing", badge: "status_unknown" } });
    expect(createRequester).not.toHaveBeenCalled();
  } finally { runtime.disposePullRequestQueue(); }
}));
