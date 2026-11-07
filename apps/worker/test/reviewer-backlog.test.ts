import { describe, expect, it, vi } from "vitest";
import { ensureLocalWorkspace, persistDecision } from "@triagepilot/db";
import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import { createWorkerReviewerBacklogService } from "../src/reviewer-backlog";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("worker backlog host", () => {
  it("composes issued scopes, tracked pending counts, same-PR exclusion, caching and live authority", async () => {
    await withPostgresTestDatabase(async db => {
      const workspaceId = await ensureLocalWorkspace(db);
      const connection = await db.insertInto("provider_connections").values({ workspace_id: workspaceId, provider: "github", external_connection_id: "99", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
      const row = await db.insertInto("repositories").values({ workspace_id: workspaceId, provider: "github", provider_connection_id: connection.id, external_repository_id: "101", owner: "acme", name: "api", default_branch: "main", config_state: "unknown" }).returning("id").executeTakeFirstOrThrow();
      for (const number of [7, 8]) await persistDecision(db, workspaceId, { repositoryId: row.id, deliveryId: `delivery-${number}`, changeRequestId: String(number), pullNumber: number, headSha: "head", mode: "shadow", action: "request_human_review", actionStatus: "not_applied", riskScore: 50, details: { ownership: { eligibleReviewers: ["@busy", "@idle"] } } });
      const repository = { provider: "github" as const, externalId: "101", owner: "acme", name: "api" };
      const request = vi.fn(async () => ({ data: [7, 8, 9].map(number => ({ id: number, number, state: "open", base: { repo: { id: 101, name: "api", owner: { login: "acme" } } }, requested_reviewers: [{ login: "busy", type: "User" }], requested_teams: [] })) }));
      const service = createWorkerReviewerBacklogService({ db, workspaceId, githubOrganization: "acme", credentialProvider: { getCredential: async () => ({ appId: "1", privateKey: "key" }) }, createRequester: async () => ({ request }), clock: { now: () => new Date(Date.now() + 1000) } });
      const input = { workspaceId, providerConnectionId: connection.id, actors: ["@busy", "@idle"], exclude: { repositoryRecordId: row.id, repository, providerConnectionId: connection.id, changeRequestId: "7", changeRequestNumber: 7 } };
      expect(await service.readLoad(input)).toMatchObject({ status: "complete", loads: { "@busy": 1, "@idle": 0 } });
      await service.readLoad(input);
      expect(request).toHaveBeenCalledTimes(1);
      service.invalidate({ workspaceId, providerConnectionId: connection.id });
      await service.readLoad(input);
      expect(request).toHaveBeenCalledTimes(2);
      await expect(service.readLoad({ ...input, providerConnectionId: "wrong-connection" })).rejects.toThrow("connection mismatch");
      await expect(service.readLoad({ ...input, exclude: { ...input.exclude, repositoryRecordId: "wrong-repository" } })).rejects.toThrow("exclusion mismatch");
      service.invalidate({ workspaceId, providerConnectionId: connection.id });
      request.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403 }));
      await expect(service.readLoad(input)).rejects.toThrow("forbidden");
      request.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }));
      expect(await service.readLoad(input)).toMatchObject({ status: "fallback", loads: {}, reason: "provider_unavailable" });
      const callsBeforeSuspension = request.mock.calls.length;
      await db.updateTable("provider_connections").set({ status: "suspended" }).where("id", "=", connection.id).execute();
      await expect(service.readLoad(input)).rejects.toThrow("unavailable");
      expect(request).toHaveBeenCalledTimes(callsBeforeSuspension);
    });
  });
  it("shares one requester across concurrent repository reads and refreshes it for a new acquisition", async () => {
    await withTokenFailureInput(async input => {
      await input.factory.db.insertInto("repositories").values({ workspace_id: input.factory.workspaceId, provider: "github", provider_connection_id: input.load.providerConnectionId, external_repository_id: "102", owner: "acme", name: "other", default_branch: "main", config_state: "unknown" }).execute();
      const request = vi.fn(async () => ({ data: [] }));
      const createRequester = vi.fn(async () => ({ request }));
      const service = createWorkerReviewerBacklogService({ ...input.factory, createRequester });
      expect((await service.readLoad(input.load)).status).toBe("complete");
      expect(createRequester).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      service.invalidate(input.load);
      expect((await service.readLoad(input.load)).status).toBe("complete");
      expect(createRequester).toHaveBeenCalledTimes(2);
    });
  });

  it.each([403, 404])("falls back for a repository HTTP %s denial only after fresh installation verification", async status => {
    await withTokenFailureInput(async input => {
      const request = vi.fn(async (route: string) => {
        if (route === "GET /installation/repositories") return { data: { total_count: 0, repositories: [] } };
        throw Object.assign(new Error("denied"), { status });
      });
      const service = createWorkerReviewerBacklogService({ ...input.factory, createRequester: async () => ({ request }) });
      expect(await service.readLoad(input.load)).toMatchObject({ status: "fallback", reason: "provider_unavailable" });
      expect(request).toHaveBeenCalledWith("GET /installation/repositories", expect.objectContaining({ per_page: 1 }));
    });
  });

  it("rejects malformed installation verification and does not probe a 401", async () => {
    await withTokenFailureInput(async input => {
      const malformed = vi.fn(async (route: string) => {
        if (route === "GET /installation/repositories") return { data: {} };
        throw Object.assign(new Error("denied"), { status: 404 });
      });
      const service = createWorkerReviewerBacklogService({ ...input.factory, createRequester: async () => ({ request: malformed }) });
      await expect(service.readLoad(input.load)).rejects.toThrow();
      const unauthorized = vi.fn(async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); });
      const revoked = createWorkerReviewerBacklogService({ ...input.factory, createRequester: async () => ({ request: unauthorized }) });
      await expect(revoked.readLoad(input.load)).rejects.toThrow();
      expect(unauthorized).toHaveBeenCalledTimes(1);
    });
  });

  it("rechecks local authority after installation verification", async () => {
    await withTokenFailureInput(async input => {
      const request = vi.fn(async (route: string) => {
        if (route === "GET /installation/repositories") {
          await input.factory.db.updateTable("provider_connections").set({ status: "suspended" }).where("id", "=", input.load.providerConnectionId).execute();
          return { data: { total_count: 0, repositories: [] } };
        }
        throw Object.assign(new Error("denied"), { status: 404 });
      });
      const service = createWorkerReviewerBacklogService({ ...input.factory, createRequester: async () => ({ request }) });
      await expect(service.readLoad(input.load)).rejects.toThrow("unavailable");
    });
  });

  it.each([401, 403, 404])("fails closed when installation verification fails with HTTP %s", async status => {
    await withTokenFailureInput(async input => {
      const request = vi.fn(async () => { throw Object.assign(new Error("denied"), { status }); });
      const service = createWorkerReviewerBacklogService({ ...input.factory, createRequester: async () => ({ request }) });
      await expect(service.readLoad(input.load)).rejects.toThrow();
    });
  });

  it.each([401, 403, 404])("preserves raw installation-token authority failures (HTTP %s)", async status => {
    await withTokenFailureInput(async input => {
      const error = Object.assign(new Error("token authorization failed"), { status });
      for (const stage of ["credential", "requester"] as const) {
        const createRequester = vi.fn(async () => { throw error; });
        const service = createWorkerReviewerBacklogService({ ...input.factory,
          credentialProvider: { getCredential: async () => { if (stage === "credential") throw error; return { appId: "1", privateKey: "key" }; } },
          createRequester,
        });
        await expect(service.readLoad(input.load)).rejects.toBe(error);
        expect(createRequester).toHaveBeenCalledTimes(stage === "credential" ? 0 : 1);
      }
    });
  });

  it.each([
    { message: "token request failed", response: { headers: { "Retry-After": "3" } } },
    { message: "token request failed", response: { headers: { "X-RateLimit-Remaining": "0" } } },
    { message: "secondary rate limit", response: { headers: {} } },
  ])("retains transient rate-limited token 403: $message $response", async detail => {
    await withTokenFailureInput(async input => {
      const error = Object.assign(new Error(detail.message), { status: 403, response: detail.response });
      const service = createWorkerReviewerBacklogService({ ...input.factory, createRequester: async () => { throw error; } });
      expect(await service.readLoad(input.load)).toMatchObject({ status: "fallback", loads: {}, reason: "rate_limited" });
    });
  });

  it("rejects a different workspace without database access", async () => {
    const service = createWorkerReviewerBacklogService({ db: {} as never, workspaceId: "expected", githubOrganization: "acme", credentialProvider: { getCredential: vi.fn() }, createRequester: vi.fn(), clock: { now: () => new Date() } });
    await expect(service.readCurrent({ workspaceId: "other", providerConnectionId: "connection", repositoryIds: [] })).rejects.toThrow("workspace mismatch");
  });
});

