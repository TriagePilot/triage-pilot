import type { Kysely } from "kysely";
import type { ProviderConnectionId, ProviderKind, WorkspaceId } from "@triagepilot/contracts";

import type { Database, JobRow } from "./kysely.js";
import {
  buildMutationIntentRecoveryAudit,
  persistMutationIntentRecoveryTransaction,
  type PersistReviewerReplacementInput,
} from "./availability.js";

export type JobKind = "process_pull_request" | "evaluate_human_review_policy" | "activate_reviewer_absence";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  id: string;
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
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
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  kind: JobKind;
  payload: unknown;
  idempotencyKey: string;
  runAt?: Date;
  maxAttempts?: number;
}

export interface JobLease {
  jobId: string;
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  lockedBy: string;
  attemptCount: number;
  maxAttempts: number;
}

export type JobTransitionResult = { updated: true } | { updated: false; reason: "stale_lease" };

export interface JobRecovery {
  payload: unknown;
  maxAttempts: number;
}

export interface WorkspaceJobQueue {
  enqueue(input: EnqueueJobInput): Promise<{ inserted: boolean; jobId: string }>;
  markSucceeded(lease: JobLease, now: Date): Promise<JobTransitionResult>;
  markFailed(
    lease: JobLease,
    error: string,
    now: Date,
    options: { retryable: boolean; recovery?: JobRecovery },
  ): Promise<JobTransitionResult>;
}

export interface JobClaimer {
  claimNext(workerId: string, now: Date): Promise<JobRecord | null>;
}

export function buildNextRunAt(now: Date, attemptCount: number): Date {
  const delaySeconds = Math.min(900, 5 ** Math.max(1, attemptCount));
  return new Date(now.getTime() + delaySeconds * 1000);
}

export async function recoverStaleJobs(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: Date,
  staleAfterMs = 15 * 60 * 1000,
): Promise<void> {
  const staleBefore = new Date(now.getTime() - staleAfterMs);
  await db.transaction().execute(async (trx) => {
    const exhausted = await trx.selectFrom("jobs")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("status", "=", "running")
      .where("locked_at", "<", staleBefore)
      .whereRef("attempt_count", ">=", "max_attempts")
      .forUpdate()
      .execute();
    const failure = "job lease expired after maximum attempts";
    for (const job of exhausted) {
      const persistenceAudit = parseStaleReviewerPersistenceRecovery(job, failure);
      if (persistenceAudit !== null) {
        await persistMutationIntentRecoveryTransaction(trx, job.workspace_id, persistenceAudit);
      }
      const recovery = parseStaleReviewerFinalizerRecovery(job);
      if (recovery !== null) {
        await trx.updateTable("reviewer_replacements")
          .set({ state: "permanent_failure", last_error: failure })
          .where("id", "=", recovery.replacementId)
          .where("workspace_id", "=", job.workspace_id)
          .where("provider", "=", job.provider)
          .where("provider_connection_id", "=", job.provider_connection_id)
          .where("absence_id", "=", recovery.absenceId)
          .where("absence_revision", "=", recovery.absenceRevision)
          .where("decision_id", "=", recovery.decisionId)
          .where("outcome", "=", recovery.outcome)
          .where("replacement_actor_id", recovery.replacementActorId === null ? "is" : "=", recovery.replacementActorId)
          .where("mutation_intent_id", recovery.mutationIntentId === null ? "is" : "=", recovery.mutationIntentId)
          .where("state", "=", "finalizer_pending")
          .execute();
      }
      await trx.updateTable("jobs")
        .set({
          status: "failed",
          run_at: now,
          locked_at: null,
          locked_by: null,
          last_error: failure,
          updated_at: now,
        })
        .where("id", "=", job.id)
        .where("workspace_id", "=", workspaceId)
        .where("status", "=", "running")
        .where("locked_by", "=", job.locked_by)
        .where("attempt_count", "=", job.attempt_count)
        .execute();
    }
    await trx.updateTable("jobs")
      .set({
        status: "queued",
        locked_at: null,
        locked_by: null,
        updated_at: now,
      })
      .where("workspace_id", "=", workspaceId)
      .where("status", "=", "running")
      .where("locked_at", "<", staleBefore)
      .whereRef("attempt_count", "<", "max_attempts")
      .execute();
  });
}

