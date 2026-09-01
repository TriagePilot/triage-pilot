import type {
  DecisionEventV1,
  PlatformEventSink,
  ProviderKind,
  ReviewerReplacementEventV1,
  ReviewerReplacementOutcome,
  WorkspaceId,
} from "@triagepilot/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  claimPlatformEvents,
  createPlatformOutboxRepository,
  ensureLocalWorkspace,
  markActionSucceeded,
  persistDecision,
  persistDecisionWithEvent,
  publishPlatformOutbox,
  stagePlatformEvent,
} from "../src";
import { withPostgresTestDatabase } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("platform outbox", () => {
  it("rejects missing or blank change request identities without writing a decision or event", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const { changeRequestId: _omitted, ...missingChangeRequestId } = decisionInput(repositoryId, "delivery-missing");

      await expect(persistDecisionWithEvent(db, workspaceId, {
        decision: missingChangeRequestId as unknown as ReturnType<typeof decisionInput>,
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      })).rejects.toThrow("changeRequestId must be a non-empty provider identifier");
      await expect(persistDecision(db, workspaceId, {
        ...decisionInput(repositoryId, "delivery-blank"),
        changeRequestId: "  ",
      })).rejects.toThrow("changeRequestId must be a non-empty provider identifier");

      await expect(db.selectFrom("routing_decisions").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("persists the decision and versioned event in one transaction", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");

      const persisted = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      });

      await expect(
        db.selectFrom("decision_outbox").select([
          "workspace_id",
          "decision_id",
          "reviewer_replacement_id",
          "event_id",
          "event_type",
          "schema_version",
          "payload",
        ]).execute(),
      ).resolves.toEqual([
        expect.objectContaining({
          workspace_id: workspaceId,
          decision_id: persisted.decisionId,
          reviewer_replacement_id: null,
          event_id: `decision:${persisted.decisionId}:v1`,
          event_type: "routing_decision",
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

  it("stages reviewer replacement events through their replacement source", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const persisted = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      });
      const source = await seedReviewerReplacement(db, workspaceId, persisted.decisionId);
      const event = replacementEvent({
        workspaceId,
        ...source,
      });

      await expect(stagePlatformEvent(
        db,
        workspaceId,
        source.replacementId,
        event,
      )).resolves.toBeUndefined();
      await expect(stagePlatformEvent(db, workspaceId, source.replacementId, event)).resolves.toBeUndefined();
      await expect(db.selectFrom("decision_outbox")
        .select(["decision_id", "reviewer_replacement_id", "event_id", "event_type"])
        .where("event_type", "=", "reviewer_replacement")
        .executeTakeFirstOrThrow()).resolves.toEqual({
        decision_id: null,
        reviewer_replacement_id: source.replacementId,
        event_id: event.eventId,
        event_type: "reviewer_replacement",
      });
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toHaveLength(2);
    });
  });

  it("rejects reviewer replacement events that do not match their persisted source", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const persisted = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      });
      const source = await seedReviewerReplacement(db, workspaceId, persisted.decisionId);
      const event = replacementEvent({ workspaceId, ...source });
      const mismatches: Array<[string, Partial<ReviewerReplacementEventV1>]> = [
        ["provider", { provider: "gitlab" }],
        ["provider-connection", { providerConnectionId: "different-provider-connection" }],
        ["absence", { absenceId: "different-absence" }],
        ["absence-revision", { absenceRevision: source.absenceRevision + 1 }],
        ["decision", { decisionId: "different-decision" }],
        ["unavailable-actor", { unavailableActor: "@user-a907d2" }],
        ["replacement-actor", { replacementActor: null }],
        ["outcome", { outcome: "permanent_failure" }],
      ];

      for (const [name, mismatch] of mismatches) {
        await expect(stagePlatformEvent(db, workspaceId, source.replacementId, {
          ...event,
          ...mismatch,
          eventId: `${event.eventId}:${name}`,
        })).rejects.toThrow("reviewer replacement event does not match persisted source");
      }

      await expect(db.selectFrom("decision_outbox")
        .select("id")
        .where("event_type", "=", "reviewer_replacement")
        .execute()).resolves.toHaveLength(0);
    });
  });

  it("rejects event-id reuse with a different replacement source or payload", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const firstDecision = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      });
      const secondDecision = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-2"),
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", deliveryId: "delivery-2", occurredAt: occurredAt.toISOString() }),
      });
      const firstSource = await seedReviewerReplacement(db, workspaceId, firstDecision.decisionId, "first");
      const secondSource = await seedReviewerReplacement(db, workspaceId, secondDecision.decisionId, "second");
      const firstEvent = replacementEvent({ workspaceId, ...firstSource });

      await stagePlatformEvent(db, workspaceId, firstSource.replacementId, firstEvent);
      await expect(stagePlatformEvent(db, workspaceId, secondSource.replacementId, {
        ...replacementEvent({ workspaceId, ...secondSource }),
        eventId: firstEvent.eventId,
      })).rejects.toThrow("platform event id conflicts with a different persisted event");
      await expect(stagePlatformEvent(db, workspaceId, firstSource.replacementId, {
        ...firstEvent,
        repositoryId: "different-repository",
      })).rejects.toThrow("platform event id conflicts with a different persisted event");

      await expect(db.selectFrom("decision_outbox")
        .select(["reviewer_replacement_id", "payload"])
        .where("event_type", "=", "reviewer_replacement")
        .execute()).resolves.toEqual([{
        reviewer_replacement_id: firstSource.replacementId,
        payload: firstEvent,
      }]);
    });
  });

  it("requires exactly one event source and workspace-unique event ids", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const persisted = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      });
      const source = await seedReviewerReplacement(db, workspaceId, persisted.decisionId);
      const common = {
        workspace_id: workspaceId,
        event_type: "reviewer_replacement",
        schema_version: 1,
        payload: replacementEvent({
          workspaceId,
          ...source,
        }),
        occurred_at: new Date("2026-08-26T10:00:00.000Z"),
        available_at: new Date("2026-08-26T10:00:00.000Z"),
      };

      await expect(db.insertInto("decision_outbox").values({
        ...common,
        event_id: "invalid:no-source",
        decision_id: null,
        reviewer_replacement_id: null,
      }).execute()).rejects.toMatchObject({ constraint: "decision_outbox_exactly_one_source" });
      await expect(db.insertInto("decision_outbox").values({
        ...common,
        event_id: "invalid:two-sources",
        decision_id: persisted.decisionId,
        reviewer_replacement_id: source.replacementId,
      }).execute()).rejects.toMatchObject({ constraint: "decision_outbox_exactly_one_source" });
      await expect(db.insertInto("decision_outbox").values({
        ...common,
        event_id: `decision:${persisted.decisionId}:v1`,
        decision_id: null,
        reviewer_replacement_id: source.replacementId,
      }).execute()).rejects.toMatchObject({ constraint: "decision_outbox_workspace_event_key" });
    });
  });

  it("rolls back the decision when event identity validation fails", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const otherWorkspaceId = await seedWorkspace(db, "workspace-b");
      const repositoryId = await seedRepository(db, workspaceId, "101");

      await expect(
        persistDecisionWithEvent(db, workspaceId, {
          decision: decisionInput(repositoryId, "delivery-1"),
          event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId: otherWorkspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
        }),
      ).rejects.toThrow("routing decision event does not match persisted decision");
      await expect(db.selectFrom("routing_decisions").select("id").execute()).resolves.toHaveLength(0);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toHaveLength(0);
    });
  });

  it.each([
    ["repository", { repositoryId: "forged-repository" }],
    ["change request", { changeRequestId: "forged-change-request" }],
    ["timestamp", { occurredAt: "2025-01-01T00:00:00.000Z" }],
  ] as const)("rejects a %s identity mismatch between the decision and its event", async (_name, mismatch) => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");

      await expect(persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId, occurredAt }) => ({
          ...decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
          ...mismatch,
        }),
      })).rejects.toThrow("routing decision event does not match persisted decision");
      await expect(db.selectFrom("routing_decisions").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("validates a terminal retry event against the preserved persisted decision identity", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const first = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      });
      await markActionSucceeded(db, workspaceId, first.decisionId, new Date("2026-08-26T10:01:00.000Z"));
      const changedInput = {
        ...decisionInput(repositoryId, "delivery-1"),
        changeRequestId: "incoming-change-request",
        riskScore: 55,
      };

      await expect(persistDecisionWithEvent(db, workspaceId, {
        decision: changedInput,
        event: ({ decisionId, occurredAt }) => ({
          ...decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
          changeRequestId: changedInput.changeRequestId,
          riskScore: changedInput.riskScore,
        }),
      })).rejects.toThrow("routing decision event does not match persisted decision");
      await expect(persistDecisionWithEvent(db, workspaceId, {
        decision: changedInput,
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      })).resolves.toEqual(expect.objectContaining({ decisionId: first.decisionId, actionStatus: "succeeded" }));
      await expect(db.selectFrom("routing_decisions")
        .select(["change_request_id", "risk_score"])
        .where("id", "=", first.decisionId)
        .executeTakeFirstOrThrow()).resolves.toEqual({ change_request_id: "cr-7", risk_score: 5 });
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toHaveLength(1);
    });
  });

  it("does not create a second event for duplicate decision persistence", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");

      const first = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      });
      const retried = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      });

      expect(retried.decisionId).toBe(first.decisionId);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toHaveLength(1);
    });
  });

  it("reuses the locked first-write occurrence time for delayed exact retries", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const observedOccurrenceTimes: Date[] = [];
      const persist = () => persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-delayed"),
        event: ({ decisionId, occurredAt }) => {
          observedOccurrenceTimes.push(occurredAt);
          return decisionEvent({
            workspaceId,
            decisionId,
            repositoryId: "101",
            deliveryId: "delivery-delayed",
            occurredAt: occurredAt.toISOString(),
          });
        },
      });

      const first = await persist();
      const retried = await persist();

      expect(retried.decisionId).toBe(first.decisionId);
      expect(observedOccurrenceTimes).toHaveLength(2);
      expect(observedOccurrenceTimes[1]).toEqual(observedOccurrenceTimes[0]);
      await expect(db.selectFrom("routing_decisions")
        .innerJoin("decision_outbox", "decision_outbox.decision_id", "routing_decisions.id")
        .select(["routing_decisions.created_at", "decision_outbox.occurred_at", "decision_outbox.payload"])
        .where("routing_decisions.id", "=", first.decisionId)
        .executeTakeFirstOrThrow()).resolves.toEqual({
        created_at: observedOccurrenceTimes[0],
        occurred_at: observedOccurrenceTimes[0],
        payload: expect.objectContaining({ occurredAt: observedOccurrenceTimes[0]?.toISOString() }),
      });
    });
  });

  it("rejects a corrupt singleton routing event without staging a second event", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const persisted = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-corrupt-singleton"),
        event: ({ decisionId, occurredAt }) => decisionEvent({
          workspaceId,
          decisionId,
          repositoryId: "101",
          deliveryId: "delivery-corrupt-singleton",
          occurredAt: occurredAt.toISOString(),
        }),
      });
      const stored = await db.selectFrom("decision_outbox")
        .select("payload")
        .where("decision_id", "=", persisted.decisionId)
        .executeTakeFirstOrThrow();
      const corruptEventId = `decision:${persisted.decisionId}:noncanonical:v1`;
      await db.updateTable("decision_outbox")
        .set({
          event_id: corruptEventId,
          payload: {
            ...(stored.payload as DecisionEventV1),
            eventId: corruptEventId,
          },
        })
        .where("decision_id", "=", persisted.decisionId)
        .executeTakeFirstOrThrow();

      await expect(persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-corrupt-singleton"),
        event: ({ decisionId, occurredAt }) => decisionEvent({
          workspaceId,
          decisionId,
          repositoryId: "101",
          deliveryId: "delivery-corrupt-singleton",
          occurredAt: occurredAt.toISOString(),
        }),
      })).rejects.toThrow("persisted routing event does not match callback event");
      await expect(db.selectFrom("decision_outbox")
        .select("event_id")
        .where("decision_id", "=", persisted.decisionId)
        .execute()).resolves.toEqual([{ event_id: corruptEventId }]);
    });
  });

  it("rejects ambiguous routing events already bound to the same decision source", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const persisted = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-ambiguous"),
        event: ({ decisionId, occurredAt }) => decisionEvent({
          workspaceId,
          decisionId,
          repositoryId: "101",
          deliveryId: "delivery-ambiguous",
          occurredAt: occurredAt.toISOString(),
        }),
      });
      const stored = await db.selectFrom("decision_outbox")
        .select(["payload", "occurred_at"])
        .where("decision_id", "=", persisted.decisionId)
        .executeTakeFirstOrThrow();
      const duplicateEvent = {
        ...(stored.payload as DecisionEventV1),
        eventId: `decision:${persisted.decisionId}:duplicate:v1`,
      };
      await db.insertInto("decision_outbox").values({
        workspace_id: workspaceId,
        decision_id: persisted.decisionId,
        reviewer_replacement_id: null,
        event_id: duplicateEvent.eventId,
        event_type: "routing_decision",
        schema_version: 1,
        payload: duplicateEvent,
        occurred_at: stored.occurred_at,
        available_at: stored.occurred_at,
      }).execute();

      await expect(persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-ambiguous"),
        event: ({ decisionId, occurredAt }) => decisionEvent({
          workspaceId,
          decisionId,
          repositoryId: "101",
          deliveryId: "delivery-ambiguous",
          occurredAt: occurredAt.toISOString(),
        }),
      })).rejects.toThrow("ambiguous persisted routing events");
      await expect(db.selectFrom("decision_outbox")
        .select("id")
        .where("decision_id", "=", persisted.decisionId)
        .execute()).resolves.toHaveLength(2);
    });
  });

  it("rolls back a duplicate decision when its event id has a different payload", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db, workspaceId, "101");
      const persisted = await persistDecisionWithEvent(db, workspaceId, {
        decision: decisionInput(repositoryId, "delivery-1"),
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      });

      await expect(persistDecisionWithEvent(db, workspaceId, {
        decision: { ...decisionInput(repositoryId, "delivery-1"), riskScore: 35 },
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", riskScore: 35, occurredAt: occurredAt.toISOString() }),
      })).rejects.toThrow("routing decision event does not match persisted decision");
      await expect(db.selectFrom("routing_decisions")
        .innerJoin("decision_outbox", "decision_outbox.decision_id", "routing_decisions.id")
        .select(["routing_decisions.risk_score", "decision_outbox.payload"])
        .where("routing_decisions.id", "=", persisted.decisionId)
        .executeTakeFirstOrThrow()).resolves.toEqual({
        risk_score: 5,
        payload: expect.objectContaining({ riskScore: 5 }),
      });
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
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId: firstWorkspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
      });
      await persistDecisionWithEvent(db, secondWorkspaceId, {
        decision: decisionInput(secondRepositoryId, "delivery-2"),
        event: ({ decisionId, occurredAt }) => decisionEvent({
          workspaceId: secondWorkspaceId,
          decisionId,
          repositoryId: "202",
          deliveryId: "delivery-2",
          occurredAt: occurredAt.toISOString(),
        }),
      });

      await expect(
        claimPlatformEvents({ db, workspaceId: firstWorkspaceId, limit: 10, now: new Date("2099-08-26T10:00:00.000Z") }),
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
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
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
          now: new Date("2099-08-26T10:00:00.000Z"),
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
        now: new Date("2099-08-26T10:00:05.000Z"),
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
        event: ({ decisionId, occurredAt }) => decisionEvent({ workspaceId, decisionId, repositoryId: "101", occurredAt: occurredAt.toISOString() }),
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
        now: new Date("2099-08-26T10:00:00.000Z"),
      });

      await vi.waitFor(() => expect(firstSink.emit).toHaveBeenCalledOnce());
      await expect(publishPlatformOutbox({
        repository,
        sink: secondSink,
        limit: 10,
        now: new Date("2099-08-26T10:00:06.000Z"),
      })).resolves.toEqual({ published: 0 });
      expect(secondSink.emit).not.toHaveBeenCalled();

      const leased = (await repository.listUnpublished())[0];
      expect(leased).toEqual(expect.objectContaining({ attemptCount: 1, publishedAt: null }));
      const secondClaim = (await repository.claim({
        limit: 10,
        now: new Date("2099-08-26T10:15:01.000Z"),
      }))[0];
      expect(secondClaim).toBeDefined();
      if (secondClaim === undefined) throw new Error("expected expired lease to be claimable");
      expect(secondClaim).toEqual(expect.objectContaining({ attemptCount: 2 }));

      await repository.markFailed({
        id: secondClaim.id,
        attemptCount: 1,
        error: new Error("stale failure"),
        now: new Date("2099-08-26T10:15:02.000Z"),
      });
      await repository.markPublished({
        id: secondClaim.id,
        attemptCount: 1,
        now: new Date("2099-08-26T10:15:03.000Z"),
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
        now: new Date("2099-08-26T10:15:04.000Z"),
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
    changeRequestId: "cr-7",
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
  deliveryId?: string;
  riskScore?: number;
  occurredAt?: string;
}): DecisionEventV1 {
  return {
    schemaVersion: 1,
    eventType: "routing_decision",
    eventId: `decision:${input.decisionId}:v1`,
    occurredAt: input.occurredAt ?? "2026-08-26T09:59:00.000Z",
    workspaceId: input.workspaceId,
    provider: "github",
    decisionId: input.decisionId,
    repositoryId: input.repositoryId,
    changeRequestId: "cr-7",
    routingKey: `routing:${input.deliveryId ?? "delivery-1"}`,
    mode: "shadow",
    action: "policy_approval",
    riskScore: input.riskScore ?? 5,
    selectedActors: ["@user-7a91c0"],
    effectiveConfigurationHash: "hash-1",
  };
}

