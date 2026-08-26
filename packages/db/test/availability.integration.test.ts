import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  ReviewerAbsenceConflictError,
  ReviewerAbsenceRevisionError,
  ReviewerAbsenceValidationError,
  cancelReviewerAbsence,
  createReviewerAbsence,
  listReviewerAbsenceWindows,
  normalizeReviewerHandle,
  readAvailabilityOverview,
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
});
