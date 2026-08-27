import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { ProviderKind, WorkspaceId } from "@triagepilot/contracts";

import { createJobClaimer, createWorkspaceRepositories, ensureLocalWorkspace } from "../src";
import { withPostgresTestDatabase } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("workspace persistence isolation", () => {
  it("allows provider-qualified identities to repeat only in their proper scope", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceA = await ensureLocalWorkspace(db);
      const workspaceB = await createWorkspace(db, "workspace-b");

      await seedConnectionAndRepository(db, workspaceA, "github", "99", "200", "api-a");
      await seedConnectionAndRepository(db, workspaceB, "github", "99", "200", "api-b");
      await seedConnectionAndRepository(db, workspaceA, "gitlab", "77", "200", "api-gitlab", "suspended");

      await expect(
        db.selectFrom("repositories")
          .select(["workspace_id", "provider", "external_repository_id"])
          .orderBy("workspace_id")
          .orderBy("provider")
          .execute(),
      ).resolves.toHaveLength(3);

      const connectionA = await connectionId(db, workspaceA, "github", "99");
      const connectionB = await connectionId(db, workspaceB, "github", "99");
      const repositoriesA = createWorkspaceRepositories(db, workspaceA);
      const repositoriesB = createWorkspaceRepositories(db, workspaceB);
      const now = new Date("2026-08-27T10:00:00.000Z");

      await expect(repositoriesA.jobs.enqueue(job("same-key", connectionA, now))).resolves.toMatchObject({ inserted: true });
      await expect(repositoriesB.jobs.enqueue(job("same-key", connectionB, now))).resolves.toMatchObject({ inserted: true });

      await db.insertInto("webhook_receipts").values([
        receipt(workspaceA, "same-delivery"),
        receipt(workspaceB, "same-delivery"),
      ]).execute();

      const repositoryA = await repositoryId(db, workspaceA, "github", "200");
      const repositoryB = await repositoryId(db, workspaceB, "github", "200");
      await repositoriesA.persistDecision(decision(repositoryA, "same-delivery", "same-routing-key"));
      await repositoriesB.persistDecision(decision(repositoryB, "same-delivery", "same-routing-key"));

      const claimer = createJobClaimer(db);
      const first = await claimer.claimNext("worker-a", now);
      expect(first?.workspaceId).toBe(workspaceA);
      await repositoriesA.jobs.markSucceeded(toLease(first), now);
      expect((await claimer.claimNext("worker-b", now))?.workspaceId).toBe(workspaceB);
    });
  });

  it("reads, updates, transitions, and deletes only the bound workspace", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceA = await ensureLocalWorkspace(db);
      const workspaceB = await createWorkspace(db, "workspace-b");
      const connectionA = await seedConnectionAndRepository(db, workspaceA, "github", "99", "200", "api");
      const connectionB = await seedConnectionAndRepository(db, workspaceB, "github", "99", "200", "api");
      const repositoryA = await repositoryId(db, workspaceA, "github", "200");
      const repositoryB = await repositoryId(db, workspaceB, "github", "200");
      const repositoriesA = createWorkspaceRepositories(db, workspaceA);
      const repositoriesB = createWorkspaceRepositories(db, workspaceB);
      const now = new Date("2026-08-27T10:00:00.000Z");

      const decisionA = await repositoriesA.persistDecision(decision(repositoryA, "delivery-a", "same-routing-key"));
      const decisionB = await repositoriesB.persistDecision(decision(repositoryB, "delivery-b", "same-routing-key"));
      await repositoriesA.markActionFailed(decisionA.decisionId, "workspace-a only", now);
      await repositoriesA.recordPolicyCheck({ decisionId: decisionB.decisionId, checkRunId: "42", state: "failure" });

      await expect(db.selectFrom("routing_decisions")
        .select(["id", "action_status", "policy_check_state"])
        .orderBy("id")
        .execute()).resolves.toEqual(expect.arrayContaining([
        { id: decisionA.decisionId, action_status: "failed", policy_check_state: "not_started" },
        { id: decisionB.decisionId, action_status: "pending", policy_check_state: "not_started" },
      ]));

      await repositoriesA.jobs.enqueue(job("same-key", connectionA, now));
      await repositoriesB.jobs.enqueue(job("same-key", connectionB, now));
      const claimedA = await createJobClaimer(db).claimNext("worker-a", now);
      expect(claimedA?.workspaceId).toBe(workspaceA);
      await expect(repositoriesB.jobs.markSucceeded(toLease(claimedA), now)).resolves.toEqual({
        updated: false,
        reason: "stale_lease",
      });

      const old = new Date("2026-04-01T00:00:00.000Z");
      await db.updateTable("routing_decisions").set({ created_at: old }).execute();
      await repositoriesA.applyFixedRetention(now);
      await expect(db.selectFrom("routing_decisions").select("workspace_id").execute()).resolves.toEqual([
        { workspace_id: workspaceB },
      ]);

      const overview = await repositoriesB.readOperations({
        githubOrganization: "acme",
        githubAppId: "123",
        now,
        heartbeatStaleAfterMs: 30_000,
      });
      expect(overview.repositories).toHaveLength(1);
      expect(overview.decisions).toHaveLength(1);
      expect(overview.decisions[0]?.id).toBe(decisionB.decisionId);
    });
  });
});

