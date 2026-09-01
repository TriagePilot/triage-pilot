import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { ProviderKind, ReviewerReplacementEventV1 } from "@triagepilot/contracts";

import {
  ProviderConnectionUnavailableError,
  ReviewerAbsenceRevisionError,
  ReviewerAvailabilityValidationError,
  createWorkspaceReviewerAvailability,
  persistDecision,
} from "../src";
import { withPostgresTestDatabase } from "./postgres";

const now = new Date("2026-09-01T12:00:00.000Z");

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("workspace reviewer availability", () => {
  it("persists an explicit IANA timezone for only the bound workspace", async () => {
    await withPostgresTestDatabase(async (db) => {
      const first = await seedWorkspace(db, "availability-settings-a", "github", "connection-a");
      const second = await seedWorkspace(db, "availability-settings-b", "gitlab", "connection-b");
      const availabilityA = createWorkspaceReviewerAvailability(db, first.workspaceId);
      const availabilityB = createWorkspaceReviewerAvailability(db, second.workspaceId);

      await expect(availabilityA.readSettings()).resolves.toMatchObject({
        workspaceId: first.workspaceId,
        timezone: "UTC",
      });
      await expect(availabilityB.updateTimezone("Europe/Bratislava", now)).resolves.toEqual({
        workspaceId: second.workspaceId,
        timezone: "Europe/Bratislava",
        updatedAt: now,
      });
      await expect(availabilityA.readSettings()).resolves.toMatchObject({ timezone: "UTC" });
      await expect(availabilityB.updateTimezone("Not/A_Timezone", now))
        .rejects.toBeInstanceOf(ReviewerAvailabilityValidationError);
      await expect(availabilityB.readSettings()).resolves.toMatchObject({ timezone: "Europe/Bratislava" });
    });
  });

  it("normalizes the actor and enqueues the revision-specific activation in the schedule transaction", async () => {
    await withPostgresTestDatabase(async (db) => {
      const scope = await seedWorkspace(db, "availability-schedule", "github", "connection-schedule");
      const availability = createWorkspaceReviewerAvailability(db, scope.workspaceId);
      const startAt = new Date("2026-10-01T08:00:00.000Z");
      const endAt = new Date("2026-10-08T08:00:00.000Z");

      const absence = await availability.scheduleAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        externalActorId: " @User-D82A5F ",
        startAt,
        endAt,
        now,
      });

      expect(absence).toMatchObject({
        workspaceId: scope.workspaceId,
        provider: "github",
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "@user-d82a5f",
        status: "scheduled",
        revision: 1,
      });
      await expect(db.selectFrom("jobs")
        .select(["workspace_id", "provider", "provider_connection_id", "kind", "payload", "run_at", "idempotency_key"])
        .executeTakeFirstOrThrow()).resolves.toEqual({
        workspace_id: scope.workspaceId,
        provider: "github",
        provider_connection_id: scope.providerConnectionId,
        kind: "activate_reviewer_absence",
        payload: {
          kind: "activate_reviewer_absence",
          workspaceId: scope.workspaceId,
          providerConnectionId: scope.providerConnectionId,
          absenceId: absence.id,
          absenceRevision: 1,
        },
        run_at: startAt,
        idempotency_key: `reviewer-absence:${absence.id}:revision:1`,
      });

      await sql`create function reject_activation_job() returns trigger language plpgsql as $$ begin raise exception 'activation job rejected'; end; $$`.execute(db);
      await sql`create trigger reject_activation_job before insert on jobs for each row when (new.kind = 'activate_reviewer_absence') execute function reject_activation_job()`.execute(db);
      await expect(availability.scheduleAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "@user-rollback",
        startAt: new Date("2026-10-09T08:00:00.000Z"),
        endAt: new Date("2026-10-10T08:00:00.000Z"),
        now,
      })).rejects.toThrow("activation job rejected");
      await expect(db.selectFrom("reviewer_absences").select("external_actor_id").orderBy("external_actor_id").execute())
        .resolves.toEqual([{ external_actor_id: "@user-d82a5f" }]);
    });
  });

  it("locks revisions for edits and cancellation while retaining stale activation jobs", async () => {
    await withPostgresTestDatabase(async (db) => {
      const scope = await seedWorkspace(db, "availability-revisions", "github", "connection-revisions");
      const availability = createWorkspaceReviewerAvailability(db, scope.workspaceId);
      const created = await availability.scheduleAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "@user-revisions",
        startAt: new Date("2026-10-01T08:00:00.000Z"),
        endAt: new Date("2026-10-08T08:00:00.000Z"),
        now,
      });
      const activeNow = new Date("2026-10-03T12:00:00.000Z");
      const revised = await availability.reviseAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        absenceId: created.id,
        expectedRevision: 1,
        externalActorId: " @USER-REVISIONS ",
        startAt: new Date("2026-10-02T08:00:00.000Z"),
        endAt: new Date("2026-10-09T08:00:00.000Z"),
        now: activeNow,
      });

      expect(revised).toMatchObject({ revision: 2, status: "scheduled", externalActorId: "@user-revisions" });
      await expect(availability.reviseAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        absenceId: created.id,
        expectedRevision: 1,
        externalActorId: "@user-revisions",
        startAt: revised.startAt,
        endAt: revised.endAt,
        now: activeNow,
      })).rejects.toBeInstanceOf(ReviewerAbsenceRevisionError);

      const cancelledAt = new Date("2026-10-03T12:01:00.000Z");
      await expect(availability.cancelAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        absenceId: created.id,
        expectedRevision: 2,
        now: cancelledAt,
      })).resolves.toMatchObject({ revision: 3, status: "cancelled", cancelledAt });
      await expect(db.selectFrom("jobs")
        .select(["idempotency_key", "run_at"])
        .orderBy("idempotency_key")
        .execute()).resolves.toEqual([
        { idempotency_key: `reviewer-absence:${created.id}:revision:1`, run_at: new Date("2026-10-01T08:00:00.000Z") },
        { idempotency_key: `reviewer-absence:${created.id}:revision:2`, run_at: activeNow },
        { idempotency_key: `reviewer-absence:${created.id}:revision:3`, run_at: cancelledAt },
      ]);
      await expect(availability.listAbsences()).resolves.toEqual([
        expect.objectContaining({ id: created.id, revision: 3, status: "cancelled" }),
      ]);
    });
  });

  it("uses a half-open active lookup and rejects inactive or mismatched provider connections", async () => {
    await withPostgresTestDatabase(async (db) => {
      const scope = await seedWorkspace(db, "availability-active", "gitlab", "connection-active");
      const availability = createWorkspaceReviewerAvailability(db, scope.workspaceId);
      const startAt = new Date("2026-09-02T08:00:00.000Z");
      const endAt = new Date("2026-09-02T12:00:00.000Z");
      await availability.scheduleAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "@user-active",
        startAt,
        endAt,
        now,
      });

      await expect(availability.findActiveAbsences({
        providerConnectionId: scope.providerConnectionId,
        actors: [" @USER-ACTIVE ", "@user-missing"],
        at: startAt,
      })).resolves.toEqual([{ externalActorId: "@user-active", startAt, endAt }]);
      await expect(availability.findActiveAbsences({
        providerConnectionId: scope.providerConnectionId,
        actors: ["@user-active"],
        at: endAt,
      })).resolves.toEqual([]);
      await expect(availability.scheduleAbsence({
        provider: "github",
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "@user-wrong-provider",
        startAt,
        endAt,
        now,
      })).rejects.toBeInstanceOf(ProviderConnectionUnavailableError);

      await db.updateTable("provider_connections")
        .set({ status: "suspended" })
        .where("workspace_id", "=", scope.workspaceId)
        .where("id", "=", scope.providerConnectionId)
        .execute();
      await expect(availability.findActiveAbsences({
        providerConnectionId: scope.providerConnectionId,
        actors: ["@user-active"],
        at: startAt,
      })).resolves.toEqual([]);
    });
  });

  it.each(["revise", "cancel"] as const)(
    "rejects final persistence after an in-flight absence %s",
    async (mutation) => {
      await withPostgresTestDatabase(async (db) => {
        const fixture = await seedReplacementFixture(db, `availability-final-${mutation}`);
        const activation = await fixture.availability.loadActivation(fixture.absence.id, fixture.absence.revision);
        expect(activation?.candidates.map((candidate) => candidate.decisionId)).toEqual([fixture.decisionId]);

        if (mutation === "revise") {
          await fixture.availability.reviseAbsence({
            provider: fixture.scope.provider,
            providerConnectionId: fixture.scope.providerConnectionId,
            absenceId: fixture.absence.id,
            expectedRevision: fixture.absence.revision,
            externalActorId: fixture.absence.externalActorId,
            startAt: new Date("2026-08-30T12:00:00.000Z"),
            endAt: new Date("2026-09-03T12:00:00.000Z"),
            now,
          });
        } else {
          await fixture.availability.cancelAbsence({
            provider: fixture.scope.provider,
            providerConnectionId: fixture.scope.providerConnectionId,
            absenceId: fixture.absence.id,
            expectedRevision: fixture.absence.revision,
            now,
          });
        }

        await expect(fixture.availability.persistReplacement(replacementInput(fixture)))
          .resolves.toEqual({ inserted: false, activationCurrent: false, replacement: null });
        await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
        await expect(readSelectedActors(db, fixture.decisionId)).resolves.toEqual(["@user-absent"]);
      });
    },
  );

  it("persists history, cohort mutation, explicit finalizer state, and the event idempotently", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-idempotency");
      const input = replacementInput(fixture);

      const first = await fixture.availability.persistReplacement(input);
      expect(first).toMatchObject({
        inserted: true,
        activationCurrent: true,
        replacement: {
          absenceId: fixture.absence.id,
          decisionId: fixture.decisionId,
          unavailableActorId: "@user-absent",
          replacementActorId: "@user-replacement",
          outcome: "replaced",
          state: "finalizer_pending",
          lastError: null,
        },
      });
      await expect(fixture.availability.persistReplacement(input)).resolves.toEqual({
        inserted: false,
        activationCurrent: true,
        replacement: first.replacement,
      });
      await expect(fixture.availability.persistReplacement({
        ...input,
        event: { ...input.event, eventId: `${input.event.eventId}:different` },
      })).rejects.toThrow("reviewer replacement retry conflicts with persisted platform event");
      await expect(readSelectedActors(db, fixture.decisionId)).resolves.toEqual(["@user-replacement"]);
      await expect(db.selectFrom("decision_outbox")
        .select(["event_id", "event_type", "reviewer_replacement_id", "payload"])
        .execute()).resolves.toEqual([{
        event_id: input.event.eventId,
        event_type: "reviewer_replacement",
        reviewer_replacement_id: first.replacement?.id,
        payload: input.event,
      }]);

      const revised = await fixture.availability.reviseAbsence({
        provider: fixture.scope.provider,
        providerConnectionId: fixture.scope.providerConnectionId,
        absenceId: fixture.absence.id,
        expectedRevision: fixture.absence.revision,
        externalActorId: fixture.absence.externalActorId,
        startAt: new Date("2026-08-30T12:00:00.000Z"),
        endAt: new Date("2026-09-03T12:00:00.000Z"),
        now,
      });
      await expect(fixture.availability.loadActivation(revised.id, revised.revision))
        .resolves.toMatchObject({ pendingFinalizers: [] });

      const completed = await fixture.availability.updateReplacementState({
        replacementId: first.replacement!.id,
        expectedState: "finalizer_pending",
        state: "completed",
        lastError: null,
      });
      expect(completed).toMatchObject({ state: "completed", lastError: null });
      await expect(fixture.availability.updateReplacementState({
        replacementId: first.replacement!.id,
        expectedState: "finalizer_pending",
        state: "permanent_failure",
        lastError: "late failure",
      })).resolves.toBeNull();
      await expect(fixture.availability.listReplacementHistory(fixture.absence.id)).resolves.toEqual([
        expect.objectContaining({ id: first.replacement!.id, state: "completed", lastError: null }),
      ]);
    });
  });

  it("revalidates the decision head and replacement availability under the final transaction", async () => {
    await withPostgresTestDatabase(async (db) => {
      const changedHead = await seedReplacementFixture(db, "availability-changed-head");
      await db.updateTable("routing_decisions")
        .set({ head_sha: "head-2" })
        .where("workspace_id", "=", changedHead.scope.workspaceId)
        .where("id", "=", changedHead.decisionId)
        .execute();
      await expect(changedHead.availability.persistReplacement(replacementInput(changedHead)))
        .resolves.toEqual({ inserted: false, activationCurrent: false, replacement: null });

      const absentReplacement = await seedReplacementFixture(db, "availability-absent-replacement");
      await absentReplacement.availability.scheduleAbsence({
        provider: absentReplacement.scope.provider,
        providerConnectionId: absentReplacement.scope.providerConnectionId,
        externalActorId: "@user-replacement",
        startAt: new Date("2026-08-31T12:00:00.000Z"),
        endAt: new Date("2026-09-02T12:00:00.000Z"),
        now,
      });
      await expect(absentReplacement.availability.persistReplacement(replacementInput(absentReplacement)))
        .resolves.toEqual({ inserted: false, activationCurrent: false, replacement: null });
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("rolls back replacement history and cohort state when event staging fails", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-event-rollback");
      await sql`create function reject_replacement_event() returns trigger language plpgsql as $$ begin raise exception 'replacement event rejected'; end; $$`.execute(db);
      await sql`create trigger reject_replacement_event before insert on decision_outbox for each row when (new.event_type = 'reviewer_replacement') execute function reject_replacement_event()`.execute(db);

      await expect(fixture.availability.persistReplacement(replacementInput(fixture)))
        .rejects.toThrow("replacement event rejected");
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toEqual([]);
      await expect(readSelectedActors(db, fixture.decisionId)).resolves.toEqual(["@user-absent"]);
    });
  });
});

