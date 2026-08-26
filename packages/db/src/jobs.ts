import type { Kysely } from "kysely";

import type { Database, JobRow } from "./kysely";

export type JobKind = "process_pull_request" | "evaluate_human_review_policy" | "activate_reviewer_absence";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  payload: unknown;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  runAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
}

export interface EnqueueJobInput {
  kind: JobKind;
  payload: unknown;
  idempotencyKey: string;
  runAt?: Date;
  maxAttempts?: number;
}

export interface JobLease {
  jobId: string;
  lockedBy: string;
  attemptCount: number;
  maxAttempts: number;
}

export type JobTransitionResult = { updated: true } | { updated: false; reason: "stale_lease" };

export interface JobRecovery {
  payload: unknown;
  maxAttempts: number;
}

export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<{ inserted: boolean; jobId: string }>;
  claimNext(workerId: string, now: Date): Promise<JobRecord | null>;
  markSucceeded(lease: JobLease, now: Date): Promise<JobTransitionResult>;
  markFailed(
    lease: JobLease,
    error: string,
    now: Date,
    options: { retryable: boolean; recovery?: JobRecovery },
  ): Promise<JobTransitionResult>;
}

export function buildNextRunAt(now: Date, attemptCount: number): Date {
  const delaySeconds = Math.min(900, 5 ** Math.max(1, attemptCount));
  return new Date(now.getTime() + delaySeconds * 1000);
}

export async function recoverStaleJobs(
  db: Kysely<Database>,
  now: Date,
  staleAfterMs = 15 * 60 * 1000,
): Promise<void> {
  const staleBefore = new Date(now.getTime() - staleAfterMs);
  await db
    .updateTable("jobs")
    .set({
      status: "failed",
      run_at: now,
      locked_at: null,
      locked_by: null,
      last_error: "job lease expired after maximum attempts",
      updated_at: now,
    })
    .where("status", "=", "running")
    .where("locked_at", "<", staleBefore)
    .whereRef("attempt_count", ">=", "max_attempts")
    .execute();
  await db
    .updateTable("jobs")
    .set({
      status: "queued",
      locked_at: null,
      locked_by: null,
      updated_at: now,
    })
    .where("status", "=", "running")
    .where("locked_at", "<", staleBefore)
    .whereRef("attempt_count", "<", "max_attempts")
    .execute();
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    status: row.status,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
  };
}

export function createJobQueue(db: Kysely<Database>): JobQueue {
  return {
    async enqueue(input) {
      const inserted = await db
        .insertInto("jobs")
        .values({
          kind: input.kind,
          payload: input.payload,
          idempotency_key: input.idempotencyKey,
          run_at: input.runAt ?? new Date(),
          max_attempts: input.maxAttempts ?? 5,
        })
        .onConflict((oc) => oc.column("idempotency_key").doNothing())
        .returning(["id"])
        .executeTakeFirst();

      if (inserted) return { inserted: true, jobId: inserted.id };

      const existing = await db
        .selectFrom("jobs")
        .select(["id"])
        .where("idempotency_key", "=", input.idempotencyKey)
        .executeTakeFirstOrThrow();
      return { inserted: false, jobId: existing.id };
    },

    async claimNext(workerId, now) {
      return db.transaction().execute(async (trx) => {
        const job = await trx
          .selectFrom("jobs")
          .selectAll()
          .where("status", "=", "queued")
          .where("run_at", "<=", now)
          .orderBy("run_at", "asc")
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();

        if (!job) return null;

        const claimed = await trx
          .updateTable("jobs")
          .set({
            status: "running",
            locked_at: now,
            locked_by: workerId,
            attempt_count: job.attempt_count + 1,
            updated_at: now,
          })
          .where("id", "=", job.id)
          .returningAll()
          .executeTakeFirstOrThrow();

        return toJobRecord(claimed);
      });
    },

    async markSucceeded(lease, now) {
      const updated = await db
        .updateTable("jobs")
        .set({ status: "succeeded", locked_at: null, locked_by: null, updated_at: now })
        .where("id", "=", lease.jobId)
        .where("status", "=", "running")
        .where("locked_by", "=", lease.lockedBy)
        .where("attempt_count", "=", lease.attemptCount)
        .returning("id")
        .executeTakeFirst();
      return updated ? { updated: true } : { updated: false, reason: "stale_lease" };
    },

    async markFailed(lease, error, now, options) {
      const recovery = options.recovery;
      const exhausted = recovery === undefined && (!options.retryable || lease.attemptCount >= lease.maxAttempts);

      const updated = await db
        .updateTable("jobs")
        .set({
          status: recovery === undefined && exhausted ? "failed" : "queued",
          ...(recovery === undefined
            ? {}
            : { payload: recovery.payload, max_attempts: recovery.maxAttempts }),
          last_error: error,
          run_at: recovery === undefined && exhausted ? now : buildNextRunAt(now, lease.attemptCount),
          locked_at: null,
          locked_by: null,
          updated_at: now,
        })
        .where("id", "=", lease.jobId)
        .where("status", "=", "running")
        .where("locked_by", "=", lease.lockedBy)
        .where("attempt_count", "=", lease.attemptCount)
        .returning("id")
        .executeTakeFirst();
      return updated ? { updated: true } : { updated: false, reason: "stale_lease" };
    },
  };
}