function replacementEvent(input: {
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  decisionId: string;
  providerConnectionId: string;
  absenceId: string;
  absenceRevision: number;
  replacementId: string;
  unavailableActor: string;
  replacementActor: string | null;
  outcome: ReviewerReplacementOutcome;
}): ReviewerReplacementEventV1 {
  return {
    schemaVersion: 1,
    eventType: "reviewer_replacement",
    eventId: `reviewer-replacement:${input.absenceId}:revision:${input.absenceRevision}:${input.decisionId}:v1`,
    occurredAt: "2026-08-26T10:00:00.000Z",
    workspaceId: input.workspaceId,
    provider: input.provider,
    providerConnectionId: input.providerConnectionId,
    absenceId: input.absenceId,
    absenceRevision: input.absenceRevision,
    decisionId: input.decisionId,
    repositoryId: "101",
    changeRequestId: "cr-7",
    unavailableActor: input.unavailableActor,
    replacementActor: input.replacementActor,
    outcome: input.outcome,
  };
}

async function seedReviewerReplacement(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  workspaceId: WorkspaceId,
  decisionId: string,
  suffix = "source",
): Promise<{
  provider: ProviderKind;
  providerConnectionId: string;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  replacementId: string;
  unavailableActor: string;
  replacementActor: string | null;
  outcome: ReviewerReplacementOutcome;
}> {
  const connection = await db.selectFrom("provider_connections")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  const absence = await db.insertInto("reviewer_absences").values({
    workspace_id: workspaceId,
    provider: "github",
    provider_connection_id: connection.id,
    external_actor_id: `@user-f2a19c-${suffix}`,
    start_at: new Date("2026-08-26T09:00:00.000Z"),
    end_at: new Date("2026-08-26T11:00:00.000Z"),
  }).returning("id").executeTakeFirstOrThrow();
  const intent = await db.insertInto("reviewer_mutation_intents").values({
    workspace_id: workspaceId,
    provider: "github",
    provider_connection_id: connection.id,
    absence_id: absence.id,
    absence_revision: 1,
    decision_id: decisionId,
    repository_id: "101",
    change_request_id: "cr-7",
    expected_head_revision: "head-1",
    unavailable_actor_id: `@user-f2a19c-${suffix}`,
    replacement_actor_id: "@user-4c8d31",
  }).returning("id").executeTakeFirstOrThrow();
  const replacement = await db.insertInto("reviewer_replacements").values({
    workspace_id: workspaceId,
    provider: "github",
    provider_connection_id: connection.id,
    absence_id: absence.id,
    absence_revision: 1,
    decision_id: decisionId,
    unavailable_actor_id: `@user-f2a19c-${suffix}`,
    replacement_actor_id: "@user-4c8d31",
    mutation_intent_id: intent.id,
    outcome: "replaced",
    reason: "scheduled absence",
    started_at: new Date("2026-08-26T10:00:00.000Z"),
    completed_at: new Date("2026-08-26T10:00:01.000Z"),
  }).returning("id").executeTakeFirstOrThrow();
  return {
    provider: "github",
    providerConnectionId: connection.id,
    absenceId: absence.id,
    absenceRevision: 1,
    decisionId,
    replacementId: replacement.id,
    unavailableActor: `@user-f2a19c-${suffix}`,
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
