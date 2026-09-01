import type {
  DecisionEventV1,
  PlatformEventSink,
  ReviewerReplacementEventV1,
  WorkspaceId,
} from "@triagepilot/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  claimPlatformEvents,
  createPlatformOutboxRepository,
  ensureLocalWorkspace,
  persistDecisionWithEvent,
  publishPlatformOutbox,
  stagePlatformEvent,
} from "../src";
import { withPostgresTestDatabase } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("platform outbox", () => {
  it("persists the decision and versioned event in one transaction", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");

      const persisted = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101" }),
      });

      await expect(
        db.selectFrom("decision_outbox").select(["workspace_id", "decision_id", "schema_version", "payload"]).execute(),
      ).resolves.toEqual([
        expect.objectContaining({
          workspace_id: workspaceId,
          decision_id: persisted.decisionId,
          schema_version: 1,
          payload: expect.objectContaining({
            eventType: "routing_decision",
            decisionId: persisted.decisionId,
            workspaceId,
            repositoryId: "101",
          }),
        }),
      ]);
    });
  });

  it("does not stage reviewer replacement events before replacement persistence is available", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const persisted = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101" }),
      });

      await expect(stagePlatformEvent(
        db,
        workspaceId,
        persisted.decisionId,
        replacementEvent({ workspaceId, decisionId: persisted.decisionId }),
      )).rejects.toThrow("only routing decision events can be staged by the current outbox schema");
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toHaveLength(1);
    });
  });

  it("rolls back the decision when event staging fails", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const otherWorkspaceId = await seedWorkspace(db, "workspace-b");
      const repositoryId = await seedRepository(db, workspaceId, "101");

      await expect(
        persistDecisionWithEvent(db, workspaceId, {
          decision: decisionInput(repositoryId, "delivery-1"),
          event: ({ decisionId }) => decisionEvent({ workspaceId: otherWorkspaceId, decisionId, repositoryId: "101" }),
        }),
      ).rejects.toThrow("platform event workspace does not match persistence scope");
      await expect(db.selectFrom("routing_decisions").select("id").execute()).resolves.toHaveLength(0);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toHaveLength(0);
    });
  });

  it("does not create a second event for duplicate decision persistence", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");

      const first = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101" }),
      });
      const retried = await persistDecisionWithEvent(db, workspaceId, {
        decision: { ...decisionInput(repositoryId, "delivery-1"), riskScore: 35 },
        event: ({ decisionId }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", riskScore: 35 }),
      });

      expect(retried.decisionId).toBe(first.decisionId);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toHaveLength(1);
    });
  });

  it("claims only unpublished events for the requested workspace", async () => {
    await withPostgresTestDatabase(async (db) => {
      const firstWorkspaceId = await ensureLocalWorkspace(db);
      const secondWorkspaceId = await seedWorkspace(db, "workspace-b");
      const firstRepositoryId = await seedRepository(db, firstWorkspaceId, "101");
      const secondRepositoryId = await seedRepository(db, secondWorkspaceId, "202");

      const first = await persistDecisionWithEvent(db, firstWorkspaceId, {
        decision: decisionInput(firstRepositoryId, "delivery-1"),
        event: ({ decisionId }) => decisionEvent({ workspaceId: firstWorkspaceId, decisionId, repositoryId: "101" }),
      });
      await persistDecisionWithEvent(db, secondWorkspaceId, {
        decision: decisionInput(secondRepositoryId, "delivery-2"),
        event: ({ decisionId }) => decisionEvent({ workspaceId: secondWorkspaceId, decisionId, repositoryId: "202" }),
      });

      await expect(
        claimPlatformEvents({ db, workspaceId: firstWorkspaceId, limit: 10, now: new Date("2026-08-26T10:00:00.000Z") }),
      ).resolves.toEqual([
        expect.objectContaining({
          workspaceId: firstWorkspaceId,
          decisionId: first.decisionId,
          payload: expect.objectContaining({ workspaceId: firstWorkspaceId, repositoryId: "101" }),
        }),
      ]);
    });
  });

  it("leaves failed sink events retryable and publishes them on a later attempt", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const persisted = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101" }),
      });
      const repository = createPlatformOutboxRepository(db, workspaceId);
      const failingSink: PlatformEventSink = {
        emit: vi.fn(async () => {
          throw new Error("sink unavailable");
        }),
      };

      await expect(
        publishPlatformOutbox({
          repository,
          sink: failingSink,
          limit: 10,
          now: new Date("2026-08-26T10:00:00.000Z"),
        }),
      ).rejects.toThrow("sink unavailable");
      await expect(repository.listUnpublished()).resolves.toEqual([
        expect.objectContaining({
          decisionId: persisted.decisionId,
          attemptCount: 1,
          lastError: "sink unavailable",
          publishedAt: null,
        }),
      ]);

      const healthySink: PlatformEventSink = { emit: vi.fn(async () => {}) };
      await publishPlatformOutbox({
        repository,
        sink: healthySink,
        limit: 10,
        now: new Date("2026-08-26T10:00:05.000Z"),
      });

      expect(healthySink.emit).toHaveBeenCalledWith(expect.objectContaining({
        decisionId: persisted.decisionId,
        schemaVersion: 1,
      }));
      await expect(repository.listUnpublished()).resolves.toHaveLength(0);
    });
  });

  it("does not emit concurrently while a claim is leased and ignores stale completions", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101" }),
      });
      const repository = createPlatformOutboxRepository(db, workspaceId);
      let releaseFirstSink: (() => void) | undefined;
      const firstSink: PlatformEventSink = {
        emit: vi.fn(() => new Promise<void>((resolve) => {
          releaseFirstSink = resolve;
        })),
      };
      const secondSink: PlatformEventSink = { emit: vi.fn(async () => {}) };
      const firstPublish = publishPlatformOutbox({
        repository,
        sink: firstSink,
        limit: 10,
        now: new Date("2026-08-26T10:00:00.000Z"),
      });

      await vi.waitFor(() => expect(firstSink.emit).toHaveBeenCalledOnce());
      await expect(publishPlatformOutbox({
        repository,
        sink: secondSink,
        limit: 10,
        now: new Date("2026-08-26T10:00:06.000Z"),
      })).resolves.toEqual({ published: 0 });
      expect(secondSink.emit).not.toHaveBeenCalled();

      const leased = (await repository.listUnpublished())[0];
      expect(leased).toEqual(expect.objectContaining({ attemptCount: 1, publishedAt: null }));
      const secondClaim = (await repository.claim({
        limit: 10,
        now: new Date("2026-08-26T10:15:01.000Z"),
      }))[0];
      expect(secondClaim).toBeDefined();
      if (secondClaim === undefined) throw new Error("expected expired lease to be claimable");
      expect(secondClaim).toEqual(expect.objectContaining({ attemptCount: 2 }));

      await repository.markFailed({
        id: secondClaim.id,
        attemptCount: 1,
        error: new Error("stale failure"),
        now: new Date("2026-08-26T10:15:02.000Z"),
      });
      await repository.markPublished({
        id: secondClaim.id,
        attemptCount: 1,
        now: new Date("2026-08-26T10:15:03.000Z"),
      });
      await expect(repository.listUnpublished()).resolves.toEqual([
        expect.objectContaining({
          attemptCount: 2,
          lastError: null,
          publishedAt: null,
        }),
      ]);

      releaseFirstSink?.();
      await expect(firstPublish).resolves.toEqual({ published: 0 });
      await expect(repository.listUnpublished()).resolves.toEqual([
        expect.objectContaining({
          attemptCount: 2,
          lastError: null,
          publishedAt: null,
        }),
      ]);

      await repository.markFailed({
        id: secondClaim.id,
        attemptCount: 2,
        error: new Error("current failure"),
        now: new Date("2026-08-26T10:15:04.000Z"),
      });
      await expect(repository.listUnpublished()).resolves.toEqual([
        expect.objectContaining({
          attemptCount: 2,
          lastError: "current failure",
        }),
      ]);
    });
  });
});

