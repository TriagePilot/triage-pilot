import { describe, expect, it } from "vitest";

import { buildNextRunAt, type JobKind, type JobRecord } from "../src/jobs";

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
});