async function seedWorkspace(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  externalKey: string,
  provider: ProviderKind,
  externalConnectionId: string,
) {
  const workspace = await db.insertInto("workspaces")
    .values({ external_key: externalKey })
    .returning("id")
    .executeTakeFirstOrThrow();
  const connection = await db.insertInto("provider_connections").values({
    workspace_id: workspace.id,
    provider,
    external_connection_id: externalConnectionId,
    workspace_login: externalKey,
    account_type: "organization",
    status: "active",
    permissions: {},
  }).returning("id").executeTakeFirstOrThrow();
  return { workspaceId: workspace.id, provider, providerConnectionId: connection.id };
}

async function seedReplacementFixture(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  externalKey: string,
) {
  const scope = await seedWorkspace(db, externalKey, "github", `${externalKey}-connection`);
  const repository = await db.insertInto("repositories").values({
    workspace_id: scope.workspaceId,
    provider: scope.provider,
    provider_connection_id: scope.providerConnectionId,
    external_repository_id: `${externalKey}-repository`,
    owner: "example",
    name: "service",
    default_branch: "main",
    config_state: "valid",
  }).returning("id").executeTakeFirstOrThrow();
  const availability = createWorkspaceReviewerAvailability(db, scope.workspaceId);
  const absence = await availability.scheduleAbsence({
    provider: scope.provider,
    providerConnectionId: scope.providerConnectionId,
    externalActorId: "@user-absent",
    startAt: new Date("2026-08-31T12:00:00.000Z"),
    endAt: new Date("2026-09-02T12:00:00.000Z"),
    now,
  });
  const decision = await persistDecision(db, scope.workspaceId, {
    repositoryId: repository.id,
    deliveryId: `${externalKey}-delivery`,
    routingKey: `${externalKey}-routing`,
    pullNumber: 17,
    headSha: "head-1",
    mode: "enforce",
    action: "request_human_review",
    actionStatus: "pending",
    riskScore: 50,
    selectedReviewers: ["@user-absent"],
    details: {
      ownership: {
        preferredReviewers: ["@user-absent", "@user-replacement"],
        eligibleReviewers: ["@user-absent", "@user-replacement"],
      },
      routing: { requestedReviewerCount: 1 },
    },
  });
  return {
    db,
    scope,
    availability,
    absence,
    decisionId: decision.decisionId,
    externalRepositoryId: `${externalKey}-repository`,
  };
}