async function withTokenFailureInput(run: (input: {
  factory: Parameters<typeof createWorkerReviewerBacklogService>[0];
  load: Parameters<ReturnType<typeof createWorkerReviewerBacklogService>["readLoad"]>[0];
}) => Promise<void>) {
  await withPostgresTestDatabase(async db => {
    const workspaceId = await ensureLocalWorkspace(db);
    const connection = await db.insertInto("provider_connections").values({ workspace_id: workspaceId, provider: "github", external_connection_id: "99", workspace_login: "acme", account_type: "Organization", status: "active", permissions: {} }).returning("id").executeTakeFirstOrThrow();
    const repository = { provider: "github" as const, externalId: "101", owner: "acme", name: "api" };
    const row = await db.insertInto("repositories").values({ workspace_id: workspaceId, provider: "github", provider_connection_id: connection.id, external_repository_id: "101", owner: "acme", name: "api", default_branch: "main", config_state: "unknown" }).returning("id").executeTakeFirstOrThrow();
    await run({
      factory: { db, workspaceId, githubOrganization: "acme", credentialProvider: { getCredential: async () => ({ appId: "1", privateKey: "key" }) }, createRequester: vi.fn(), clock: { now: () => new Date() } },
      load: { workspaceId, providerConnectionId: connection.id, actors: ["@reviewer"], exclude: { repositoryRecordId: row.id, repository, providerConnectionId: connection.id, changeRequestId: "7", changeRequestNumber: 7 } },
    });
  });
}
