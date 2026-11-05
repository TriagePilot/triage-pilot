import { describe, expect, it } from "vitest";
import { applyFixedRetention, ensureLocalWorkspace, ProviderConnectionUnavailableError } from "../src";
import { AnalyticsScopeUnavailableError, assertAnalyticsScopeActive, readTrackedPullRequests, resolveAnalyticsScope } from "../src/reviewer-backlog";
import { withPostgresTestDatabase } from "./postgres";

const end = new Date("2026-11-05T12:00:00.000Z");
const since = new Date(end.getTime() - 90 * 86_400_000);
type Db = Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0];

async function seed(db: Db, externalKey = "foreign") {
  const workspaceId = externalKey === "local" ? await ensureLocalWorkspace(db) : (await db.insertInto("workspaces").values({ external_key: externalKey }).returning("id").executeTakeFirstOrThrow()).id;
  const connection = await db.insertInto("provider_connections").values({ workspace_id: workspaceId, provider: "github", external_connection_id: externalKey, workspace_login: "AcMe", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
  const repository = await db.insertInto("repositories").values({ workspace_id: workspaceId, provider: "github", provider_connection_id: connection.id, external_repository_id: "101", owner: "aCmE", name: "api", default_branch: "main", config_state: "valid" }).returning("id").executeTakeFirstOrThrow();
  return { workspaceId, connectionId: connection.id, repositoryId: repository.id };
}
async function decision(db: Db, scope: Awaited<ReturnType<typeof seed>>, number: number | null, createdAt: Date, suffix: string, changeRequestId: string | null = number === null ? null : `pr-${number}`) {
  return db.insertInto("routing_decisions").values({ workspace_id: scope.workspaceId, repository_id: scope.repositoryId, delivery_id: suffix, routing_key: suffix, action: "request_human_review", risk_score: 1, selected_reviewer: "alice", selected_reviewers: JSON.stringify(["alice"]), no_human_reason: null, pull_number: number, change_request_id: changeRequestId, head_sha: suffix, mode: "shadow", details: { pullNumber: 90, ownership: { eligibleReviewers: ["alice", "idle"] } }, effective_config_hash: suffix, inheritance_mode: "legacy", created_at: createdAt }).returning("id").executeTakeFirstOrThrow();
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("authorized tracked pull requests", () => {
  it("isolates workspaces, collapses heads, excludes removed and unidentifiable rows, and applies explicit retention cutoff", async () => {
    await withPostgresTestDatabase(async db => {
      const local = await seed(db, "local");
      const foreign = await seed(db);
      await decision(db, foreign, 7, since, "foreign");
      await decision(db, local, 7, since, "first");
      await decision(db, local, 7, new Date(since.getTime() + 1), "next-head");
      await decision(db, local, 90, new Date(since.getTime() - 1), "old");
      await decision(db, local, 91, new Date(since.getTime() - 2), "pinned-old");
      await decision(db, local, 92, end, "at-end");
      await decision(db, local, null, since, "legacy");
      await decision(db, local, 0, since, "invalid-number");
      await decision(db, local, 93, since, "empty-id", " ");
      const removed = await db.insertInto("repositories").values({ workspace_id: local.workspaceId, provider: "github", provider_connection_id: local.connectionId, external_repository_id: "removed", owner: "acme", name: "removed", default_branch: "main", config_state: "valid" }).returning("id").executeTakeFirstOrThrow();
      await decision(db, { ...local, repositoryId: removed.id }, 94, since, "removed");
      await db.deleteFrom("repositories").where("id", "=", removed.id).execute();
      // Queued absence activation pins old rows under the existing retention policy.
      await db.insertInto("jobs").values({ workspace_id: local.workspaceId, provider: "github", provider_connection_id: local.connectionId, kind: "activate_reviewer_absence", payload: {}, idempotency_key: "pin", run_at: end }).execute();
      await applyFixedRetention(db, local.workspaceId, end);
      expect(await db.selectFrom("routing_decisions").select("id").where("routing_key", "=", "pinned-old").executeTakeFirst()).toBeDefined();
      const scope = await resolveAnalyticsScope(db, local.workspaceId, { githubOrganization: "ACME", repositoryIds: [] });
      const result = await readTrackedPullRequests(db, scope, { since, end });
      expect(result.pullRequests.map(pr => pr.changeRequestNumber)).toEqual([7]);
      expect(result.pullRequests).toHaveLength(1);
      expect(result.pullRequests.some(pr => pr.changeRequestNumber === 90)).toBe(false);
      expect(result.pullRequests[0]).toMatchObject({ repositoryRecordId: local.repositoryId, providerConnectionId: local.connectionId, changeRequestId: "pr-7" });
      expect(result.knownActors).toEqual(["alice", "idle"]);
      const otherRepository = await db.insertInto("repositories").values({ workspace_id: local.workspaceId, provider: "github", provider_connection_id: local.connectionId, external_repository_id: "102", owner: "acme", name: "other", default_branch: "main", config_state: "valid" }).returning("id").executeTakeFirstOrThrow();
      await decision(db, { ...local, repositoryId: otherRepository.id }, 95, since, "other-repo");
      const selected = await resolveAnalyticsScope(db, local.workspaceId, { githubOrganization: "acme", repositoryIds: [local.repositoryId] });
      expect((await readTrackedPullRequests(db, selected, { since, end })).pullRequests.map(pr => pr.changeRequestNumber)).toEqual([7]);
      const resolveForeignRepository = () => resolveAnalyticsScope(db, local.workspaceId, { githubOrganization: "acme", repositoryIds: [foreign.repositoryId] });
      await expect(resolveForeignRepository()).rejects.toThrow(AnalyticsScopeUnavailableError);
      await expect(resolveAnalyticsScope(db, local.workspaceId, { githubOrganization: "acme", repositoryIds: [removed.id] })).rejects.toThrow(AnalyticsScopeUnavailableError);
    });
  });

  it("rechecks live authority, tombstones, scope identity, and repository membership", async () => {
    await withPostgresTestDatabase(async db => {
      const local = await seed(db, "local");
      const resolve = () => resolveAnalyticsScope(db, local.workspaceId, { githubOrganization: "acme", repositoryIds: [] });
      const scope = await resolve();
      await expect(assertAnalyticsScopeActive(db, { ...scope })).rejects.toThrow(AnalyticsScopeUnavailableError);
      scope.repositories[0]!.repository.name = "tampered";
      await expect(assertAnalyticsScopeActive(db, scope)).rejects.toThrow(AnalyticsScopeUnavailableError);
      const valid = await resolve();
      await db.updateTable("provider_connections").set({ status: "suspended" }).where("id", "=", local.connectionId).execute();
      await expect(assertAnalyticsScopeActive(db, valid)).rejects.toThrow(ProviderConnectionUnavailableError);
      await expect(resolve()).rejects.toThrow(ProviderConnectionUnavailableError);
      await db.updateTable("provider_connections").set({ status: "active" }).where("id", "=", local.connectionId).execute();
      await db.insertInto("provider_connection_revocations").values({ workspace_id: local.workspaceId, provider: "github", external_connection_id: "local", physical_connection_id: local.connectionId, revoked_at: end }).execute();
      const readAfterRevocation = () => readTrackedPullRequests(db, valid, { since, end });
      await expect(readAfterRevocation()).rejects.toThrow();
      await expect(resolve()).rejects.toThrow(ProviderConnectionUnavailableError);
      await db.deleteFrom("provider_connection_revocations").execute();
      await db.deleteFrom("repositories").where("id", "=", local.repositoryId).execute();
      await expect(assertAnalyticsScopeActive(db, valid)).rejects.toThrow(AnalyticsScopeUnavailableError);
      const empty = await resolve();
      expect(await readTrackedPullRequests(db, empty, { since, end })).toEqual({ pullRequests: [], knownActors: [] });
    });
  });
  it("rejects missing and wrong-organization connections and rechecks organization metadata", async () => {
    await withPostgresTestDatabase(async db => {
      const workspaceId = await ensureLocalWorkspace(db);
      await expect(resolveAnalyticsScope(db, workspaceId, { githubOrganization: "acme", repositoryIds: [] })).rejects.toThrow(ProviderConnectionUnavailableError);
      const local = await seed(db, "local");
      const resolve = () => resolveAnalyticsScope(db, local.workspaceId, { githubOrganization: "acme", repositoryIds: [] });
      await expect(resolveAnalyticsScope(db, workspaceId, { githubOrganization: "other", repositoryIds: [] })).rejects.toThrow(ProviderConnectionUnavailableError);
      const scope = await resolve();
      await db.updateTable("provider_connections").set({ workspace_login: "other" }).where("id", "=", local.connectionId).execute();
      await expect(readTrackedPullRequests(db, scope, { since, end })).rejects.toThrow(ProviderConnectionUnavailableError);
      await db.updateTable("provider_connections").set({ workspace_login: "acme" }).where("id", "=", local.connectionId).execute();
      await db.updateTable("repositories").set({ owner: "other" }).where("id", "=", local.repositoryId).execute();
      await expect(assertAnalyticsScopeActive(db, scope)).rejects.toThrow(AnalyticsScopeUnavailableError);
      await expect(resolveAnalyticsScope(db, workspaceId, { githubOrganization: "acme", repositoryIds: [local.repositoryId] })).rejects.toThrow(AnalyticsScopeUnavailableError);
      await db.updateTable("provider_connections").set({ account_type: "User" }).where("id", "=", local.connectionId).execute();
      await expect(resolve()).rejects.toThrow(ProviderConnectionUnavailableError);
    });
  });

});
