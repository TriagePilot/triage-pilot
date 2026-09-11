import { describe, expect, it } from "vitest";
import type { ProviderKind, RoutingJobPayload, WorkspaceId } from "@triagepilot/contracts";

import { createWorkspaceRoutingRecoveryRepository, ensureLocalWorkspace } from "../src";
import { withPostgresTestDatabase } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("workspace routing recovery repository", () => {
  it("resolves active provider-qualified targets by decision and change-request reference", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const seeded = await seedTarget(db, workspaceId, "github", "connection-71c9ab", "repository-a91f5c");
      const recovery = createWorkspaceRoutingRecoveryRepository(db, workspaceId);
      const expected = {
        providerConnectionId: seeded.providerConnectionId,
        repository: {
          provider: "github",
          externalId: "repository-a91f5c",
          owner: "AcMe",
          name: "api",
        },
        changeRequestId: "change-d82a5f",
        changeRequestNumber: 17,
      };

      await expect(recovery.findTarget({ decisionId: seeded.decisionId })).resolves.toEqual(expected);
      await expect(recovery.findTarget({
        changeRequest: {
          repository: expected.repository,
          externalId: "change-d82a5f",
          number: 17,
        },
      })).resolves.toEqual(expected);
      await expect(recovery.findActiveRepository({ provider: "github", owner: "acme", name: "API" }))
        .resolves.toEqual(expected.repository);
    });
  });

  it("does not disclose decisions or repositories from another workspace", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceA = await ensureLocalWorkspace(db);
      const workspaceB = await db.insertInto("workspaces").values({ external_key: "workspace-b" })
        .returning("id").executeTakeFirstOrThrow();
      const targetB = await seedTarget(db, workspaceB.id, "github", "connection-b4e82d", "repository-c91e46");
      const recoveryA = createWorkspaceRoutingRecoveryRepository(db, workspaceA);

      await expect(recoveryA.findTarget({ decisionId: targetB.decisionId })).resolves.toBeNull();
      await expect(recoveryA.findTarget({
        changeRequest: {
          repository: { provider: "github", externalId: "repository-c91e46", owner: "AcMe", name: "api" },
          externalId: "change-d82a5f",
          number: 17,
        },
      })).resolves.toBeNull();
      await expect(recoveryA.findActiveRepository({ provider: "github", owner: "AcMe", name: "api" }))
        .resolves.toBeNull();
    });
  });

  it("requires the repository provider to match its active connection", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      await seedTarget(db, workspaceId, "github", "connection-4e5c21", "repository-2f83b9");
      const recovery = createWorkspaceRoutingRecoveryRepository(db, workspaceId);

      await expect(recovery.findTarget({
        changeRequest: {
          repository: { provider: "gitlab", externalId: "repository-2f83b9", owner: "AcMe", name: "api" },
          externalId: "change-d82a5f",
          number: 17,
        },
      })).resolves.toBeNull();
      await expect(recovery.findActiveRepository({ provider: "gitlab", owner: "AcMe", name: "api" }))
        .resolves.toBeNull();
    });
  });

  it.each(["suspended", "revoked"] as const)("rejects a %s provider connection at lookup and enqueue", async (status) => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const seeded = await seedTarget(db, workspaceId, "github", `connection-${status}`, `repository-${status}`);
      const recovery = createWorkspaceRoutingRecoveryRepository(db, workspaceId);
      const request = {
        changeRequest: {
          repository: { provider: "github" as const, externalId: `repository-${status}`, owner: "AcMe", name: "api" },
          externalId: "change-d82a5f",
          number: 17,
        },
      };

      await db.updateTable("provider_connections").set({ status }).where("id", "=", seeded.providerConnectionId).execute();

      await expect(recovery.findTarget(request)).resolves.toBeNull();
      await expect(recovery.enqueue({
        provider: "github",
        providerConnectionId: seeded.providerConnectionId,
        idempotencyKey: routingPayload(workspaceId, seeded.providerConnectionId, request.changeRequest.repository).routingKey,
        payload: routingPayload(workspaceId, seeded.providerConnectionId, request.changeRequest.repository),
      })).resolves.toBeNull();
      await expect(db.selectFrom("jobs").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("enqueues directly without a webhook receipt and deduplicates the same operator run", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const seeded = await seedTarget(db, workspaceId, "github", "connection-a907d2", "repository-d71c42");
      const recovery = createWorkspaceRoutingRecoveryRepository(db, workspaceId);
      const repository = { provider: "github" as const, externalId: "repository-d71c42", owner: "AcMe", name: "api" };
      const payload = routingPayload(workspaceId, seeded.providerConnectionId, repository);
      const input = {
        provider: "github" as const,
        providerConnectionId: seeded.providerConnectionId,
        idempotencyKey: payload.routingKey,
        payload,
      };

      const first = await recovery.enqueue(input);
      const second = await recovery.enqueue(input);

      expect(first).toMatchObject({ inserted: true });
      expect(second).toEqual({ inserted: false, jobId: first?.jobId });
      await expect(db.selectFrom("webhook_receipts").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("jobs").select(["kind", "payload", "idempotency_key"]).execute())
        .resolves.toEqual([{
          kind: "process_pull_request",
          payload,
          idempotency_key: payload.routingKey,
        }]);
    });
  });
});

async function seedTarget(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  workspaceId: WorkspaceId,
  provider: ProviderKind,
  externalConnectionId: string,
  externalRepositoryId: string,
) {
  const connection = await db.insertInto("provider_connections").values({
    workspace_id: workspaceId,
    provider,
    external_connection_id: externalConnectionId,
    workspace_login: "AcMe",
    account_type: "Organization",
    status: "active",
    permissions: {},
  }).returning("id").executeTakeFirstOrThrow();
  const repository = await db.insertInto("repositories").values({
    workspace_id: workspaceId,
    provider,
    provider_connection_id: connection.id,
    external_repository_id: externalRepositoryId,
    owner: "AcMe",
    name: "api",
    default_branch: "main",
    config_state: "valid",
  }).returning("id").executeTakeFirstOrThrow();
  const decision = await db.insertInto("routing_decisions").values({
    workspace_id: workspaceId,
    repository_id: repository.id,
    delivery_id: `delivery-${externalRepositoryId}`,
    routing_key: `routing-${externalRepositoryId}`,
    action: "request_human_review",
    risk_score: 40,
    pull_number: 17,
    change_request_id: "change-d82a5f",
    head_sha: "head-previous",
    details: {},
    effective_config_hash: "hash-1",
    inheritance_mode: "defaults",
  }).returning("id").executeTakeFirstOrThrow();
  return { providerConnectionId: connection.id, decisionId: decision.id };
}

function routingPayload(
  workspaceId: WorkspaceId,
  providerConnectionId: string,
  repository: RoutingJobPayload["changeRequest"]["repository"],
): RoutingJobPayload {
  const routingKey = `routing:${workspaceId}:${repository.provider}:${repository.externalId}:change-d82a5f:base-current:head-current:ready:operator:run-71c9ab`;
  return {
    kind: "process_change_request",
    deliveryId: "operator:run-71c9ab",
    eventName: "operator.routing_recovery",
    workspaceId,
    providerConnectionId,
    changeRequest: {
      repository,
      externalId: "change-d82a5f",
      number: 17,
      baseRevision: "base-current",
      headRevision: "head-current",
    },
    isDraft: false,
    routingKey,
  };
}
