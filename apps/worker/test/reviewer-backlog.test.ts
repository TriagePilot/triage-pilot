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
  it("rejects a different workspace without database access", async () => {
    const service = createWorkerReviewerBacklogService({ db: {} as never, workspaceId: "expected", githubOrganization: "acme", credentialProvider: { getCredential: vi.fn() }, createRequester: vi.fn(), clock: { now: () => new Date() } });
    await expect(service.readCurrent({ workspaceId: "other", providerConnectionId: "connection", repositoryIds: [] })).rejects.toThrow("workspace mismatch");
  });
});
