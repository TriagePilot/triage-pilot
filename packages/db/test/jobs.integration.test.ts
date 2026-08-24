import { describe, expect, it } from "vitest";

import { createJobQueue, recoverStaleJobs } from "../src/jobs";
import { readWorkerHeartbeat, updateWorkerHeartbeat } from "../src/heartbeat";
import { applyFixedRetention } from "../src/retention";
import { withPostgresTestDatabase } from "./postgres";

const payload = {
  kind: "process_pull_request" as const,
  deliveryId: "delivery-1",
  installationId: "99",
  repositoryId: "101",
  owner: "acme",
  repo: "api",
  pullNumber: 7,
  headSha: "abc123",
  eventName: "pull_request.opened",
};

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("PostgreSQL job operations", () => {
  it("requeues transient failures with backoff and fails exhausted attempts", async () => {
    await withPostgresTestDatabase(async (db) => {
      const queue = createJobQueue(db);
      const firstAttemptAt = new Date("2026-08-18T10:00:00.000Z");
      const { jobId } = await queue.enqueue({
        kind: "process_pull_request",
        payload,
        idempotencyKey: "routing:delivery-1",
        runAt: firstAttemptAt,
        maxAttempts: 2,
      });

      const firstClaim = await queue.claimNext("worker-1", firstAttemptAt);
      expect(firstClaim).toMatchObject({
        id: jobId,
        attemptCount: 1,
        status: "running",
      });
      await expect(
        queue.markFailed(toLease(firstClaim), "connection reset", firstAttemptAt, { retryable: true }),
      ).resolves.toEqual({ updated: true });

      const retry = await db
        .selectFrom("jobs")
        .select(["status", "attempt_count", "run_at", "locked_at", "locked_by", "last_error"])
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow();
      expect(retry).toEqual({
        status: "queued",
        attempt_count: 1,
        run_at: new Date("2026-08-18T10:00:05.000Z"),
        locked_at: null,
        locked_by: null,
        last_error: "connection reset",
      });

      const secondAttemptAt = retry.run_at;
      const secondClaim = await queue.claimNext("worker-1", secondAttemptAt);
      expect(secondClaim).toMatchObject({
        id: jobId,
        attemptCount: 2,
        status: "running",
      });
      await expect(
        queue.markFailed(toLease(secondClaim), "still unavailable", secondAttemptAt, { retryable: true }),
      ).resolves.toEqual({ updated: true });

      await expect(
        db
          .selectFrom("jobs")
          .select(["status", "attempt_count", "run_at", "locked_at", "locked_by", "last_error"])
          .where("id", "=", jobId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        status: "failed",
        attempt_count: 2,
        run_at: secondAttemptAt,
        locked_at: null,
        locked_by: null,
        last_error: "still unavailable",
      });
    });
  });

  it("fails a non-retryable error immediately", async () => {
    await withPostgresTestDatabase(async (db) => {
      const queue = createJobQueue(db);
      const now = new Date("2026-08-18T10:00:00.000Z");
      const { jobId } = await queue.enqueue({
        kind: "process_pull_request",
        payload,
        idempotencyKey: "routing:delivery-permanent",
        runAt: now,
      });
      const claim = await queue.claimNext("worker-1", now);

      await expect(
        queue.markFailed(toLease(claim), "permission denied", now, { retryable: false }),
      ).resolves.toEqual({ updated: true });

      await expect(
        db.selectFrom("jobs").select(["status", "attempt_count", "run_at"]).where("id", "=", jobId).executeTakeFirst(),
      ).resolves.toEqual({ status: "failed", attempt_count: 1, run_at: now });
    });
  });

  it("atomically queues an exhausted job so stale recovery can resume bounded finalization", async () => {
    await withPostgresTestDatabase(async (db) => {
      const queue = createJobQueue(db);
      const now = new Date("2026-08-18T10:00:00.000Z");
      const recoveryPayload = {
        ...payload,
        policyCheckFailureRecovery: {
          jobError: "GitHub unavailable",
          summary: "TriagePilot routing action failed after 1 attempt: GitHub unavailable",
        },
      };
      const { jobId } = await queue.enqueue({
        kind: "process_pull_request",
        payload,
        idempotencyKey: "routing:delivery-policy-recovery",
        runAt: now,
        maxAttempts: 1,
      });
      const claim = await queue.claimNext("worker-1", now);

      await expect(
        queue.markFailed(toLease(claim), "GitHub unavailable", now, {
          retryable: true,
          recovery: { payload: recoveryPayload, maxAttempts: 4 },
        }),
      ).resolves.toEqual({ updated: true });

      await expect(
        db
          .selectFrom("jobs")
          .select(["status", "payload", "attempt_count", "max_attempts", "run_at", "locked_at", "locked_by"])
          .where("id", "=", jobId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        status: "queued",
        payload: recoveryPayload,
        attempt_count: 1,
        max_attempts: 4,
        run_at: new Date("2026-08-18T10:00:05.000Z"),
        locked_at: null,
        locked_by: null,
      });

      const recoveryClaimedAt = new Date("2026-08-18T10:00:05.000Z");
      await expect(queue.claimNext("worker-that-stopped", recoveryClaimedAt)).resolves.toMatchObject({
        id: jobId,
        status: "running",
        payload: recoveryPayload,
        attemptCount: 2,
        maxAttempts: 4,
      });
      const staleRecoveryAt = new Date("2026-08-18T10:16:00.000Z");
      await recoverStaleJobs(db, staleRecoveryAt);
      await expect(
        db
          .selectFrom("jobs")
          .select(["status", "attempt_count", "max_attempts", "locked_at", "locked_by"])
          .where("id", "=", jobId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        status: "queued",
        attempt_count: 2,
        max_attempts: 4,
        locked_at: null,
        locked_by: null,
      });
    });
  });

  it("recovers stale running jobs and clears their locks", async () => {
    await withPostgresTestDatabase(async (db) => {
      const queue = createJobQueue(db);
      const claimedAt = new Date("2026-08-18T10:00:00.000Z");
      const { jobId } = await queue.enqueue({
        kind: "process_pull_request",
        payload,
        idempotencyKey: "routing:delivery-stale",
        runAt: claimedAt,
      });
      await queue.claimNext("worker-that-stopped", claimedAt);

      const quickRestartAt = new Date("2026-08-18T10:05:00.000Z");
      await recoverStaleJobs(db, quickRestartAt);
      await expect(
        db
          .selectFrom("jobs")
          .select(["status", "locked_at", "locked_by"])
          .where("id", "=", jobId)
          .executeTakeFirst(),
      ).resolves.toEqual({ status: "running", locked_at: claimedAt, locked_by: "worker-that-stopped" });

      const recoveredAt = new Date("2026-08-18T10:16:00.000Z");
      await recoverStaleJobs(db, recoveredAt);

      await expect(
        db
          .selectFrom("jobs")
          .select(["status", "locked_at", "locked_by", "updated_at"])
          .where("id", "=", jobId)
          .executeTakeFirst(),
      ).resolves.toEqual({ status: "queued", locked_at: null, locked_by: null, updated_at: recoveredAt });
    });
  });

  it("fails an exhausted stale claim instead of requeueing it", async () => {
    await withPostgresTestDatabase(async (db) => {
      const queue = createJobQueue(db);
      const claimedAt = new Date("2026-08-18T10:00:00.000Z");
      const { jobId } = await queue.enqueue({
        kind: "process_pull_request",
        payload,
        idempotencyKey: "routing:delivery-exhausted-stale",
        runAt: claimedAt,
        maxAttempts: 1,
      });
      await queue.claimNext("worker-that-stopped", claimedAt);

      const recoveredAt = new Date("2026-08-18T10:16:00.000Z");
      await recoverStaleJobs(db, recoveredAt);

      await expect(
        db
          .selectFrom("jobs")
          .select(["status", "run_at", "locked_at", "locked_by", "last_error", "updated_at"])
          .where("id", "=", jobId)
          .executeTakeFirst(),
      ).resolves.toEqual({
        status: "failed",
        run_at: recoveredAt,
        locked_at: null,
        locked_by: null,
        last_error: "job lease expired after maximum attempts",
        updated_at: recoveredAt,
      });
    });
  });

  it("rejects obsolete lease transitions without corrupting a newer or succeeded attempt", async () => {
    await withPostgresTestDatabase(async (db) => {
      const queue = createJobQueue(db);
      const firstClaimAt = new Date("2026-08-18T10:00:00.000Z");
      const { jobId } = await queue.enqueue({
        kind: "process_pull_request",
        payload,
        idempotencyKey: "routing:delivery-lease-race",
        runAt: firstClaimAt,
        maxAttempts: 3,
      });
      const obsoleteLease = toLease(await queue.claimNext("worker-old", firstClaimAt));

      const recoveredAt = new Date("2026-08-18T10:16:00.000Z");
      await recoverStaleJobs(db, recoveredAt);
      const currentLease = toLease(await queue.claimNext("worker-new", recoveredAt));

      await expect(queue.markSucceeded(obsoleteLease, new Date("2026-08-18T10:17:00.000Z"))).resolves.toEqual({
        updated: false,
        reason: "stale_lease",
      });
      await expect(
        queue.markFailed(obsoleteLease, "late old failure", new Date("2026-08-18T10:17:01.000Z"), {
          retryable: true,
        }),
      ).resolves.toEqual({ updated: false, reason: "stale_lease" });
      await expect(
        db
          .selectFrom("jobs")
          .select(["status", "attempt_count", "locked_by", "last_error"])
          .where("id", "=", jobId)
          .executeTakeFirst(),
      ).resolves.toEqual({ status: "running", attempt_count: 2, locked_by: "worker-new", last_error: null });

      const succeededAt = new Date("2026-08-18T10:18:00.000Z");
      await expect(queue.markSucceeded(currentLease, succeededAt)).resolves.toEqual({ updated: true });
      await expect(
        queue.markFailed(currentLease, "failure after success", new Date("2026-08-18T10:18:01.000Z"), {
          retryable: true,
        }),
      ).resolves.toEqual({ updated: false, reason: "stale_lease" });
      await expect(
        db
          .selectFrom("jobs")
          .select(["status", "attempt_count", "locked_at", "locked_by", "last_error", "updated_at"])
          .where("id", "=", jobId)
          .executeTakeFirst(),
      ).resolves.toEqual({
        status: "succeeded",
        attempt_count: 2,
        locked_at: null,
        locked_by: null,
        last_error: null,
        updated_at: succeededAt,
      });
    });
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("PostgreSQL worker heartbeat", () => {
  it("stores only the current worker heartbeat in the singleton row", async () => {
    await withPostgresTestDatabase(async (db) => {
      await expect(readWorkerHeartbeat(db)).resolves.toBeNull();
      await updateWorkerHeartbeat(db, {
        workerId: "worker-1",
        now: new Date("2026-08-18T10:00:00.000Z"),
      });
      await updateWorkerHeartbeat(db, {
        workerId: "worker-2",
        now: new Date("2026-08-18T10:01:00.000Z"),
      });

      await expect(readWorkerHeartbeat(db)).resolves.toEqual({
        workerId: "worker-2",
        heartbeatAt: new Date("2026-08-18T10:01:00.000Z"),
      });
      await expect(db.selectFrom("worker_heartbeat").select(db.fn.countAll().as("count")).executeTakeFirst()).resolves.toEqual({
        count: "1",
      });
    });
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("PostgreSQL fixed retention", () => {
  it("deletes only expired terminal data and never active jobs", async () => {
    await withPostgresTestDatabase(async (db) => {
      const now = new Date("2026-08-18T10:00:00.000Z");
      const old31Days = new Date("2026-07-18T09:59:59.000Z");
      const old91Days = new Date("2026-05-19T09:59:59.000Z");
      const recent = new Date("2026-08-18T09:00:00.000Z");

      await db
        .insertInto("webhook_receipts")
        .values([
          { delivery_id: "receipt-old", event_name: "pull_request", payload_summary: {}, created_at: old31Days },
          { delivery_id: "receipt-recent", event_name: "pull_request", payload_summary: {}, created_at: recent },
        ])
        .execute();
      await db
        .insertInto("jobs")
        .values([
          buildJobRow("succeeded-old", "succeeded", old31Days),
          buildJobRow("succeeded-recent", "succeeded", recent),
          buildJobRow("failed-old", "failed", old91Days),
          buildJobRow("failed-recent", "failed", recent),
          buildJobRow("queued-old", "queued", old91Days),
          { ...buildJobRow("running-old", "running", old91Days), locked_at: old91Days, locked_by: "worker-1" },
        ])
        .execute();
      await db
        .insertInto("routing_decisions")
        .values([
          buildDecisionRow("decision-old", old91Days),
          buildDecisionRow("decision-recent", recent),
        ])
        .execute();

      await applyFixedRetention(db, now);

      await expect(
        db.selectFrom("webhook_receipts").select("delivery_id").orderBy("delivery_id").execute(),
      ).resolves.toEqual([{ delivery_id: "receipt-recent" }]);
      await expect(db.selectFrom("jobs").select("idempotency_key").orderBy("idempotency_key").execute()).resolves.toEqual([
        { idempotency_key: "failed-recent" },
        { idempotency_key: "queued-old" },
        { idempotency_key: "running-old" },
        { idempotency_key: "succeeded-recent" },
      ]);
      await expect(
        db.selectFrom("routing_decisions").select("delivery_id").orderBy("delivery_id").execute(),
      ).resolves.toEqual([{ delivery_id: "decision-recent" }]);
    });
  });
});

function buildJobRow(idempotencyKey: string, status: "queued" | "running" | "succeeded" | "failed", at: Date) {
  return {
    kind: "process_pull_request",
    status,
    payload,
    idempotency_key: idempotencyKey,
    run_at: at,
    created_at: at,
    updated_at: at,
  };
}

function buildDecisionRow(deliveryId: string, createdAt: Date) {
  return {
    delivery_id: deliveryId,
    routing_key: `legacy:${deliveryId}`,
    action: "request_human_review",
    risk_score: 40,
    details: {},
    created_at: createdAt,
  };
}

function toLease(job: Awaited<ReturnType<ReturnType<typeof createJobQueue>["claimNext"]>>) {
  if (!job || job.lockedBy === null) throw new Error("expected a claimed job");
  return { jobId: job.id, lockedBy: job.lockedBy, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts };
}