function parseStaleReviewerPersistenceRecovery(
  job: JobRow,
  failure: string,
): PersistReviewerReplacementInput | null {
  if (job.kind !== "activate_reviewer_absence" || !isRecord(job.payload)) return null;
  const payload = job.payload;
  const raw = payload.reviewerReplacementFinalizerRecovery;
  if (
    !isRecord(raw)
    || raw.kind !== "reviewer_replacement_finalizer"
    || raw.phase !== "persist_replacement"
    || raw.replacementId !== null
    || !isUuid(raw.mutationIntentId)
    || raw.providerEffectsApplied !== true
    || typeof raw.retryable !== "boolean"
    || !isNonBlank(raw.lastError)
    || !isRecord(raw.persistence)
    || !isRecord(raw.job)
    || raw.job.kind !== "activate_reviewer_absence"
    || raw.job.workspaceId !== job.workspace_id
    || raw.job.providerConnectionId !== job.provider_connection_id
    || !isUuid(raw.job.absenceId)
    || !isPositiveInteger(raw.job.absenceRevision)
    || payload.workspaceId !== job.workspace_id
    || payload.providerConnectionId !== job.provider_connection_id
    || payload.absenceId !== raw.job.absenceId
    || payload.absenceRevision !== raw.job.absenceRevision
  ) return null;
  if (raw.outcome === "replaced") {
    if (
      !isNonBlank(raw.replacementActorId)
      || !isRecord(raw.finalizer)
      || raw.finalizer.action !== "reevaluate_policy"
      || !isUuid(raw.finalizer.decisionId)
      || !isNullableString(raw.finalizer.summary)
    ) return null;
  } else if (raw.outcome === "permanent_failure") {
    if (raw.replacementActorId !== null || raw.finalizer !== null) return null;
  } else return null;
  if (
    raw.persistence.outcome !== raw.outcome
    || raw.persistence.replacementActorId !== raw.replacementActorId
    || raw.persistence.mutationIntentId !== raw.mutationIntentId
    || (isRecord(raw.finalizer) && raw.persistence.decisionId !== raw.finalizer.decisionId)
  ) return null;
  try {
    const audit = buildMutationIntentRecoveryAudit(raw.persistence, job.workspace_id, failure);
    if (
      audit.provider !== job.provider
      || audit.providerConnectionId !== job.provider_connection_id
      || audit.absenceId !== raw.job.absenceId
      || audit.absenceRevision !== raw.job.absenceRevision
      || audit.mutationIntentId !== raw.mutationIntentId
    ) return null;
    return audit;
  } catch {
    return null;
  }
}