function decisionInput(repositoryId: string, deliveryId: string) {
  return {
    repositoryId,
    deliveryId,
    routingKey: `routing:${deliveryId}`,
    pullNumber: 7,
    headSha: "head-1",
    mode: "shadow" as const,
    action: "policy_approval",
    actionStatus: "not_applied" as const,
    riskScore: 5,
    selectedReviewers: ["@user-7a91c0"],
    noHumanReason: "risk_at_or_below_low_threshold",
    details: { routing: { selected: ["@user-7a91c0"] } },
    effectiveConfigHash: "hash-1",
  };
}

function decisionEvent(input: {
  workspaceId: WorkspaceId;
  decisionId: string;
  repositoryId: string;
  riskScore?: number;
}): DecisionEventV1 {
  return {
    schemaVersion: 1,
    eventType: "routing_decision",
    eventId: `decision:${input.decisionId}:v1`,
    occurredAt: "2026-08-26T09:59:00.000Z",
    workspaceId: input.workspaceId,
    provider: "github",
    decisionId: input.decisionId,
    repositoryId: input.repositoryId,
    changeRequestId: "cr-7",
    routingKey: "routing:delivery-1",
    mode: "shadow",
    action: "policy_approval",
    riskScore: input.riskScore ?? 5,
    selectedActors: ["@user-7a91c0"],
    effectiveConfigurationHash: "hash-1",
  };
}

function replacementEvent(input: {
  workspaceId: WorkspaceId;
  decisionId: string;
}): ReviewerReplacementEventV1 {
  return {
    schemaVersion: 1,
    eventType: "reviewer_replacement",
    eventId: "reviewer-replacement:absence-42:revision:3:decision-1:v1",
    occurredAt: "2026-08-26T10:00:00.000Z",
    workspaceId: input.workspaceId,
    provider: "github",
    providerConnectionId: "connection-17",
    absenceId: "absence-42",
    absenceRevision: 3,
    decisionId: input.decisionId,
    repositoryId: "101",
    changeRequestId: "cr-7",
    unavailableActor: "@user-f2a19c",
    replacementActor: "@user-4c8d31",
    outcome: "replaced",
  };
}

async function seedWorkspace(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  externalKey: string,
): Promise<WorkspaceId> {
  const workspace = await db
    .insertInto("workspaces")
    .values({ external_key: externalKey })
    .returning("id")
    .executeTakeFirstOrThrow();
  return workspace.id;
}

async function seedRepository(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  workspaceId: WorkspaceId,
  externalRepositoryId: string,
): Promise<string> {
  const connection = await db
    .insertInto("provider_connections")
    .values({
      workspace_id: workspaceId,
      provider: "github",
      external_connection_id: `installation-${externalRepositoryId}`,
      workspace_login: `workspace-${externalRepositoryId}`,
      account_type: "Organization",
      status: "active",
      permissions: {},
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const repository = await db
    .insertInto("repositories")
    .values({
      workspace_id: workspaceId,
      provider: "github",
      provider_connection_id: connection.id,
      external_repository_id: externalRepositoryId,
      owner: `owner-${externalRepositoryId}`,
      name: "api",
      default_branch: "main",
      config_state: "unknown",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return repository.id;
}