async function createWorkspace(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  externalKey: string,
): Promise<WorkspaceId> {
  const row = await db.insertInto("workspaces").values({ external_key: externalKey }).returning("id").executeTakeFirstOrThrow();
  return row.id;
}

async function seedConnectionAndRepository(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  workspaceId: WorkspaceId,
  provider: ProviderKind,
  externalConnectionId: string,
  externalRepositoryId: string,
  name: string,
  status = "active",
): Promise<string> {
  const connection = await db.insertInto("provider_connections").values({
    workspace_id: workspaceId,
    provider,
    external_connection_id: externalConnectionId,
    workspace_login: "acme",
    account_type: "Organization",
    status,
    permissions: {},
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("repositories").values({
    workspace_id: workspaceId,
    provider,
    provider_connection_id: connection.id,
    external_repository_id: externalRepositoryId,
    owner: "acme",
    name,
    default_branch: "main",
    config_state: "valid",
  }).execute();
  return connection.id;
}

async function connectionId(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  workspaceId: WorkspaceId,
  provider: ProviderKind,
  externalId: string,
): Promise<string> {
  return (await db.selectFrom("provider_connections").select("id")
    .where("workspace_id", "=", workspaceId).where("provider", "=", provider)
    .where("external_connection_id", "=", externalId).executeTakeFirstOrThrow()).id;
}

async function repositoryId(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  workspaceId: WorkspaceId,
  provider: ProviderKind,
  externalId: string,
): Promise<string> {
  return (await db.selectFrom("repositories").select("id")
    .where("workspace_id", "=", workspaceId).where("provider", "=", provider)
    .where("external_repository_id", "=", externalId).executeTakeFirstOrThrow()).id;
}

function job(idempotencyKey: string, providerConnectionId: string, runAt: Date) {
  return {
    kind: "process_pull_request" as const,
    provider: "github" as const,
    providerConnectionId,
    payload: { fixture: true },
    idempotencyKey,
    runAt,
  };
}

function receipt(workspaceId: WorkspaceId, deliveryId: string) {
  return {
    workspace_id: workspaceId,
    provider: "github" as const,
    delivery_id: deliveryId,
    event_name: "pull_request",
    external_connection_id: "99",
    payload_summary: {},
  };
}

function decision(repositoryId: string, deliveryId: string, routingKey: string) {
  return {
    repositoryId,
    deliveryId,
    routingKey,
    pullNumber: 7,
    headSha: "head-1",
    mode: "enforce" as const,
    action: "policy_approval",
    actionStatus: "pending" as const,
    riskScore: 5,
    details: { fixture: true },
  };
}

function toLease(job: Awaited<ReturnType<ReturnType<typeof createJobClaimer>["claimNext"]>>) {
  if (!job || job.lockedBy === null) throw new Error("expected a claimed job");
  return {
    jobId: job.id,
    workspaceId: job.workspaceId,
    provider: job.provider,
    providerConnectionId: job.providerConnectionId,
    lockedBy: job.lockedBy,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
  };
}
