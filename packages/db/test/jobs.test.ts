import { describe, expect, it } from "vitest";

import { buildNextRunAt, createJobQueue, type JobKind, type JobRecord } from "../src/jobs";
import { withPostgresTestDatabase } from "./postgres";

describe("buildNextRunAt", () => {
  it("uses exponential backoff capped at 15 minutes", () => {
    const now = new Date("2026-07-07T12:00:00.000Z");

    expect(buildNextRunAt(now, 1).toISOString()).toBe("2026-07-07T12:00:05.000Z");
    expect(buildNextRunAt(now, 2).toISOString()).toBe("2026-07-07T12:00:25.000Z");
    expect(buildNextRunAt(now, 20).toISOString()).toBe("2026-07-07T12:15:00.000Z");
  });

  it("defines the job record consumed by worker processes", () => {
    const job: JobRecord = {
      id: "job_1",
      kind: "process_pull_request",
      status: "queued",
      payload: { pullNumber: 7 },
      idempotencyKey: "delivery-1",
      attemptCount: 0,
      maxAttempts: 5,
      runAt: new Date("2026-07-07T12:00:00.000Z"),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    };

    expect(job.status).toBe("queued");
  });

  it("accepts routing and human-review policy evaluation jobs", () => {
    const kind: JobKind = "process_pull_request";
    const policyKind: JobKind = "evaluate_human_review_policy";
    // @ts-expect-error scheduler job kinds are outside the worker queue contract
    const removedKind: JobKind = "run_sla_checks";

    expect(kind).toBe("process_pull_request");
    expect(policyKind).toBe("evaluate_human_review_policy");
    expect(removedKind).toBe("run_sla_checks");
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    "enqueues a reviewer absence activation job at its requested future run time",
    async () => {
      const runAt = new Date("2026-10-01T08:00:00.000Z");
      await withPostgresTestDatabase(async (db) => {
        const queue = createJobQueue(db);
        const { jobId } = await queue.enqueue({
          kind: "activate_reviewer_absence",
          payload: {
            kind: "activate_reviewer_absence",
            absenceId: "018f0d7a-1bfe-7c7d-9f9a-eba4e70c3ebc",
            expectedRevision: 2,
          },
          idempotencyKey: "reviewer-absence:018f0d7a-1bfe-7c7d-9f9a-eba4e70c3ebc:2",
          runAt,
        });
        const job = await db
          .selectFrom("jobs")
          .select(["kind", "run_at"])
          .where("id", "=", jobId)
          .executeTakeFirstOrThrow();

        expect(job.kind).toBe("activate_reviewer_absence");
        expect(job.run_at.toISOString()).toBe("2026-10-01T08:00:00.000Z");
      });
    },
  );
});
