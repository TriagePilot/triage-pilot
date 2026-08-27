import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import { createWorkspaceRepositories, ensureLocalWorkspace } from "../src";
import { withPostgresTestDatabase } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("delivery ingestion", () => {
  it("creates one receipt and job for concurrent duplicate deliveries", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      const input = deliveryInput();

      const results = await Promise.all([
        repositories.acceptRoutingDelivery(input),
        repositories.acceptRoutingDelivery(input),
      ]);

      expect(results.map((result) => result.inserted).sort()).toEqual([false, true]);
      expect(results.filter((result) => result.jobId !== null)).toHaveLength(1);
      await expectCounts(db, {
        webhook_receipts: 1,
        jobs: 1,
        provider_connections: 1,
        repositories: 1,
      });
      await expect(
        db.selectFrom("webhook_receipts").select(["event_action", "hook_id"]).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ event_action: "opened", hook_id: "hook-1" });
    });
  });

  it("records distinct deliveries for one change-request state but queues only one routing job", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      const first = deliveryInput();
      const second = {
        ...deliveryInput(),
        deliveryId: "delivery-2",
        payload: { ...first.payload, deliveryId: "delivery-2" },
      };

      const results = await Promise.all([
        repositories.acceptRoutingDelivery(first),
        repositories.acceptRoutingDelivery(second),
      ]);
      expect(results.map((result) => result.inserted)).toEqual([true, true]);
      expect(results.filter((result) => result.jobId !== null)).toHaveLength(1);
      await expectCounts(db, { webhook_receipts: 2, jobs: 1, provider_connections: 1, repositories: 1 });
    });
  });

  it("rolls back the receipt and projection when job insertion fails", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await sql`alter table jobs add constraint reject_routing_job check (kind <> 'process_pull_request')`.execute(db);

      await expect(repositories.acceptRoutingDelivery(deliveryInput())).rejects.toThrow();

      await expectCounts(db, { webhook_receipts: 0, jobs: 0, provider_connections: 0, repositories: 0 });
    });
  });

  it("rejects a repository whose provider differs from its connection", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      const input = deliveryInput();

      await expect(repositories.acceptRoutingDelivery({
        ...input,
        repository: { ...input.repository, provider: "gitlab" },
      })).rejects.toThrow("provider must match");

      await expectCounts(db, {
        webhook_receipts: 0,
        jobs: 0,
        provider_connections: 0,
        repositories: 0,
      });
    });
  });

  it("creates one receipt and policy-evaluation job for concurrent duplicate review deliveries", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      const input = humanReviewPolicyDeliveryInput();

      const results = await Promise.all([
        repositories.acceptHumanReviewPolicyDelivery(input),
        repositories.acceptHumanReviewPolicyDelivery(input),
      ]);

      expect(results.map((result) => result.inserted).sort()).toEqual([false, true]);
      expect(results.filter((result) => result.jobId !== null)).toHaveLength(1);
      await expect(
        db.selectFrom("jobs").select(["kind", "idempotency_key"]).executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        kind: "evaluate_human_review_policy",
        idempotency_key: "review-policy:delivery-review-1",
      });
    });
  });

  it("replaces and incrementally updates the selected repository projection", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.upsertConfiguredProviderConnection({
        ...connection("99", "acme"),
        repositories: [repository("101", "api"), repository("102", "web")],
      });
      await repositories.replaceProviderConnectionRepositories({
        ...connection("99", "ACME"),
        repositories: [repository("102", "frontend")],
      });
      await repositories.updateProviderConnectionRepositories({
        ...connection("99", "acme"),
        repositoriesAdded: [repository("103", "docs")],
        repositoryIdsRemoved: ["102"],
      });

      await expect(db.selectFrom("provider_connections")
        .select(["external_connection_id", "workspace_login", "account_type", "status"])
        .execute()).resolves.toEqual([{
        external_connection_id: "99",
        workspace_login: "acme",
        account_type: "Organization",
        status: "active",
      }]);
      await expect(db.selectFrom("repositories")
        .select(["external_repository_id", "owner", "name"])
        .orderBy("external_repository_id")
        .execute()).resolves.toEqual([{ external_repository_id: "103", owner: "acme", name: "docs" }]);
    });
  });

  it("preserves repositories when a suspended provider connection is reactivated without a snapshot", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.upsertConfiguredProviderConnection({
        ...connection("99", "acme"),
        repositories: [repository("101", "api")],
      });
      await repositories.suspendConfiguredProviderConnection(connection("99", "acme"));
      await repositories.activateConfiguredProviderConnection(connection("99", "ACME"));

      await expect(db.selectFrom("provider_connections")
        .select(["external_connection_id", "workspace_login", "status"])
        .executeTakeFirstOrThrow()).resolves.toEqual({
        external_connection_id: "99",
        workspace_login: "ACME",
        status: "active",
      });
      await expect(db.selectFrom("repositories").select(["external_repository_id", "name"]).execute())
        .resolves.toEqual([{ external_repository_id: "101", name: "api" }]);
    });
  });

  it("ignores a delayed incremental event for a replaced external connection ID", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.upsertConfiguredProviderConnection({
        ...connection("99", "acme"),
        repositories: [repository("101", "old")],
      });
      await repositories.replaceProviderConnectionRepositories({
        ...connection("100", "acme"),
        repositories: [repository("200", "current")],
      });
      await repositories.updateProviderConnectionRepositories({
        ...connection("99", "acme"),
        repositoriesAdded: [repository("103", "stale-added")],
        repositoryIdsRemoved: ["200"],
      });

      await expect(db.selectFrom("provider_connections")
        .select(["external_connection_id", "workspace_login", "status"])
        .execute()).resolves.toEqual([{ external_connection_id: "100", workspace_login: "acme", status: "active" }]);
      await expect(db.selectFrom("repositories").select(["external_repository_id", "name"]).execute())
        .resolves.toEqual([{ external_repository_id: "200", name: "current" }]);
    });
  });

  it("suspends and deletes only the configured provider connection", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.upsertConfiguredProviderConnection({
        ...connection("99", "acme"),
        repositories: [repository("101", "api")],
      });

      await repositories.suspendConfiguredProviderConnection(connection("99", "acme"));
      await expect(db.selectFrom("provider_connections").select("status").executeTakeFirstOrThrow())
        .resolves.toEqual({ status: "suspended" });

      await repositories.deleteConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" });
      await expectCounts(db, { provider_connections: 0, repositories: 0 });
    });
  });
});

