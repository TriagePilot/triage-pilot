import type { Kysely } from "kysely";
import type { ProviderConnectionId, ProviderKind, WorkspaceId } from "@triagepilot/contracts";

import type { Database, JobRow } from "./kysely.js";
import {
  persistMutationIntentRecoveryTransaction,
  prepareMutationIntentTransaction,
  type PrepareReviewerMutationIntentInput,
  type ReviewerMutationIntent,
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
  lockedAt: Date;
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
  exhaustReviewerAbsenceActivation(
    lease: JobLease,
    error: string,
    now: Date,
  ): Promise<JobTransitionResult>;
}

export interface JobClaimer {
  claimNext(workerId: string, now: Date): Promise<JobRecord | null>;
}

export function buildNextRunAt(now: Date, attemptCount: number): Date {
  const delaySeconds = Math.min(900, 5 ** Math.max(1, attemptCount));
  return new Date(now.getTime() + delaySeconds * 1000);
}

export async function prepareClaimedReviewerMutationIntent(
  db: Kysely<Database>,
  lease: JobLease,
  input: PrepareReviewerMutationIntentInput,
): Promise<ReviewerMutationIntent> {
  return await db.transaction().execute(async (trx) => {
    const job = await trx.selectFrom("jobs").selectAll()
      .where("id", "=", lease.jobId).where("workspace_id", "=", lease.workspaceId)
      .where("provider", "=", lease.provider).where("provider_connection_id", "=", lease.providerConnectionId)
      .where("status", "=", "running").where("locked_by", "=", lease.lockedBy)
      .where("locked_at", "=", lease.lockedAt).where("attempt_count", "=", lease.attemptCount)
      .forUpdate().executeTakeFirst();
    const scope = job === undefined ? null : parseActivationScope(job);
    if (scope === null || scope.absenceId !== input.absenceId
      || scope.absenceRevision !== input.absenceRevision || input.workspaceId !== lease.workspaceId
      || input.provider !== lease.provider || input.providerConnectionId !== lease.providerConnectionId) {
      throw new Error("reviewer mutation intent prepare rejected stale or invalid activation lease");
    }
    return await prepareMutationIntentTransaction(trx, lease.workspaceId, input);
  });
}

export async function recoverStaleJobs(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: Date,
  staleAfterMs = 15 * 60 * 1000,
): Promise<void> {
  const staleBefore = new Date(now.getTime() - staleAfterMs);
  const exhausted = await db.selectFrom("jobs")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("status", "=", "running")
      .where("locked_at", "<", staleBefore)
      .whereRef("attempt_count", ">=", "max_attempts")
      .orderBy("created_at").orderBy("id")
      .execute();
  const failure = "job lease expired after maximum attempts";
  for (const job of exhausted) {
    if (job.locked_by === null) continue;
    const lease = {
      jobId: job.id,
      workspaceId: job.workspace_id,
      provider: job.provider,
      providerConnectionId: job.provider_connection_id,
      lockedBy: job.locked_by,
      lockedAt: job.locked_at!,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
    };
    try {
      await exhaustReviewerAbsenceActivationTransaction(db, lease, failure, now);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown database failure";
      try {
        await failIsolatedStaleJob(db, lease, `${failure}: recovery transaction failed: ${detail}`, now);
      } catch {
        // Isolation is the invariant: a broken job must not abort recovery of later stale jobs.
      }
    }
  }
  await db.updateTable("jobs")
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
}

async function failIsolatedStaleJob(
  db: Kysely<Database>, lease: JobLease, error: string, now: Date,
): Promise<void> {
  await db.updateTable("jobs").set({
    status: "failed", locked_at: null, locked_by: null, last_error: error, run_at: now, updated_at: now,
  }).where("id", "=", lease.jobId).where("workspace_id", "=", lease.workspaceId)
    .where("provider", "=", lease.provider).where("provider_connection_id", "=", lease.providerConnectionId)
    .where("status", "=", "running").where("locked_by", "=", lease.lockedBy)
    .where("locked_at", "=", lease.lockedAt).where("attempt_count", "=", lease.attemptCount)
    .execute();
}