function parseStaleReviewerFinalizerRecovery(job: JobRow): {
  replacementId: string;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  outcome: "replaced" | "skipped_policy_satisfied" | "no_replacement_available";
  replacementActorId: string | null;
  mutationIntentId: string | null;
} | null {
  if (job.kind !== "activate_reviewer_absence" || !isRecord(job.payload)) return null;
  const payload = job.payload;
  const raw = payload.reviewerReplacementFinalizerRecovery;
  if (
    !isRecord(raw)
    || raw.kind !== "reviewer_replacement_finalizer"
    || (raw.phase !== "run_finalizer" && raw.phase !== "complete_replacement")
    || !isUuid(raw.replacementId)
    || raw.persistence !== null
    || typeof raw.retryable !== "boolean"
    || !isNonBlank(raw.lastError)
    || !isRecord(raw.job)
    || raw.job.kind !== "activate_reviewer_absence"
    || raw.job.workspaceId !== job.workspace_id
    || raw.job.providerConnectionId !== job.provider_connection_id
    || !isUuid(raw.job.absenceId)
    || !isPositiveInteger(raw.job.absenceRevision)
    || payload.workspaceId !== job.workspace_id
    || payload.providerConnectionId !== job.provider_connection_id
    || payload.absenceId !== raw.job.absenceId
    || payload.absenceRevision !== raw.job.absenceRevision
    || !isRecord(raw.finalizer)
    || !isUuid(raw.finalizer.decisionId)
    || !isNullableString(raw.finalizer.summary)
  ) return null;
  if (raw.outcome === "replaced") {
    if (
      !isNonBlank(raw.replacementActorId)
      || !isUuid(raw.mutationIntentId)
      || raw.providerEffectsApplied !== true
      || raw.finalizer.action !== "reevaluate_policy"
    ) return null;
  } else if (raw.outcome === "skipped_policy_satisfied" || raw.outcome === "no_replacement_available") {
    if (
      raw.replacementActorId !== null
      || raw.providerEffectsApplied !== false
      || (raw.mutationIntentId !== null && !isUuid(raw.mutationIntentId))
      || raw.finalizer.action !== (raw.outcome === "no_replacement_available" ? "fail_policy" : "reevaluate_policy")
    ) return null;
  } else return null;
  return {
    replacementId: raw.replacementId,
    absenceId: raw.job.absenceId,
    absenceRevision: raw.job.absenceRevision,
    decisionId: raw.finalizer.decisionId,
    outcome: raw.outcome,
    replacementActorId: raw.replacementActorId,
    mutationIntentId: raw.mutationIntentId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isUuid(value: unknown): value is string {
  return isNonBlank(value)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    providerConnectionId: row.provider_connection_id,
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

export function createJobClaimer(db: Kysely<Database>): JobClaimer {
  return {
    async claimNext(workerId, now) {
      return await db.transaction().execute(async (trx) => {
        const job = await trx
          .selectFrom("jobs")
          .selectAll()
          .where("status", "=", "queued")
          .where("run_at", "<=", now)
          .orderBy("run_at", "asc")
          .orderBy("created_at", "asc")
          .orderBy("id", "asc")
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
          .where("workspace_id", "=", job.workspace_id)
          .returningAll()
          .executeTakeFirstOrThrow();

        return toJobRecord(claimed);
      });
    },
  };
}

export function createWorkspaceJobQueue(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): WorkspaceJobQueue {
  return {
    async enqueue(input) {
      const inserted = await db
        .insertInto("jobs")
        .values({
          workspace_id: workspaceId,
          provider: input.provider,
          provider_connection_id: input.providerConnectionId,
          kind: input.kind,
          payload: input.payload,
          idempotency_key: input.idempotencyKey,
          run_at: input.runAt ?? new Date(),
          max_attempts: input.maxAttempts ?? 5,
        })
        .onConflict((oc) => oc.columns(["workspace_id", "idempotency_key"]).doNothing())
        .returning(["id"])
        .executeTakeFirst();

      if (inserted) return { inserted: true, jobId: inserted.id };

      const existing = await db
        .selectFrom("jobs")
        .select(["id"])
        .where("workspace_id", "=", workspaceId)
        .where("idempotency_key", "=", input.idempotencyKey)
        .executeTakeFirstOrThrow();
      return { inserted: false, jobId: existing.id };
    },

    async markSucceeded(lease, now) {
      if (lease.workspaceId !== workspaceId) return { updated: false, reason: "stale_lease" };
      const updated = await db
        .updateTable("jobs")
        .set({ status: "succeeded", locked_at: null, locked_by: null, updated_at: now })
        .where("id", "=", lease.jobId)
        .where("workspace_id", "=", workspaceId)
        .where("provider", "=", lease.provider)
        .where("provider_connection_id", "=", lease.providerConnectionId)
        .where("status", "=", "running")
        .where("locked_by", "=", lease.lockedBy)
        .where("attempt_count", "=", lease.attemptCount)
        .returning("id")
        .executeTakeFirst();
      return updated ? { updated: true } : { updated: false, reason: "stale_lease" };
    },

    async markFailed(lease, error, now, options) {
      if (lease.workspaceId !== workspaceId) return { updated: false, reason: "stale_lease" };
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
        .where("workspace_id", "=", workspaceId)
        .where("provider", "=", lease.provider)
        .where("provider_connection_id", "=", lease.providerConnectionId)
        .where("status", "=", "running")
        .where("locked_by", "=", lease.lockedBy)
        .where("attempt_count", "=", lease.attemptCount)
        .returning("id")
        .executeTakeFirst();
      return updated ? { updated: true } : { updated: false, reason: "stale_lease" };
    },
  };
}