function deliveryInput() {
  return {
    deliveryId: "delivery-1",
    eventName: "pull_request",
    eventAction: "opened",
    hookId: "hook-1",
    connection: connection("99", "acme"),
    repository: repository("101", "api"),
    payload: {
      kind: "process_change_request" as const,
      deliveryId: "delivery-1",
      eventName: "change_request.opened",
      changeRequest: {
        repository: { provider: "github" as const, externalId: "101", owner: "acme", name: "api" },
        externalId: "7",
        number: 7,
        baseRevision: "base-123",
        headRevision: "abc123",
      },
      isDraft: false,
      routingKey: "routing:workspace:github:101:7:base-123:abc123",
    },
  };
}

function humanReviewPolicyDeliveryInput() {
  return {
    deliveryId: "delivery-review-1",
    eventName: "pull_request_review",
    connection: connection("99", "acme"),
    repository: repository("101", "api"),
    payload: {
      kind: "evaluate_human_review_policy" as const,
      deliveryId: "delivery-review-1",
      changeRequest: {
        repository: { provider: "github" as const, externalId: "101", owner: "acme", name: "api" },
        externalId: "7",
        number: 7,
      },
    },
  };
}

function connection(externalConnectionId: string, workspaceLogin: string) {
  return { provider: "github" as const, externalConnectionId, workspaceLogin, accountType: "Organization" };
}

function repository(externalRepositoryId: string, name: string) {
  return { provider: "github" as const, externalRepositoryId, owner: "acme", name };
}

async function expectCounts(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  expected: Partial<Record<"webhook_receipts" | "jobs" | "provider_connections" | "repositories", number>>,
) {
  for (const [table, count] of Object.entries(expected)) {
    const result = await sql<{ count: string }>`select count(*)::text as count from ${sql.table(table)}`.execute(db);
    expect(Number(result.rows[0]?.count)).toBe(count);
  }
}