async function exhaustReviewerAbsenceActivationTransaction(
  db: Kysely<Database>,
  lease: JobLease,
  error: string,
  now: Date,
): Promise<JobTransitionResult> {
  return await db.transaction().execute(async (trx) => {
    const job = await trx.selectFrom("jobs").selectAll()
      .where("id", "=", lease.jobId)
      .where("workspace_id", "=", lease.workspaceId)
      .where("provider", "=", lease.provider)
      .where("provider_connection_id", "=", lease.providerConnectionId)
      .where("status", "=", "running")
      .where("locked_by", "=", lease.lockedBy)
      .where("locked_at", "=", lease.lockedAt)
      .where("attempt_count", "=", lease.attemptCount)
      .forUpdate().executeTakeFirst();
    if (job === undefined) return { updated: false, reason: "stale_lease" };

    const scope = parseActivationScope(job);
    let sourceValid = scope !== null || job.kind !== "activate_reviewer_absence";
    let sourceError: string | null = null;
    if (scope !== null && isRecord(job.payload) && job.payload.reviewerReplacementFinalizerRecovery !== undefined) {
      sourceValid = isValidRecoveryShape(job.payload.reviewerReplacementFinalizerRecovery, job, scope);
      if (!sourceValid) sourceError = "reviewer activation recovery source is invalid";
    }
    if (scope !== null && sourceValid) {
      const absence = await trx.selectFrom("reviewer_absences").select("id")
        .where("workspace_id", "=", job.workspace_id).where("provider", "=", job.provider)
        .where("provider_connection_id", "=", job.provider_connection_id)
        .where("id", "=", scope.absenceId).forUpdate().executeTakeFirst();
      if (absence === undefined) {
        sourceValid = false;
        sourceError = "reviewer activation absence source is invalid";
      }
    }
    if (scope !== null && sourceValid && isRecord(job.payload)
      && job.payload.reviewerReplacementFinalizerRecovery !== undefined) {
      sourceValid = await recoverySourceMatches(trx, job, scope);
      if (!sourceValid) sourceError = "reviewer activation recovery source is invalid";
    }
    if (scope !== null && sourceValid) {
      const intents = await trx.selectFrom("reviewer_mutation_intents").selectAll()
        .where("workspace_id", "=", job.workspace_id)
        .where("provider", "=", job.provider)
        .where("provider_connection_id", "=", job.provider_connection_id)
        .where("absence_id", "=", scope.absenceId)
        .where("absence_revision", "=", scope.absenceRevision)
        .orderBy("decision_id").orderBy("id").execute();
      const unresolved = [] as typeof intents;
      for (const intent of intents) {
        const history = await trx.selectFrom("reviewer_replacements").selectAll()
          .where("workspace_id", "=", job.workspace_id)
          .where("provider", "=", job.provider)
          .where("provider_connection_id", "=", job.provider_connection_id)
          .where("absence_id", "=", scope.absenceId)
          .where("absence_revision", "=", scope.absenceRevision)
          .where("decision_id", "=", intent.decision_id)
          .forUpdate().executeTakeFirst();
        if (history !== undefined) {
          if (history.mutation_intent_id !== intent.id) {
            sourceValid = false;
            sourceError = "reviewer mutation intent history linkage is invalid";
          }
          continue;
        }
        unresolved.push(intent);
      }
      for (const intent of sourceValid ? unresolved : []) {
        await persistMutationIntentRecoveryTransaction(trx, job.workspace_id, {
          provider: intent.provider,
          providerConnectionId: intent.provider_connection_id,
          absenceId: intent.absence_id,
          absenceRevision: intent.absence_revision,
          decisionId: intent.decision_id,
          expectedHeadRevision: intent.expected_head_revision,
          unavailableActorId: intent.unavailable_actor_id,
          replacementActorId: null,
          mutationIntentId: intent.id,
          outcome: "permanent_failure",
          reason: error,
          state: "permanent_failure",
          lastError: error,
          startedAt: now,
          completedAt: now,
          replaceCohort: false,
          event: {
            schemaVersion: 1,
            eventType: "reviewer_replacement",
            eventId: `reviewer-mutation-intent-exhausted:${intent.id}`,
            occurredAt: now.toISOString(),
            workspaceId: job.workspace_id,
            provider: intent.provider,
            providerConnectionId: intent.provider_connection_id,
            absenceId: intent.absence_id,
            absenceRevision: intent.absence_revision,
            decisionId: intent.decision_id,
            repositoryId: intent.repository_id,
            changeRequestId: intent.change_request_id,
            unavailableActor: intent.unavailable_actor_id,
            replacementActor: null,
            outcome: "permanent_failure",
          },
        });
      }
      if (sourceValid) {
        const pending = await trx.selectFrom("reviewer_replacements").select("id")
          .where("workspace_id", "=", job.workspace_id)
          .where("provider", "=", job.provider)
          .where("provider_connection_id", "=", job.provider_connection_id)
          .where("absence_id", "=", scope.absenceId)
          .where("absence_revision", "=", scope.absenceRevision)
          .where("state", "=", "finalizer_pending")
          .orderBy("decision_id").orderBy("id").forUpdate().execute();
        for (const row of pending) {
          await trx.updateTable("reviewer_replacements")
            .set({ state: "permanent_failure", last_error: error })
            .where("id", "=", row.id).where("state", "=", "finalizer_pending").execute();
        }
      }
    }
    const finalError = sourceError === null ? error : `${error}: ${sourceError}`;
    await trx.updateTable("jobs").set({
      status: "failed", run_at: now, locked_at: null, locked_by: null,
      last_error: finalError, updated_at: now,
    }).where("id", "=", job.id).execute();
    return { updated: true };
  });
}

