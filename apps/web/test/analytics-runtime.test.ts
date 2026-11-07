import { describe, expect, it, vi } from "vitest";
import { ensureLocalWorkspace, createWorkspaceRepositories, AnalyticsScopeUnavailableError, ProviderConnectionUnavailableError } from "@triagepilot/db";
import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import { createAnalyticsRuntime } from "../src/analytics-runtime";

const end = new Date("2026-11-05T12:00:00.000Z");
const query = { periodDays: 30 as const, mode: "auto" as const, repositoryIds: [], averageReviewMinutes: 30 };
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("analytics runtime", () => {
  async function fixture(db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0], request = vi.fn(async (..._args: unknown[]) => ({ data: [] as unknown })), now = () => end) {
    const workspaceId = await ensureLocalWorkspace(db);
    const repositories = createWorkspaceRepositories(db, workspaceId);
    await repositories.replaceProviderConnectionRepositories({ provider: "github", externalConnectionId: "99", workspaceLogin: "acme", accountType: "Organization", repositories: [{ provider: "github", externalRepositoryId: "101", owner: "acme", name: "api" }, { provider: "github", externalRepositoryId: "102", owner: "acme", name: "other" }] });
    const rows = await db.selectFrom("repositories").select(["id", "name", "provider_connection_id"]).orderBy("name").execute();
    const api = rows[0]!, other = rows[1]!;
    await db.insertInto("routing_decisions").values({ workspace_id: workspaceId, repository_id: api.id, delivery_id: "d1", routing_key: "r1", action: "policy_approval", risk_score: 10, selected_reviewer: null, selected_reviewers: "[]", no_human_reason: "low_risk", pull_number: 7, change_request_id: "7", head_sha: "sha", mode: "shadow", details: { risk: { tier: "low" }, ownership: { eligibleReviewers: ["@idle"] }, routing: { requestedReviewerCount: 0, selectedReviewers: [] } }, effective_config_hash: "x", inheritance_mode: "legacy", created_at: new Date(end.getTime() - 86400000) }).execute();
    const createRequester = vi.fn(async () => ({ request }));
    const services = createAnalyticsRuntime({ db, workspaceId, githubOrganization: "acme", github: { appId: "123", privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----", webhookSecret: "test" }, createRequester: createRequester as never, now });
    return { services, request, createRequester, api, other, repositories };
  }
  const pull = { id: 7001, number: 7, state: "open", base: { repo: { id: 101, name: "api", owner: { login: "acme" } } }, requested_reviewers: [{ login: "manual", type: "User" }], requested_teams: [] };
  it("captures one fixed end instant and never reads GitHub for history", async () => {
    await withPostgresTestDatabase(async db => {
      const now = vi.fn(() => new Date(end.getTime() + now.mock.calls.length * 1000));
      const { services, request } = await fixture(db, undefined, now);
      const report = await services.readAnalytics(query);
      expect(now).toHaveBeenCalledTimes(1);
      expect(Date.parse(report.end) - Date.parse(report.start)).toBe(30 * 86400000);
      expect(report.counts.assessed).toBe(1);
      expect(request).not.toHaveBeenCalled();
      const doubled = await services.readAnalytics({ ...query, averageReviewMinutes: 60 });
      expect(doubled.savings.estimatedHoursSaved).toBe(report.savings.estimatedHoursSaved * 2);
      expect(doubled.counts).toEqual(report.counts);
      await expect(services.readAnalytics({ ...query, repositoryIds: ["foreign"] })).rejects.toBeInstanceOf(AnalyticsScopeUnavailableError);
    });
  });
  it("uses the full tracked population and scales minutes without changing counts, caches with live authorization", async () => {
    await withPostgresTestDatabase(async db => {
      const request = vi.fn(async (_route: unknown, params: unknown) => ({ data: (params as { repo: string }).repo === "api" ? [pull] : [] }));
      const { services, api, repositories, createRequester } = await fixture(db, request);
      const first = await services.readCurrentWorkload({ repositoryIds: [], averageReviewMinutes: 30, forceRefresh: false });
      expect(first).toMatchObject({ status: "complete", totalPending: 1, totalEstimatedHours: .5, rows: [{ actor: "@idle", pendingCount: 0 }, { actor: "@manual", pendingCount: 1 }] });
      const second = await services.readCurrentWorkload({ repositoryIds: [], averageReviewMinutes: 60, forceRefresh: false });
      expect(second.totalPending).toBe(1); expect(second.totalEstimatedHours).toBe(1); expect(request).toHaveBeenCalledTimes(2);
      expect(createRequester).toHaveBeenCalledWith({ appId: "123", privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----", installationId: 99 });
      await services.readCurrentWorkload({ repositoryIds: [], averageReviewMinutes: 60, forceRefresh: true });
      expect(request).toHaveBeenCalledTimes(4);
      await repositories.updateProviderConnectionRepositories({ provider: "github", externalConnectionId: "99", workspaceLogin: "acme", accountType: "Organization", repositoriesAdded: [], repositoryIdsRemoved: ["101"] });
      await expect(services.readCurrentWorkload({ repositoryIds: [api.id], averageReviewMinutes: 30, forceRefresh: false })).rejects.toBeInstanceOf(AnalyticsScopeUnavailableError);
      expect(request).toHaveBeenCalledTimes(4);
      await repositories.suspendConfiguredProviderConnection({ provider: "github", externalConnectionId: "99", workspaceLogin: "acme", accountType: "Organization" });
      await expect(services.readCurrentWorkload({ repositoryIds: [], averageReviewMinutes: 30, forceRefresh: false })).rejects.toBeInstanceOf(ProviderConnectionUnavailableError);
    });
  });
  it("keeps complete-empty zero distinct from partial and unavailable nulls", async () => {
    await withPostgresTestDatabase(async db => {
      let failed = false;
      const request = vi.fn(async (_route: unknown, params: unknown) => {
        if (failed && (params as { repo: string }).repo === "other") throw new Error("private provider body");
        return { data: [] };
      });
      const { services, other } = await fixture(db, request);
      expect(await services.readCurrentWorkload({ repositoryIds: [other.id], averageReviewMinutes: 30, forceRefresh: true })).toMatchObject({ status: "complete", totalPending: 0, totalEstimatedHours: 0, rows: [] });
      failed = true;
      const partial = await services.readCurrentWorkload({ repositoryIds: [], averageReviewMinutes: 30, forceRefresh: true });
      expect(partial).toMatchObject({ status: "partial", totalPending: null, totalEstimatedHours: null, unavailableRepositoryIds: [other.id] });
      expect(partial.rows.length).toBeGreaterThan(0);
      expect(partial.rows.every(row => row.pendingCount === null && row.estimatedHours === null)).toBe(true);
      expect(await services.readCurrentWorkload({ repositoryIds: [other.id], averageReviewMinutes: 30, forceRefresh: true })).toMatchObject({ status: "unavailable", totalPending: null });
    });
  });
  it("merges mixed-case stored candidates with normalized pending reviewers", async () => {
    await withPostgresTestDatabase(async db => {
      const request = vi.fn(async (_route: unknown, params: unknown) => ({ data: (params as { repo: string }).repo === "api" ? [pull] : [] }));
      const { services, api } = await fixture(db, request);
      await db.updateTable("routing_decisions").set({
        details: { ownership: { eligibleReviewers: ["@Manual", "@manual", "@Idle", "@idle"] } },
      }).where("repository_id", "=", api.id).execute();
      const report = await services.readCurrentWorkload({ repositoryIds: [], averageReviewMinutes: 30, forceRefresh: false });
      expect(report).toMatchObject({ status: "complete", totalPending: 1, totalEstimatedHours: .5 });
      expect(report.rows).toEqual([
        { actor: "@idle", pendingCount: 0, estimatedHours: 0 },
        { actor: "@manual", pendingCount: 1, estimatedHours: .5 },
      ]);
    });
  });
  it.each([[401, "unauthorized"], [403, "forbidden"], [404, "not_found"]] as const)("propagates provider authority %s instead of partial data", async (status, reason) => {
    await withPostgresTestDatabase(async db => {
      const { services } = await fixture(db, vi.fn(async () => { throw { status, message: "private" }; }));
      await expect(services.readCurrentWorkload({ repositoryIds: [], averageReviewMinutes: 30, forceRefresh: true })).rejects.toMatchObject({ reason });
    });
  });
  it("reports a denied repository as unavailable after verifying the installation", async () => {
    await withPostgresTestDatabase(async db => {
      const request = vi.fn(async (route: unknown, params: unknown) => {
        if (route === "GET /installation/repositories") return { data: { total_count: 1, repositories: [] } };
        if ((params as { repo: string }).repo === "other") throw { status: 404 };
        return { data: [pull] };
      });
      const { services, other } = await fixture(db, request);
      expect(await services.readCurrentWorkload({ repositoryIds: [], averageReviewMinutes: 30, forceRefresh: true })).toMatchObject({ status: "partial", unavailableRepositoryIds: [other.id], totalPending: null });
    });
  });
  it("treats installation-token authorization failures as authority failures", async () => {
    await withPostgresTestDatabase(async db => {
      const { api } = await fixture(db);
      const services = createAnalyticsRuntime({ db, workspaceId: (await db.selectFrom("repositories").select("workspace_id").where("id", "=", api.id).executeTakeFirstOrThrow()).workspace_id,
        githubOrganization: "acme", github: { appId: "123", privateKey: "-----BEGIN PRIVATE KEY-----test", webhookSecret: "test" }, now: () => end,
        createRequester: (async () => { throw { status: 401, message: "private token failure" }; }) as never });
      await expect(services.readCurrentWorkload({ repositoryIds: [], averageReviewMinutes: 30, forceRefresh: true })).rejects.toMatchObject({ reason: "forbidden" });
    });
  });
  it("history succeeds independently while workload times out", async () => {
    await withPostgresTestDatabase(async db => {
      const { services, request } = await fixture(db, vi.fn(async () => new Promise<never>(() => {})));
      const workload = services.readCurrentWorkload({ repositoryIds: [], averageReviewMinutes: 30, forceRefresh: true });
      const history = await services.readAnalytics(query);
      expect(history.counts.assessed).toBe(1);
      expect(await workload).toMatchObject({ status: "unavailable", totalPending: null });
      expect(request).toHaveBeenCalled();
      const calls = request.mock.calls.length;
      expect((await services.readAnalytics(query)).counts.assessed).toBe(1);
      expect(request).toHaveBeenCalledTimes(calls);
    });
  }, 20000);
});
