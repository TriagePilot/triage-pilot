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

  it("scopes reviewer availability overlap, uniqueness, and references by workspace and provider connection", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceA = await ensureLocalWorkspace(db);
      const workspaceB = await createWorkspace(db, "workspace-b");
      const connectionA = await seedConnectionAndRepository(db, workspaceA, "github", "91", "201", "api-a");
      const connectionASecondary = await seedConnectionAndRepository(
        db,
        workspaceA,
        "github",
        "92",
        "202",
        "api-a-secondary",
        "suspended",
      );
      const connectionB = await seedConnectionAndRepository(db, workspaceB, "github", "91", "201", "api-b");
      const repositoryA = await repositoryId(db, workspaceA, "github", "201");
      const repositoryB = await repositoryId(db, workspaceB, "github", "201");
      const repositoriesA = createWorkspaceRepositories(db, workspaceA);
      const repositoriesB = createWorkspaceRepositories(db, workspaceB);
      const decisionA = await repositoriesA.persistDecision(decision(repositoryA, "availability-a", "availability-a"));
      const decisionB = await repositoriesB.persistDecision(decision(repositoryB, "availability-b", "availability-b"));
      const window = {
        start_at: new Date("2026-10-01T08:00:00.000Z"),
        end_at: new Date("2026-10-01T12:00:00.000Z"),
      };

      const absenceA = await db.insertInto("reviewer_absences").values({
        workspace_id: workspaceA,
        provider: "github",
        provider_connection_id: connectionA,
        external_actor_id: "@user-4e5c21",
        ...window,
      }).returning("id").executeTakeFirstOrThrow();

      await expect(db.insertInto("reviewer_absences").values({
        workspace_id: workspaceA,
        provider: "github",
        provider_connection_id: connectionA,
        external_actor_id: "@user-4e5c21",
        start_at: new Date("2026-10-01T10:00:00.000Z"),
        end_at: new Date("2026-10-01T14:00:00.000Z"),
      }).execute()).rejects.toMatchObject({ constraint: "reviewer_absences_no_overlap" });

      const absenceASecondary = await db.insertInto("reviewer_absences").values({
        workspace_id: workspaceA,
        provider: "github",
        provider_connection_id: connectionASecondary,
        external_actor_id: "@user-4e5c21",
        ...window,
      }).returning("id").executeTakeFirstOrThrow();
      const absenceB = await db.insertInto("reviewer_absences").values({
        workspace_id: workspaceB,
        provider: "github",
        provider_connection_id: connectionB,
        external_actor_id: "@user-4e5c21",
        ...window,
      }).returning("id").executeTakeFirstOrThrow();

      await expect(db.insertInto("reviewer_absences").values({
        workspace_id: workspaceB,
        provider: "github",
        provider_connection_id: connectionA,
        external_actor_id: "@user-a907d2",
        ...window,
      }).execute()).rejects.toMatchObject({
        constraint: "reviewer_absences_workspace_provider_connection_fkey",
      });

      const replacement = {
        workspace_id: workspaceA,
        provider: "github" as const,
        provider_connection_id: connectionA,
        absence_id: absenceA.id,
        absence_revision: 1,
        decision_id: decisionA.decisionId,
        unavailable_actor_id: "@user-4e5c21",
        replacement_actor_id: "@user-2f83b9",
        outcome: "replaced",
        reason: "scheduled absence",
        started_at: new Date("2026-10-01T08:00:00.000Z"),
        completed_at: new Date("2026-10-01T08:00:01.000Z"),
      };
      await db.insertInto("reviewer_replacements").values(replacement).execute();
      await expect(db.insertInto("reviewer_replacements").values(replacement).execute()).rejects.toMatchObject({
        constraint: "reviewer_replacements_scoped_source_key",
      });

      await expect(db.insertInto("reviewer_replacements").values({
        ...replacement,
        absence_id: absenceB.id,
      }).execute()).rejects.toMatchObject({
        constraint: "reviewer_replacements_scoped_absence_fkey",
      });
      await expect(db.insertInto("reviewer_replacements").values({
        ...replacement,
        absence_id: absenceASecondary.id,
      }).execute()).rejects.toMatchObject({
        constraint: "reviewer_replacements_scoped_absence_fkey",
      });
      await expect(db.insertInto("reviewer_replacements").values({
        ...replacement,
        decision_id: decisionB.decisionId,
      }).execute()).rejects.toMatchObject({
        constraint: "reviewer_replacements_workspace_decision_fkey",
      });
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
      await expect(
        repositoriesB.jobs.markFailed(toLease(claimedA), "wrong workspace", now, { retryable: false }),
      ).resolves.toEqual({ updated: false, reason: "stale_lease" });

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

  it("isolates decision reads and every decision state mutation", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceA = await ensureLocalWorkspace(db);
      const workspaceB = await createWorkspace(db, "workspace-b");
      await seedConnectionAndRepository(db, workspaceA, "github", "99", "200", "api-a");
      await seedConnectionAndRepository(db, workspaceB, "github", "99", "200", "api-b");
      const repositoryA = await repositoryId(db, workspaceA, "github", "200");
      const repositoryB = await repositoryId(db, workspaceB, "github", "200");
      const repositoriesA = createWorkspaceRepositories(db, workspaceA);
      const repositoriesB = createWorkspaceRepositories(db, workspaceB);
      const now = new Date("2026-08-27T10:00:00.000Z");
      const decisionA = await repositoriesA.persistDecision(decision(repositoryA, "delivery-a", "routing-a"));
      const decisionB = await repositoriesB.persistDecision(decision(repositoryB, "delivery-b", "routing-b"));

      await expect(repositoriesA.findLatestHumanReviewPolicyDecision({
        repositoryId: repositoryB,
        pullNumber: 7,
      })).resolves.toBeNull();
      await repositoriesA.recordPolicyCheck({ decisionId: decisionB.decisionId, checkRunId: "41", state: "in_progress" });
      await repositoriesA.updatePolicyCheckState({ decisionId: decisionB.decisionId, state: "success" });
      await repositoriesA.markActionSucceeded(decisionB.decisionId, now);

      await repositoriesA.recordPolicyCheck({ decisionId: decisionA.decisionId, checkRunId: "42", state: "in_progress" });
      await repositoriesA.updatePolicyCheckState({ decisionId: decisionA.decisionId, state: "success" });
      await repositoriesA.markActionSucceeded(decisionA.decisionId, now);

      await expect(repositoriesA.findLatestHumanReviewPolicyDecision({
        repositoryId: repositoryA,
        pullNumber: 7,
      })).resolves.toEqual(expect.objectContaining({
        decisionId: decisionA.decisionId,
        policyCheckRunId: "42",
        policyCheckState: "success",
      }));
      await expect(db.selectFrom("routing_decisions")
        .select(["workspace_id", "action_status", "policy_check_run_id", "policy_check_state"])
        .where("id", "=", decisionB.decisionId)
        .executeTakeFirstOrThrow()).resolves.toEqual({
        workspace_id: workspaceB,
        action_status: "pending",
        policy_check_run_id: null,
        policy_check_state: "not_started",
      });
    });
  });

  it("recovers stale jobs only in the bound workspace", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceA = await ensureLocalWorkspace(db);
      const workspaceB = await createWorkspace(db, "workspace-b");
      const connectionA = await seedConnectionAndRepository(db, workspaceA, "github", "99", "200", "api-a");
      const connectionB = await seedConnectionAndRepository(db, workspaceB, "github", "99", "200", "api-b");
      const repositoriesA = createWorkspaceRepositories(db, workspaceA);
      const repositoriesB = createWorkspaceRepositories(db, workspaceB);
      const claimedAt = new Date("2026-08-27T10:00:00.000Z");

      await repositoriesA.jobs.enqueue(job("stale-a", connectionA, claimedAt));
      await repositoriesB.jobs.enqueue(job("stale-b", connectionB, claimedAt));
      const claimer = createJobClaimer(db);
      expect((await claimer.claimNext("worker-a", claimedAt))?.workspaceId).toBe(workspaceA);
      expect((await claimer.claimNext("worker-b", claimedAt))?.workspaceId).toBe(workspaceB);

      await repositoriesA.recoverStaleJobs(new Date("2026-08-27T10:16:00.000Z"));

      await expect(db.selectFrom("jobs")
        .select(["workspace_id", "status", "locked_by"])
        .orderBy("idempotency_key")
        .execute()).resolves.toEqual([
        { workspace_id: workspaceA, status: "queued", locked_by: null },
        { workspace_id: workspaceB, status: "running", locked_by: "worker-b" },
      ]);
    });
  });

  it("binds both delivery acceptors to their requested workspace", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceA = await ensureLocalWorkspace(db);
      const workspaceB = await createWorkspace(db, "workspace-b");
      const repositoriesA = createWorkspaceRepositories(db, workspaceA);
      const repositoriesB = createWorkspaceRepositories(db, workspaceB);

      await expect(repositoriesA.acceptRoutingDelivery(routingDelivery("same-delivery", "same-routing")))
        .resolves.toMatchObject({ inserted: true });
      await expect(repositoriesB.acceptRoutingDelivery(routingDelivery("same-delivery", "same-routing")))
        .resolves.toMatchObject({ inserted: true });
      await expect(repositoriesA.acceptHumanReviewPolicyDelivery(reviewDelivery("same-review")))
        .resolves.toMatchObject({ inserted: true });
      await expect(repositoriesB.acceptHumanReviewPolicyDelivery(reviewDelivery("same-review")))
        .resolves.toMatchObject({ inserted: true });

      await expect(db.selectFrom("webhook_receipts")
        .select(["workspace_id", db.fn.count("id").as("count")])
        .groupBy("workspace_id")
        .orderBy("workspace_id")
        .execute()).resolves.toEqual(expect.arrayContaining([
        { workspace_id: workspaceA, count: "2" },
        { workspace_id: workspaceB, count: "2" },
      ]));
      await expect(db.selectFrom("jobs")
        .select(["workspace_id", db.fn.count("id").as("count")])
        .groupBy("workspace_id")
        .orderBy("workspace_id")
        .execute()).resolves.toEqual(expect.arrayContaining([
        { workspace_id: workspaceA, count: "2" },
        { workspace_id: workspaceB, count: "2" },
      ]));
    });
  });

  it("isolates every provider-connection projection mutation", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceA = await ensureLocalWorkspace(db);
      const workspaceB = await createWorkspace(db, "workspace-b");
      await seedConnectionAndRepository(db, workspaceA, "github", "99", "200", "api-a");
      await seedConnectionAndRepository(db, workspaceB, "github", "99", "200", "api-b");
      const repositoriesA = createWorkspaceRepositories(db, workspaceA);

      await expect(repositoriesA.replaceProviderConnectionRepositories({
        ...providerConnection("100", "a-mismatch"),
        repositories: [{ ...providerRepository("201", "mismatch"), provider: "gitlab" }],
      })).rejects.toThrow("provider must match");
      await expect(repositoryExternalIds(db, workspaceA)).resolves.toEqual(["200"]);
      await expect(repositoryExternalIds(db, workspaceB)).resolves.toEqual(["200"]);

      await repositoriesA.activateConfiguredProviderConnection(providerConnection("101", "a-activate"));
      await expect(providerConnectionState(db, workspaceA)).resolves.toEqual({
        external_connection_id: "101",
        workspace_login: "a-activate",
        status: "active",
      });
      await expect(providerConnectionState(db, workspaceB)).resolves.toEqual({
        external_connection_id: "99",
        workspace_login: "acme",
        status: "active",
      });

      await repositoriesA.upsertConfiguredProviderConnection({
        ...providerConnection("102", "a-upsert"),
        repositories: [providerRepository("202", "upserted")],
      });
      await expect(providerConnectionState(db, workspaceA)).resolves.toEqual({
        external_connection_id: "102",
        workspace_login: "a-upsert",
        status: "active",
      });
      await expect(repositoryExternalIds(db, workspaceA)).resolves.toEqual(["202"]);
      await repositoriesA.replaceProviderConnectionRepositories({
        ...providerConnection("103", "a-replace"),
        repositories: [providerRepository("203", "replace-one"), providerRepository("204", "replace-two")],
      });
      await expect(providerConnectionState(db, workspaceA)).resolves.toEqual({
        external_connection_id: "103",
        workspace_login: "a-replace",
        status: "active",
      });
      await expect(repositoryExternalIds(db, workspaceA)).resolves.toEqual(["203", "204"]);
      await repositoriesA.updateProviderConnectionRepositories({
        ...providerConnection("103", "a-update"),
        repositoriesAdded: [providerRepository("205", "added")],
        repositoryIdsRemoved: ["203"],
      });

      await expect(repositoryExternalIds(db, workspaceA)).resolves.toEqual(["204", "205"]);
      await expect(repositoryExternalIds(db, workspaceB)).resolves.toEqual(["200"]);
      await repositoriesA.suspendConfiguredProviderConnection(providerConnection("103", "a-suspend"));
      await expect(providerConnectionState(db, workspaceA)).resolves.toEqual({
        external_connection_id: "103",
        workspace_login: "a-suspend",
        status: "suspended",
      });
      await expect(providerConnectionState(db, workspaceB)).resolves.toEqual({
        external_connection_id: "99",
        workspace_login: "acme",
        status: "active",
      });
      await repositoriesA.deleteConfiguredProviderConnection({ provider: "github", externalConnectionId: "103" });
      await expect(providerConnectionState(db, workspaceA)).resolves.toBeUndefined();
      await expect(providerConnectionState(db, workspaceB)).resolves.toEqual({
        external_connection_id: "99",
        workspace_login: "acme",
        status: "active",
      });
      await expect(repositoryExternalIds(db, workspaceB)).resolves.toEqual(["200"]);
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

function providerConnection(externalConnectionId: string, workspaceLogin: string) {
  return {
    provider: "github" as const,
    externalConnectionId,
    workspaceLogin,
    accountType: "Organization",
  };
}

function providerRepository(externalRepositoryId: string, name: string) {
  return { provider: "github" as const, externalRepositoryId, owner: "acme", name };
}

function routingDelivery(deliveryId: string, routingKey: string) {
  return {
    deliveryId,
    eventName: "pull_request",
    eventAction: "opened",
    hookId: "hook-1",
    connection: providerConnection("99", "acme"),
    repository: providerRepository("200", "api"),
    payload: {
      kind: "process_change_request" as const,
      deliveryId,
      eventName: "change_request.opened",
      changeRequest: {
        repository: { provider: "github" as const, externalId: "200", owner: "acme", name: "api" },
        externalId: "7",
        number: 7,
        baseRevision: "base-1",
        headRevision: "head-1",
      },
      isDraft: false,
      routingKey,
    },
  };
}

function reviewDelivery(deliveryId: string) {
  return {
    deliveryId,
    eventName: "pull_request_review",
    connection: providerConnection("99", "acme"),
    repository: providerRepository("200", "api"),
    payload: {
      kind: "evaluate_human_review_policy" as const,
      deliveryId,
      changeRequest: {
        repository: { provider: "github" as const, externalId: "200", owner: "acme", name: "api" },
        externalId: "7",
        number: 7,
      },
    },
  };
}

async function providerConnectionState(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  workspaceId: WorkspaceId,
) {
  return await db.selectFrom("provider_connections")
    .select(["external_connection_id", "workspace_login", "status"])
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
}

async function repositoryExternalIds(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  workspaceId: WorkspaceId,
) {
  return (await db.selectFrom("repositories")
    .select("external_repository_id")
    .where("workspace_id", "=", workspaceId)
    .orderBy("external_repository_id")
    .execute()).map((repository) => repository.external_repository_id);
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