function parseActivationScope(job: JobRow): { absenceId: string; absenceRevision: number } | null {
  if (job.kind !== "activate_reviewer_absence" || !isRecord(job.payload)) return null;
  if (job.payload.kind !== "activate_reviewer_absence"
    || !hasOnlyKeys(job.payload, ["kind", "workspaceId", "providerConnectionId", "absenceId", "absenceRevision",
      "reviewerReplacementFinalizerRecovery"])
    || job.payload.policyCheckFailureRecovery !== undefined
    || job.payload.workspaceId !== job.workspace_id
    || job.payload.providerConnectionId !== job.provider_connection_id
    || !isUuid(job.payload.absenceId)
    || !isPositiveInteger(job.payload.absenceRevision)) return null;
  return { absenceId: job.payload.absenceId, absenceRevision: job.payload.absenceRevision };
}

function isValidRecoveryShape(
  value: unknown,
  job: JobRow,
  scope: { absenceId: string; absenceRevision: number },
): boolean {
  if (!isRecord(value) || !isRecord(value.job)
    || !hasOnlyKeys(value, ["kind", "phase", "job", "provider", "unavailableActorId", "lastError", "retryable",
      "finalizer", "replacementId", "outcome", "replacementActorId", "mutationIntentId",
      "providerEffectsApplied", "persistence"])
    || !hasOnlyKeys(value.job, ["kind", "workspaceId", "providerConnectionId", "absenceId", "absenceRevision"])
    || value.kind !== "reviewer_replacement_finalizer" || value.state !== undefined
    || !["persist_replacement", "run_finalizer", "complete_replacement"].includes(String(value.phase))
    || value.provider !== job.provider || !isNonBlank(value.unavailableActorId)
    || !isNonBlank(value.lastError) || typeof value.retryable !== "boolean"
    || value.job.kind !== "activate_reviewer_absence"
    || value.job.workspaceId !== job.workspace_id
    || value.job.providerConnectionId !== job.provider_connection_id
    || value.job.absenceId !== scope.absenceId || value.job.absenceRevision !== scope.absenceRevision
    || !["replaced", "skipped_policy_satisfied", "no_replacement_available", "permanent_failure"].includes(String(value.outcome))) {
    return false;
  }
  const outcome = value.outcome;
  const expectedEffect = outcome === "replaced" || outcome === "permanent_failure";
  if (value.providerEffectsApplied !== expectedEffect) return false;
  const expectedAction = outcome === "replaced" || outcome === "skipped_policy_satisfied"
    ? "reevaluate_policy" : outcome === "no_replacement_available" ? "fail_policy" : null;
  if (expectedAction === null) {
    if (value.finalizer !== null) return false;
  } else if (!isRecord(value.finalizer) || value.finalizer.action !== expectedAction
    || !hasOnlyKeys(value.finalizer, ["action", "decisionId", "summary"])
    || !isUuid(value.finalizer.decisionId)
    || (expectedAction === "reevaluate_policy" && value.finalizer.summary !== null)
    || (expectedAction === "fail_policy" && !isNonBlank(value.finalizer.summary))) return false;
  if (value.phase === "persist_replacement") {
    if (value.replacementId !== null || !isRecord(value.persistence)) return false;
  } else if (!isUuid(value.replacementId) || (value.persistence !== null && !isRecord(value.persistence))) return false;
  if (outcome === "permanent_failure") {
    if (!isUuid(value.mutationIntentId) || value.replacementActorId !== null || !isRecord(value.persistence)) return false;
    if (value.persistence.state !== "permanent_failure" || value.persistence.outcome !== outcome
      || !isNonBlank(value.persistence.lastError) || value.persistence.mutationIntentId !== value.mutationIntentId) return false;
  } else {
    if (outcome === "replaced" && (!isNonBlank(value.replacementActorId) || !isUuid(value.mutationIntentId))) return false;
    if (outcome !== "replaced" && (value.replacementActorId !== null || value.mutationIntentId !== null)) return false;
    if (isRecord(value.persistence)
      && (value.persistence.outcome !== outcome || value.persistence.state !== "finalizer_pending")) return false;
  }
  if (isRecord(value.persistence)) {
    const persistence = value.persistence;
    if (!hasOnlyKeys(persistence, ["provider", "providerConnectionId", "absenceId", "absenceRevision", "decisionId",
      "expectedHeadRevision", "unavailableActorId", "replacementActorId", "mutationIntentId", "outcome", "reason",
      "state", "lastError", "startedAt", "completedAt", "replaceCohort", "event"])
      || !isRecord(persistence.event) || persistence.provider !== job.provider
      || persistence.providerConnectionId !== job.provider_connection_id
      || persistence.absenceId !== scope.absenceId || persistence.absenceRevision !== scope.absenceRevision
      || persistence.unavailableActorId !== value.unavailableActorId
      || persistence.replacementActorId !== value.replacementActorId
      || persistence.mutationIntentId !== value.mutationIntentId || persistence.outcome !== outcome
      || persistence.event.workspaceId !== job.workspace_id || persistence.event.provider !== job.provider
      || persistence.event.providerConnectionId !== job.provider_connection_id
      || persistence.event.absenceId !== scope.absenceId || persistence.event.absenceRevision !== scope.absenceRevision
      || persistence.event.decisionId !== persistence.decisionId
      || persistence.event.unavailableActor !== value.unavailableActorId
      || persistence.event.replacementActor !== value.replacementActorId
      || persistence.event.outcome !== outcome) return false;
    if (persistence.replaceCohort !== (outcome === "replaced")
      || persistence.event.schemaVersion !== 1 || persistence.event.eventType !== "reviewer_replacement") return false;
    if (isRecord(value.finalizer) && persistence.decisionId !== value.finalizer.decisionId) return false;
  }
  return true;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

async function recoverySourceMatches(
  trx: import("kysely").Transaction<Database>,
  job: JobRow,
  scope: { absenceId: string; absenceRevision: number },
): Promise<boolean> {
  const raw = (job.payload as Record<string, unknown>).reviewerReplacementFinalizerRecovery;
  if (!isRecord(raw) || !isRecord(raw.job)
    || raw.provider !== job.provider
    || !isNonBlank(raw.unavailableActorId)
    || raw.job.workspaceId !== job.workspace_id
    || raw.job.providerConnectionId !== job.provider_connection_id
    || raw.job.absenceId !== scope.absenceId
    || raw.job.absenceRevision !== scope.absenceRevision) return false;
  if (raw.replacementId === null) {
    if (!isUuid(raw.mutationIntentId)) return false;
    const intent = await trx.selectFrom("reviewer_mutation_intents").selectAll()
      .where("id", "=", raw.mutationIntentId)
      .where("workspace_id", "=", job.workspace_id)
      .where("provider", "=", job.provider)
      .where("provider_connection_id", "=", job.provider_connection_id)
      .where("absence_id", "=", scope.absenceId)
      .where("absence_revision", "=", scope.absenceRevision)
      .executeTakeFirst();
    return intent !== undefined && intent.unavailable_actor_id === raw.unavailableActorId;
  }
  if (!isUuid(raw.replacementId) || !isRecord(raw.finalizer) || !isUuid(raw.finalizer.decisionId)) return false;
  const row = await trx.selectFrom("reviewer_replacements").selectAll()
    .where("id", "=", raw.replacementId)
    .where("workspace_id", "=", job.workspace_id)
    .where("provider", "=", job.provider)
    .where("provider_connection_id", "=", job.provider_connection_id)
    .where("absence_id", "=", scope.absenceId)
    .where("absence_revision", "=", scope.absenceRevision)
    .where("decision_id", "=", raw.finalizer.decisionId)
    .executeTakeFirst();
  return row !== undefined
    && row.unavailable_actor_id === raw.unavailableActorId
    && row.outcome === raw.outcome
    && row.replacement_actor_id === raw.replacementActorId
    && row.mutation_intent_id === raw.mutationIntentId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
        .where("locked_at", "=", lease.lockedAt)
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
        .where("locked_at", "=", lease.lockedAt)
        .where("attempt_count", "=", lease.attemptCount)
        .returning("id")
        .executeTakeFirst();
      return updated ? { updated: true } : { updated: false, reason: "stale_lease" };
    },

    async exhaustReviewerAbsenceActivation(lease, error, now) {
      if (lease.workspaceId !== workspaceId) return { updated: false, reason: "stale_lease" };
      return await exhaustReviewerAbsenceActivationTransaction(db, lease, error, now);
    },
  };
}
