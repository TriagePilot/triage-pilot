import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  ReviewerAbsenceConflictError,
  ReviewerAbsenceRevisionError,
  ReviewerAbsenceValidationError,
  cancelReviewerAbsence,
  createReviewerAbsence,
  listReviewerAbsenceWindows,
  loadReviewerAbsenceActivation,
  normalizeReviewerHandle,
  readAvailabilityOverview,
  recordReviewerReplacement,
  updatePolicyCheckState,
  updateOrganizationTimezone,
  updateReviewerAbsence,
} from "../src";
import { withPostgresTestDatabase } from "./postgres";

const now = new Date("2026-09-01T12:00:00.000Z");

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("reviewer availability", () => {
  it("normalizes handles and schedules a future absence with its activation job", async () => {
    expect(normalizeReviewerHandle(" @User-D82A5F ")).toBe("@user-d82a5f");
    expect(normalizeReviewerHandle("@@user")).toBeNull();
    expect(normalizeReviewerHandle("@team/name")).toBeNull();

    await withPostgresTestDatabase(async (db) => {
      const created = await createReviewerAbsence(db, {
        reviewerHandle: " @User-D82A5F ",
        startAt: new Date("2026-10-01T08:00:00.000Z"),
        endAt: new Date("2026-10-08T08:00:00.000Z"),
        now,
      });

      expect(created).toMatchObject({ reviewerHandle: "@user-d82a5f", revision: 1, status: "upcoming" });
      expect(await db.selectFrom("jobs").select(["kind", "run_at", "idempotency_key"]).executeTakeFirst()).toEqual({
        kind: "activate_reviewer_absence",
        run_at: new Date("2026-10-01T08:00:00.000Z"),
        idempotency_key: `reviewer-absence:${created.id}:revision:1`,
      });
      await expect(createReviewerAbsence(db, {
        reviewerHandle: "@USER-D82A5F",
        startAt: new Date("2026-10-08T08:00:00.000Z"),
        endAt: new Date("2026-10-09T08:00:00.000Z"),
        now,
      })).resolves.toMatchObject({ revision: 1 });
      await expect(createReviewerAbsence(db, {
        reviewerHandle: "@user-d82a5f",
        startAt: new Date("2026-10-07T08:00:00.000Z"),
        endAt: new Date("2026-10-09T08:00:00.000Z"),
        now,
      })).rejects.toBeInstanceOf(ReviewerAbsenceConflictError);
    });
  });

  it("rejects invalid absence inputs before persistence", async () => {
    await withPostgresTestDatabase(async (db) => {
      await expect(createReviewerAbsence(db, {
        reviewerHandle: "@valid-user",
        startAt: new Date("2026-10-08T08:00:00.000Z"),
        endAt: new Date("2026-10-08T08:00:00.000Z"),
        now,
      })).rejects.toBeInstanceOf(ReviewerAbsenceValidationError);
      await expect(createReviewerAbsence(db, {
        reviewerHandle: "invalid handle",
        startAt: new Date("invalid"),
        endAt: new Date("2026-10-08T08:00:00.000Z"),
        now,
      })).rejects.toBeInstanceOf(ReviewerAbsenceValidationError);
      await expect(db.selectFrom("reviewer_absences").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("updates revisions transactionally and queues active edits immediately", async () => {
    await withPostgresTestDatabase(async (db) => {
      const created = await createReviewerAbsence(db, {
        reviewerHandle: "@user-d82a5f",
        startAt: new Date("2026-10-01T08:00:00.000Z"),
        endAt: new Date("2026-10-08T08:00:00.000Z"),
        now,
      });
      const activeNow = new Date("2026-10-03T12:00:00.000Z");

      await expect(updateReviewerAbsence(db, {
        absenceId: created.id,
        expectedRevision: 1,
        reviewerHandle: " @USER-D82A5F ",
        startAt: new Date("2026-10-02T08:00:00.000Z"),
        endAt: new Date("2026-10-09T08:00:00.000Z"),
        now: activeNow,
      })).resolves.toMatchObject({ reviewerHandle: "@user-d82a5f", revision: 2, status: "active" });
      await expect(db.selectFrom("jobs").select(["run_at", "idempotency_key"]).where("idempotency_key", "=", `reviewer-absence:${created.id}:revision:2`).executeTakeFirstOrThrow()).resolves.toEqual({
        run_at: activeNow,
        idempotency_key: `reviewer-absence:${created.id}:revision:2`,
      });
      await expect(updateReviewerAbsence(db, {
        absenceId: created.id,
        expectedRevision: 1,
        reviewerHandle: "@user-d82a5f",
        startAt: new Date("2026-10-02T08:00:00.000Z"),
        endAt: new Date("2026-10-09T08:00:00.000Z"),
        now: activeNow,
      })).rejects.toBeInstanceOf(ReviewerAbsenceRevisionError);
    });
  });

  it("rolls the absence back when transactional job enqueueing fails", async () => {
    await withPostgresTestDatabase(async (db) => {
      await sql`create function reject_absence_job() returns trigger language plpgsql as $$ begin raise exception 'job rejected'; end; $$`.execute(db);
      await sql`create trigger reject_absence_job before insert on jobs for each row when (new.kind = 'activate_reviewer_absence') execute function reject_absence_job()`.execute(db);

      await expect(createReviewerAbsence(db, {
        reviewerHandle: "@user-rollback",
        startAt: new Date("2026-10-01T08:00:00.000Z"),
        endAt: new Date("2026-10-08T08:00:00.000Z"),
        now,
      })).rejects.toMatchObject({ message: expect.stringContaining("job rejected") });
      await expect(db.selectFrom("reviewer_absences").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("cancels by revision without deleting stale jobs and makes cancellation immediately observable", async () => {
    await withPostgresTestDatabase(async (db) => {
      const created = await createReviewerAbsence(db, {
        reviewerHandle: "@user-d82a5f",
        startAt: new Date("2026-10-01T08:00:00.000Z"),
        endAt: new Date("2026-10-08T08:00:00.000Z"),
        now,
      });
      const cancelledAt = new Date("2026-09-02T12:00:00.000Z");
      await expect(cancelReviewerAbsence(db, {
        absenceId: created.id,
        expectedRevision: 1,
        now: cancelledAt,
      })).resolves.toMatchObject({ revision: 2, status: "cancelled" });
      await expect(db.selectFrom("jobs").select(["run_at", "idempotency_key"]).orderBy("idempotency_key").execute()).resolves.toEqual([
        { run_at: new Date("2026-10-01T08:00:00.000Z"), idempotency_key: `reviewer-absence:${created.id}:revision:1` },
        { run_at: cancelledAt, idempotency_key: `reviewer-absence:${created.id}:revision:2` },
      ]);
      await expect(listReviewerAbsenceWindows(db, {
        reviewers: ["@user-d82a5f"],
        endingAfter: now,
      })).resolves.toEqual([]);
    });
  });

  it("reads status, replacement history, timezone, and active windows from persisted instants", async () => {
    await withPostgresTestDatabase(async (db) => {
      const active = await createReviewerAbsence(db, {
        reviewerHandle: "@user-active",
        startAt: new Date("2026-08-31T12:00:00.000Z"),
        endAt: new Date("2026-09-02T12:00:00.000Z"),
        now,
      });
      await updateOrganizationTimezone(db, { timezone: "Europe/Bratislava", now });
      const upcoming = await createReviewerAbsence(db, {
        reviewerHandle: "@user-upcoming",
        startAt: new Date("2026-09-03T12:00:00.000Z"),
        endAt: new Date("2026-09-04T12:00:00.000Z"),
        now,
      });
      const ended = await createReviewerAbsence(db, {
        reviewerHandle: "@user-ended",
        startAt: new Date("2026-08-29T12:00:00.000Z"),
        endAt: new Date("2026-08-30T12:00:00.000Z"),
        now,
      });
      const cancelled = await createReviewerAbsence(db, {
        reviewerHandle: "@user-cancelled",
        startAt: new Date("2026-09-05T12:00:00.000Z"),
        endAt: new Date("2026-09-06T12:00:00.000Z"),
        now,
      });
      await cancelReviewerAbsence(db, { absenceId: cancelled.id, expectedRevision: 1, now });
      await db
        .updateTable("reviewer_absences")
        .set({ updated_at: new Date("2026-08-01T12:00:00.000Z") })
        .where("id", "=", ended.id)
        .execute();

      const installation = await db.insertInto("installations").values({
        github_installation_id: "1",
        account_login: "acme",
        account_type: "Organization",
        status: "active",
        permissions: {},
      }).returning("id").executeTakeFirstOrThrow();
      const repository = await db.insertInto("repositories").values({
        installation_id: installation.id,
        github_repository_id: "2",
        owner: "acme",
        name: "api",
        default_branch: "main",
        config_state: "valid",
      }).returning("id").executeTakeFirstOrThrow();
      const decision = await db.insertInto("routing_decisions").values({
        repository_id: repository.id,
        delivery_id: "delivery-availability",
        routing_key: "routing-availability",
        pull_number: 12,
        head_sha: "abc123",
        mode: "shadow",
        action: "request_human_review",
        action_status: "not_applied",
        risk_score: 50,
        selected_reviewers: JSON.stringify(["@user-active"]),
        details: {},
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("reviewer_replacements").values({
        absence_id: active.id,
        absence_revision: 1,
        decision_id: decision.id,
        unavailable_reviewer: "@user-active",
        replacement_reviewer: "@user-replacement",
        outcome: "simulated_replacement",
        reason: "shadow simulation",
        started_at: now,
        completed_at: now,
      }).execute();

      await expect(readAvailabilityOverview(db, { now })).resolves.toEqual({
        timezone: "Europe/Bratislava",
        absences: [
          expect.objectContaining({
            id: active.id,
            reviewerHandle: "@user-active",
            startAt: "2026-08-31T12:00:00.000Z",
            endAt: "2026-09-02T12:00:00.000Z",
            status: "active",
            revision: 1,
            replacements: [expect.objectContaining({ repository: "acme/api", pullNumber: 12, outcome: "simulated_replacement" })],
          }),
          expect.objectContaining({ id: upcoming.id, status: "upcoming", replacements: [] }),
          expect.objectContaining({ id: cancelled.id, status: "cancelled", replacements: [] }),
          expect.objectContaining({ id: ended.id, status: "ended", replacements: [] }),
        ],
      });
      await expect(listReviewerAbsenceWindows(db, {
        reviewers: [" @USER-ACTIVE ", "@user-ended", "@not-present"],
        endingAfter: now,
      })).resolves.toEqual([
        {
          reviewerHandle: "@user-active",
          startAt: new Date("2026-08-31T12:00:00.000Z"),
          endAt: new Date("2026-09-02T12:00:00.000Z"),
        },
      ]);
    });
  });

  it("loads only the latest active human-review decisions for an active absence revision", async () => {
    await withPostgresTestDatabase(async (db) => {
      const absence = await createReviewerAbsence(db, {
        reviewerHandle: "@user-d82a5f",
        startAt: new Date("2026-08-31T12:00:00.000Z"),
        endAt: new Date("2026-09-02T12:00:00.000Z"),
        now,
      });
      const repositoryId = await seedAvailabilityRepository(db);
      const eligibleReviewers = ["@user-d82a5f", "@user-b4e82d", "@user-c91e46"];
      const details = {
        ownership: { eligibleReviewers },
        routing: { requestedReviewerCount: 2 },
      };

      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000001",
        deliveryId: "delivery-old",
        routingKey: "routing-old",
        pullNumber: 7,
        headSha: "old-head",
        mode: "enforce",
        selectedReviewers: ["@user-d82a5f"],
        details,
        policyCheckState: "in_progress",
        createdAt: new Date("2026-09-01T12:00:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000002",
        deliveryId: "delivery-shadow",
        routingKey: "routing-shadow",
        pullNumber: 8,
        headSha: "shadow-head",
        mode: "shadow",
        selectedReviewers: ["@user-d82a5f"],
        details,
        policyCheckState: "not_started",
        createdAt: new Date("2026-09-01T12:10:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000003",
        deliveryId: "delivery-current",
        routingKey: "routing-current",
        pullNumber: 7,
        headSha: "current-head",
        mode: "enforce",
        selectedReviewers: ["@user-d82a5f", "@user-b4e82d"],
        details,
        policyCheckState: "in_progress",
        createdAt: new Date("2026-09-01T12:20:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000004",
        deliveryId: "delivery-succeeded",
        routingKey: "routing-succeeded",
        pullNumber: 9,
        headSha: "succeeded-head",
        mode: "enforce",
        selectedReviewers: ["@user-d82a5f"],
        details,
        policyCheckState: "success",
        createdAt: new Date("2026-09-01T12:30:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000005",
        deliveryId: "delivery-no-human",
        routingKey: "routing-no-human",
        pullNumber: 10,
        headSha: "no-human-head",
        mode: "enforce",
        action: "no_eligible_reviewer",
        selectedReviewers: ["@user-d82a5f"],
        details,
        policyCheckState: "in_progress",
        createdAt: new Date("2026-09-01T12:40:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000006",
        deliveryId: "delivery-no-absent",
        routingKey: "routing-no-absent",
        pullNumber: 11,
        headSha: "no-absent-head",
        mode: "enforce",
        selectedReviewers: ["@user-b4e82d"],
        details,
        policyCheckState: "in_progress",
        createdAt: new Date("2026-09-01T12:50:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000007",
        deliveryId: "delivery-malformed",
        routingKey: "routing-malformed",
        pullNumber: 12,
        headSha: "malformed-head",
        mode: "enforce",
        selectedReviewers: ["@user-d82a5f"],
        details: { ownership: { eligibleReviewers: "@user-d82a5f" }, routing: { requestedReviewerCount: 2 } },
        policyCheckState: "in_progress",
        createdAt: new Date("2026-09-01T13:00:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000008",
        deliveryId: "delivery-failed",
        routingKey: "routing-failed",
        pullNumber: 13,
        headSha: "failed-head",
        mode: "enforce",
        selectedReviewers: ["@user-d82a5f"],
        details,
        policyCheckState: "failure",
        createdAt: new Date("2026-09-01T13:10:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000009",
        deliveryId: "delivery-null-head",
        routingKey: "routing-null-head",
        pullNumber: 14,
        headSha: null,
        mode: "enforce",
        selectedReviewers: ["@user-d82a5f"],
        details,
        policyCheckState: "in_progress",
        createdAt: new Date("2026-09-01T13:20:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000010",
        deliveryId: "delivery-superseded-active",
        routingKey: "routing-superseded-active",
        pullNumber: 15,
        headSha: "superseded-active-head",
        mode: "enforce",
        selectedReviewers: ["@user-d82a5f"],
        details,
        policyCheckState: "in_progress",
        createdAt: new Date("2026-09-01T13:30:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: "00000000-0000-0000-0000-000000000011",
        deliveryId: "delivery-superseding-success",
        routingKey: "routing-superseding-success",
        pullNumber: 15,
        headSha: "superseding-success-head",
        mode: "enforce",
        selectedReviewers: ["@user-d82a5f"],
        details,
        policyCheckState: "success",
        createdAt: new Date("2026-09-01T13:40:00.000Z"),
      });

      const activation = await loadReviewerAbsenceActivation(db, {
        absenceId: absence.id,
        expectedRevision: absence.revision,
        now,
      });

      expect(activation).toMatchObject({
        absenceId: absence.id,
        revision: 1,
        reviewerHandle: "@user-d82a5f",
        candidates: [
          {
            decisionId: "00000000-0000-0000-0000-000000000003",
            installationId: "99",
            repositoryId: "101",
            owner: "acme",
            repo: "api",
            pullNumber: 7,
            headSha: "current-head",
            mode: "enforce",
            selectedReviewers: ["@user-d82a5f", "@user-b4e82d"],
            originalEligibleReviewers: ["@user-d82a5f", "@user-b4e82d", "@user-c91e46"],
            requiredApprovalCount: 2,
          },
          expect.objectContaining({
            decisionId: "00000000-0000-0000-0000-000000000002",
            mode: "shadow",
            policyCheckState: "not_started",
          }),
        ],
      });
      expect(activation?.candidates).toHaveLength(2);
      await expect(loadReviewerAbsenceActivation(db, {
        absenceId: absence.id,
        expectedRevision: absence.revision + 1,
        now,
      })).resolves.toBeNull();
    });
  });

  it("does not load activation work for future, ended, or cancelled absences", async () => {
    await withPostgresTestDatabase(async (db) => {
      const future = await createReviewerAbsence(db, {
        reviewerHandle: "@user-future",
        startAt: new Date("2026-09-02T12:00:00.000Z"),
        endAt: new Date("2026-09-03T12:00:00.000Z"),
        now,
      });
      const ended = await createReviewerAbsence(db, {
        reviewerHandle: "@user-ended-noop",
        startAt: new Date("2026-08-30T12:00:00.000Z"),
        endAt: new Date("2026-08-31T12:00:00.000Z"),
        now,
      });
      const scheduled = await createReviewerAbsence(db, {
        reviewerHandle: "@user-cancelled-noop",
        startAt: new Date("2026-09-02T12:00:00.000Z"),
        endAt: new Date("2026-09-03T12:00:00.000Z"),
        now,
      });
      const cancelled = await cancelReviewerAbsence(db, {
        absenceId: scheduled.id,
        expectedRevision: scheduled.revision,
        now,
      });

      await expect(loadReviewerAbsenceActivation(db, {
        absenceId: future.id,
        expectedRevision: future.revision,
        now,
      })).resolves.toBeNull();
      await expect(loadReviewerAbsenceActivation(db, {
        absenceId: ended.id,
        expectedRevision: ended.revision,
        now,
      })).resolves.toBeNull();
      await expect(loadReviewerAbsenceActivation(db, {
        absenceId: cancelled.id,
        expectedRevision: cancelled.revision,
        now,
      })).resolves.toBeNull();
    });
  });

  it("reloads recorded finalizer work after cohort and policy state transitions", async () => {
    await withPostgresTestDatabase(async (db) => {
      const absence = await createReviewerAbsence(db, {
        reviewerHandle: "@user-d82a5f",
        startAt: new Date("2026-08-31T12:00:00.000Z"),
        endAt: new Date("2026-09-02T12:00:00.000Z"),
        now,
      });
      const repositoryId = await seedAvailabilityRepository(db);
      const details = {
        ownership: { eligibleReviewers: ["@user-d82a5f", "@user-c91e46"] },
        routing: { requestedReviewerCount: 1 },
      };
      const replacedDecisionId = "00000000-0000-0000-0000-000000000021";
      const blockedDecisionId = "00000000-0000-0000-0000-000000000022";
      await seedAvailabilityDecision(db, repositoryId, {
        id: replacedDecisionId,
        deliveryId: "delivery-recorded-replaced",
        routingKey: "routing-recorded-replaced",
        pullNumber: 21,
        headSha: "replaced-head",
        mode: "enforce",
        selectedReviewers: ["@user-d82a5f"],
        details,
        policyCheckState: "in_progress",
        createdAt: new Date("2026-09-01T14:00:00.000Z"),
      });
      await seedAvailabilityDecision(db, repositoryId, {
        id: blockedDecisionId,
        deliveryId: "delivery-recorded-blocked",
        routingKey: "routing-recorded-blocked",
        pullNumber: 22,
        headSha: "blocked-head",
        mode: "enforce",
        selectedReviewers: ["@user-d82a5f"],
        details,
        policyCheckState: "in_progress",
        createdAt: new Date("2026-09-01T14:10:00.000Z"),
      });

      await recordReviewerReplacement(db, {
        absenceId: absence.id,
        absenceRevision: absence.revision,
        decisionId: replacedDecisionId,
        unavailableReviewer: "@user-d82a5f",
        replacementReviewer: "@user-c91e46",
        outcome: "replaced",
        reason: "replacement recorded before finalization",
        startedAt: now,
        completedAt: now,
        replaceCohort: true,
      });
      await recordReviewerReplacement(db, {
        absenceId: absence.id,
        absenceRevision: absence.revision,
        decisionId: blockedDecisionId,
        unavailableReviewer: "@user-d82a5f",
        replacementReviewer: null,
        outcome: "no_replacement_available",
        reason: "blocking recorded before finalization",
        startedAt: now,
        completedAt: now,
        replaceCohort: false,
      });
      await updatePolicyCheckState(db, { decisionId: replacedDecisionId, state: "success" });
      await updatePolicyCheckState(db, { decisionId: blockedDecisionId, state: "failure" });

      const activation = await loadReviewerAbsenceActivation(db, {
        absenceId: absence.id,
        expectedRevision: absence.revision,
        now,
      });

      expect(activation?.candidates.map((candidate) => candidate.decisionId)).toEqual([
        blockedDecisionId,
        replacedDecisionId,
      ]);
      expect(activation?.candidates).toEqual([
        expect.objectContaining({
          decisionId: blockedDecisionId,
          selectedReviewers: ["@user-d82a5f"],
          policyCheckState: "failure",
        }),
        expect.objectContaining({
          decisionId: replacedDecisionId,
          selectedReviewers: ["@user-c91e46"],
          policyCheckState: "success",
        }),
      ]);
    });
  });
});

async function seedAvailabilityRepository(db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]): Promise<string> {
  const installation = await db
    .insertInto("installations")
    .values({
      github_installation_id: "99",
      account_login: "acme",
      account_type: "Organization",
      status: "active",
      permissions: {},
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const repository = await db
    .insertInto("repositories")
    .values({
      installation_id: installation.id,
      github_repository_id: "101",
      owner: "acme",
      name: "api",
      default_branch: "main",
      config_state: "valid",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return repository.id;
}

async function seedAvailabilityDecision(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  repositoryId: string,
  input: {
    id: string;
    deliveryId: string;
    routingKey: string;
    pullNumber: number;
    headSha: string | null;
    mode: "shadow" | "enforce";
    selectedReviewers: string[];
    details: unknown;
    policyCheckState: "not_started" | "in_progress" | "success" | "failure";
    createdAt: Date;
    action?: string;
  },
): Promise<void> {
  await db.insertInto("routing_decisions").values({
    id: input.id,
    repository_id: repositoryId,
    delivery_id: input.deliveryId,
    routing_key: input.routingKey,
    pull_number: input.pullNumber,
    head_sha: input.headSha,
    mode: input.mode,
    action: input.action ?? "request_human_review",
    action_status: input.mode === "enforce" ? "pending" : "not_applied",
    risk_score: 50,
    selected_reviewer: input.selectedReviewers[0] ?? null,
    selected_reviewers: JSON.stringify(input.selectedReviewers),
    details: input.details,
    policy_check_state: input.policyCheckState,
    created_at: input.createdAt,
  }).execute();
}
