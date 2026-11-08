import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRepositories, ensureLocalWorkspace } from "@triagepilot/db";
import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import { createPullRequestQueueRuntime } from "../src/pull-request-queue-runtime";
const github = { appId: "123", privateKey: "-----BEGIN PRIVATE KEY-----test", webhookSecret: "secret" };
const repo = { id: 101, name: "api", owner: { login: "acme" } };
const pull = { id: 7001, number: 7, state: "open", title: "Change", draft: false, user: { id: 1, login: "alice", type: "User" }, base: { sha: "base", repo }, head: { sha: "head" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", requested_reviewers: [], requested_teams: [] };
const provider = async (route: string) => ({ data: route === "GET /installation/repositories" ? { total_count: 1, repositories: [repo] } : route.endsWith("/pulls") ? [pull] : route.endsWith("/reviews") ? [] : pull });
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("pull request queue runtime", () => {
  async function fixture(db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0], factory?: () => Promise<unknown>) {
    const workspaceId = await ensureLocalWorkspace(db), repositories = createWorkspaceRepositories(db, workspaceId);
    await repositories.activateConfiguredProviderConnection({ provider: "github", externalConnectionId: "99", workspaceLogin: "acme", accountType: "Organization" });
    const request = vi.fn(provider), createRequester = vi.fn(factory ?? (async () => ({ request })));
    const runtime = createPullRequestQueueRuntime({ db, workspaceId, githubOrganization: "acme", github, now: () => new Date(), createRequester: createRequester as never });
    return { runtime, request, createRequester, repositories };
  }
  it("discovers unrecorded selected repositories without inserts and reuses cached PR/review reads", async () => withPostgresTestDatabase(async db => {
    const { runtime, request } = await fixture(db);
    try {
      const first = await runtime.readPullRequestQueue({ forceRefresh: false });
      expect(first).toMatchObject({ status: "complete", totalOpen: 1, coveredRepositoryIds: ["101"], repositories: [{ recordId: null }] });
      expect(first.items[0]!.links).toEqual({ provider: "https://github.com/acme/api/pull/7", decision: null });
      const contentCalls = () => request.mock.calls.filter(([route]) => route !== "GET /installation/repositories").length;
      const before = contentCalls(); expect(await runtime.readPullRequestQueue({ forceRefresh: false })).toEqual(first); expect(contentCalls()).toBe(before);
      expect(await db.selectFrom("repositories").selectAll().execute()).toEqual([]);
    } finally { runtime.disposePullRequestQueue(); }
  }));
  it.each([401, 403, 404])("rejects token authority %s", async status => withPostgresTestDatabase(async db => {
    const { runtime } = await fixture(db, async () => { throw { status, message: "secret token" }; });
    try { await expect(runtime.readPullRequestQueue({ forceRefresh: false })).rejects.toMatchObject({ reason: "authority" }); } finally { runtime.disposePullRequestQueue(); }
  }));
  it.each([401, 403, 404])("rejects provider authority %s", async status => withPostgresTestDatabase(async db => {
    const { runtime, request } = await fixture(db); request.mockImplementation(async () => { throw { status, message: "secret token" }; });
    try { await expect(runtime.readPullRequestQueue({ forceRefresh: false })).rejects.toMatchObject({ reason: "authority" }); } finally { runtime.disposePullRequestQueue(); }
  }));
  it("distinguishes rate limiting during token creation", async () => withPostgresTestDatabase(async db => {
    const { runtime } = await fixture(db, async () => { throw { status: 403, response: { headers: { "retry-after": "60" } } }; });
    try { await expect(runtime.readPullRequestQueue({ forceRefresh: false })).rejects.toMatchObject({ reason: "rate_limited" }); } finally { runtime.disposePullRequestQueue(); }
  }));
  it("rejects inactive scope before credentials and caller cancellation before I/O", async () => withPostgresTestDatabase(async db => {
    const { runtime, createRequester, repositories } = await fixture(db);
    try {
      const controller = new AbortController(); controller.abort(new Error("caller cancelled"));
      await expect(runtime.readPullRequestQueue({ forceRefresh: false, signal: controller.signal })).rejects.toThrow("caller cancelled");
      await repositories.suspendConfiguredProviderConnection({ provider: "github", externalConnectionId: "99", workspaceLogin: "acme", accountType: "Organization" });
      await expect(runtime.readPullRequestQueue({ forceRefresh: false })).rejects.toMatchObject({ reason: "authority" }); expect(createRequester).not.toHaveBeenCalled();
    } finally { runtime.disposePullRequestQueue(); }
  }));
  it("rechecks DB authority after token creation", async () => withPostgresTestDatabase(async db => {
    const request = vi.fn(provider);
    const { runtime } = await fixture(db, async () => { await db.updateTable("provider_connections").set({ status: "suspended" }).execute(); return { request }; });
    try { await expect(runtime.readPullRequestQueue({ forceRefresh: false })).rejects.toMatchObject({ reason: "authority" }); expect(request).not.toHaveBeenCalled(); } finally { runtime.disposePullRequestQueue(); }
  }));
  it("rejects changed connection identity after credentials without provider reads", async () => withPostgresTestDatabase(async db => {
    const request = vi.fn(provider);
    const { runtime } = await fixture(db, async () => { await db.updateTable("provider_connections").set({ external_connection_id: "100" }).execute(); return { request }; });
    try { await expect(runtime.readPullRequestQueue({ forceRefresh: false })).rejects.toMatchObject({ reason: "authority" }); expect(request).not.toHaveBeenCalled(); } finally { runtime.disposePullRequestQueue(); }
  }));
  it("cancels a waiting caller while allowing the shared acquisition to finish", async () => withPostgresTestDatabase(async db => {
    const { runtime, request } = await fixture(db);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    request.mockImplementation(async route => { if (route.endsWith("/pulls")) { entered(); await blocked; } return provider(route); });
    const controller = new AbortController();
    try {
      const first = runtime.readPullRequestQueue({ forceRefresh: false, signal: controller.signal });
      await started;
      const second = runtime.readPullRequestQueue({ forceRefresh: false });
      controller.abort(new Error("viewer departed"));
      await expect(first).rejects.toThrow("viewer departed");
      release();
      expect(await second).toMatchObject({ status: "complete", totalOpen: 1 });
      expect(request.mock.calls.filter(([route]) => route.endsWith("/pulls"))).toHaveLength(1);
    } finally { release(); runtime.disposePullRequestQueue(); }
  }));

});