function replacementInput(fixture: Awaited<ReturnType<typeof seedReplacementFixture>>) {
  const event: ReviewerReplacementEventV1 = {
    schemaVersion: 1,
    eventType: "reviewer_replacement",
    eventId: `replacement:${fixture.absence.id}:revision:1:${fixture.decisionId}`,
    occurredAt: now.toISOString(),
    workspaceId: fixture.scope.workspaceId,
    provider: fixture.scope.provider,
    providerConnectionId: fixture.scope.providerConnectionId,
    absenceId: fixture.absence.id,
    absenceRevision: fixture.absence.revision,
    decisionId: fixture.decisionId,
    repositoryId: fixture.externalRepositoryId,
    changeRequestId: "change-request-17",
    unavailableActor: "@user-absent",
    replacementActor: "@user-replacement",
    outcome: "replaced",
  };
  return {
    provider: fixture.scope.provider,
    providerConnectionId: fixture.scope.providerConnectionId,
    absenceId: fixture.absence.id,
    absenceRevision: fixture.absence.revision,
    decisionId: fixture.decisionId,
    expectedHeadRevision: "head-1",
    unavailableActorId: "@user-absent",
    replacementActorId: "@user-replacement",
    outcome: "replaced" as const,
    reason: "scheduled absence",
    state: "finalizer_pending" as const,
    lastError: null,
    startedAt: now,
    completedAt: now,
    replaceCohort: true,
    event,
  };
}

async function readSelectedActors(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  decisionId: string,
): Promise<string[]> {
  const row = await db.selectFrom("routing_decisions")
    .select("selected_reviewers")
    .where("id", "=", decisionId)
    .executeTakeFirstOrThrow();
  return row.selected_reviewers as string[];
}
