import { isDeepStrictEqual } from "node:util";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import {
  buildReviewerAbsenceActivationKey,
  type ProviderConnectionId,
  type ProviderKind,
  type ReviewerAbsenceActivationJobPayload,
  type ReviewerReplacementEventV1,
  type ReviewerReplacementOutcome,
  type WorkspaceId,
} from "@triagepilot/contracts";

import {
  findReviewerReplacementCandidates,
  parseExternalActorId,
  parseOriginalReviewerPool,
  parseStrictActorList,
  type ReviewerReplacementCandidateDecision,
} from "./decisions.js";
import type {
  Database,
  ReviewerAbsencesTable,
  ReviewerReplacementsTable,
} from "./kysely.js";
import { stagePlatformEvent } from "./outbox.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export type ReviewerReplacementState = "finalizer_pending" | "completed" | "permanent_failure";

export interface WorkspaceOperationalSettings {
  workspaceId: WorkspaceId;
  timezone: string;
  updatedAt: Date;
}

export interface ReviewerAbsence {
  id: string;
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  externalActorId: string;
  startAt: Date;
  endAt: Date;
  status: "scheduled" | "cancelled";
  revision: number;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewerAbsenceWindow {
  externalActorId: string;
  startAt: Date;
  endAt: Date;
}

export interface ReviewerReplacement {
  id: string;
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  unavailableActorId: string;
  replacementActorId: string | null;
  outcome: ReviewerReplacementOutcome;
  reason: string;
  state: ReviewerReplacementState;
  lastError: string | null;
  startedAt: Date;
  completedAt: Date;
}

export interface ReviewerAbsenceActivation {
  absenceId: string;
  revision: number;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  externalActorId: string;
  startAt: Date;
  endAt: Date;
  candidates: ReviewerReplacementCandidateDecision[];
}

export interface ScheduleAbsenceInput {
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  externalActorId: string;
  startAt: Date;
  endAt: Date;
  now: Date;
}

export interface ReviseAbsenceInput extends ScheduleAbsenceInput {
  absenceId: string;
  expectedRevision: number;
}

export interface CancelAbsenceInput {
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  absenceId: string;
  expectedRevision: number;
  now: Date;
}

export interface PersistReviewerReplacementInput {
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  expectedHeadRevision: string;
  unavailableActorId: string;
  replacementActorId: string | null;
  outcome: ReviewerReplacementOutcome;
  reason: string;
  state: ReviewerReplacementState;
  lastError: string | null;
  startedAt: Date;
  completedAt: Date;
  replaceCohort: boolean;
  event: ReviewerReplacementEventV1;
}

export interface PersistReviewerReplacementResult {
  inserted: boolean;
  activationCurrent: boolean;
  replacement: ReviewerReplacement | null;
}

export interface WorkspaceReviewerAvailability {
  readSettings(): Promise<WorkspaceOperationalSettings>;
  updateTimezone(timezone: string, now: Date): Promise<WorkspaceOperationalSettings>;
  listAbsences(): Promise<ReviewerAbsence[]>;
  scheduleAbsence(input: ScheduleAbsenceInput): Promise<ReviewerAbsence>;
  reviseAbsence(input: ReviseAbsenceInput): Promise<ReviewerAbsence>;
  cancelAbsence(input: CancelAbsenceInput): Promise<ReviewerAbsence>;
  findActiveAbsences(input: {
    providerConnectionId: ProviderConnectionId;
    actors: string[];
    at: Date;
  }): Promise<ReviewerAbsenceWindow[]>;
  loadActivation(absenceId: string, revision: number): Promise<ReviewerAbsenceActivation | null>;
  listPendingFinalizers(input: { absenceId: string; absenceRevision: number }): Promise<ReviewerReplacement[]>;
  listReplacementHistory(absenceId?: string): Promise<ReviewerReplacement[]>;
  persistReplacement(input: PersistReviewerReplacementInput): Promise<PersistReviewerReplacementResult>;
  updateReplacementState(input: {
    replacementId: string;
    expectedState: ReviewerReplacementState;
    state: ReviewerReplacementState;
    lastError: string | null;
  }): Promise<ReviewerReplacement | null>;
}

export class ReviewerAvailabilityValidationError extends Error {}
export class ReviewerAbsenceConflictError extends Error {}
export class ReviewerAbsenceRevisionError extends Error {}
export class ProviderConnectionUnavailableError extends Error {}

export function createWorkspaceReviewerAvailability(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): WorkspaceReviewerAvailability {
  return {
    async readSettings() {
      const row = await ensureWorkspaceSettings(db, workspaceId);
      return toSettings(row);
    },

    async updateTimezone(timezone, now) {
      validateTimezone(timezone);
      validateDate(now, "now");
      const row = await db
        .insertInto("workspace_operational_settings")
        .values({ workspace_id: workspaceId, timezone, updated_at: now })
        .onConflict((conflict) => conflict.column("workspace_id").doUpdateSet({ timezone, updated_at: now }))
        .returningAll()
        .executeTakeFirstOrThrow();
      return toSettings(row);
    },

    async listAbsences() {
      const rows = await db
        .selectFrom("reviewer_absences")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("start_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(toAbsence);
    },

    async scheduleAbsence(input) {
      const mutation = validateAbsenceMutation(input);
      try {
        return await db.transaction().execute(async (trx) => {
          await requireActiveConnection(trx, workspaceId, input.providerConnectionId, input.provider);
          await lockActorScopes(trx, workspaceId, input.provider, input.providerConnectionId, [mutation.externalActorId]);
          const absence = await trx
            .insertInto("reviewer_absences")
            .values({
              workspace_id: workspaceId,
              provider: input.provider,
              provider_connection_id: input.providerConnectionId,
              external_actor_id: mutation.externalActorId,
              start_at: mutation.startAt,
              end_at: mutation.endAt,
              updated_at: mutation.now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await enqueueActivation(trx, workspaceId, absence, mutation.startAt, mutation.now);
          return toAbsence(absence);
        });
      } catch (error) {
        throw translateAbsenceConflict(error);
      }
    },

    async reviseAbsence(input) {
      const mutation = validateAbsenceMutation(input);
      validateExpectedRevision(input.expectedRevision);
      try {
        return await db.transaction().execute(async (trx) => {
          await requireActiveConnection(trx, workspaceId, input.providerConnectionId, input.provider);
          const current = await lockCurrentAbsence(trx, workspaceId, input);
          await lockActorScopes(
            trx,
            workspaceId,
            input.provider,
            input.providerConnectionId,
            [current.external_actor_id, mutation.externalActorId],
          );
          const revision = current.revision + 1;
          const absence = await trx
            .updateTable("reviewer_absences")
            .set({
              external_actor_id: mutation.externalActorId,
              start_at: mutation.startAt,
              end_at: mutation.endAt,
              revision,
              updated_at: mutation.now,
            })
            .where("workspace_id", "=", workspaceId)
            .where("provider", "=", input.provider)
            .where("provider_connection_id", "=", input.providerConnectionId)
            .where("id", "=", input.absenceId)
            .returningAll()
            .executeTakeFirstOrThrow();
          await enqueueActivation(trx, workspaceId, absence, mutation.startAt, mutation.now);
          return toAbsence(absence);
        });
      } catch (error) {
        throw translateAbsenceConflict(error);
      }
    },

    async cancelAbsence(input) {
      validateDate(input.now, "now");
      validateExpectedRevision(input.expectedRevision);
      return await db.transaction().execute(async (trx) => {
        await requireActiveConnection(trx, workspaceId, input.providerConnectionId, input.provider);
        const current = await lockCurrentAbsence(trx, workspaceId, input);
        await lockActorScopes(
          trx,
          workspaceId,
          input.provider,
          input.providerConnectionId,
          [current.external_actor_id],
        );
        const revision = current.revision + 1;
        const absence = await trx
          .updateTable("reviewer_absences")
          .set({
            status: "cancelled",
            cancelled_at: input.now,
            revision,
            updated_at: input.now,
          })
          .where("workspace_id", "=", workspaceId)
          .where("provider", "=", input.provider)
          .where("provider_connection_id", "=", input.providerConnectionId)
          .where("id", "=", input.absenceId)
          .returningAll()
          .executeTakeFirstOrThrow();
        await enqueueActivation(trx, workspaceId, absence, input.now, input.now);
        return toAbsence(absence);
      });
    },

    async findActiveAbsences(input) {
      validateDate(input.at, "at");
      const actors = validActorList(input.actors);
      if (actors.length === 0) return [];
      const connection = await findActiveConnection(db, workspaceId, input.providerConnectionId);
      if (connection === null) return [];
      const rows = await db
        .selectFrom("reviewer_absences")
        .select(["external_actor_id", "start_at", "end_at"])
        .where("workspace_id", "=", workspaceId)
        .where("provider", "=", connection.provider)
        .where("provider_connection_id", "=", input.providerConnectionId)
        .where("external_actor_id", "in", actors)
        .where("status", "=", "scheduled")
        .where("start_at", "<=", input.at)
        .where("end_at", ">", input.at)
        .orderBy("start_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map((row) => ({
        externalActorId: row.external_actor_id,
        startAt: row.start_at,
        endAt: row.end_at,
      }));
    },

    async loadActivation(absenceId, revision) {
      validateExpectedRevision(revision);
      const absence = await db
        .selectFrom("reviewer_absences")
        .innerJoin("provider_connections", (join) => join
          .onRef("provider_connections.workspace_id", "=", "reviewer_absences.workspace_id")
          .onRef("provider_connections.provider", "=", "reviewer_absences.provider")
          .onRef("provider_connections.id", "=", "reviewer_absences.provider_connection_id"))
        .select([
          "reviewer_absences.id",
          "reviewer_absences.revision",
          "reviewer_absences.provider",
          "reviewer_absences.provider_connection_id",
          "reviewer_absences.external_actor_id",
          "reviewer_absences.start_at",
          "reviewer_absences.end_at",
          "reviewer_absences.status",
        ])
        .where("reviewer_absences.workspace_id", "=", workspaceId)
        .where("reviewer_absences.id", "=", absenceId)
        .where("reviewer_absences.revision", "=", revision)
        .where("reviewer_absences.status", "=", "scheduled")
        .where("provider_connections.status", "=", "active")
        .executeTakeFirst();
      if (absence === undefined) return null;

      const candidates = await findReviewerReplacementCandidates(db, workspaceId, {
        provider: absence.provider,
        providerConnectionId: absence.provider_connection_id,
        unavailableActorId: absence.external_actor_id,
        recordedFor: { absenceId, absenceRevision: absence.revision },
      });
      return {
        absenceId: absence.id,
        revision: absence.revision,
        provider: absence.provider,
        providerConnectionId: absence.provider_connection_id,
        externalActorId: absence.external_actor_id,
        startAt: absence.start_at,
        endAt: absence.end_at,
        candidates,
      };
    },

    async listPendingFinalizers(input) {
      validateExpectedRevision(input.absenceRevision);
      return await listReplacementHistory(
        db,
        workspaceId,
        input.absenceId,
        input.absenceRevision,
        "finalizer_pending",
      );
    },

    async listReplacementHistory(absenceId) {
      return await listReplacementHistory(db, workspaceId, absenceId);
    },

    async persistReplacement(input) {
      validateReplacementInput(input, workspaceId);
      return await db.transaction().execute(async (trx) => {
        const absence = await trx
          .selectFrom("reviewer_absences")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("provider", "=", input.provider)
          .where("provider_connection_id", "=", input.providerConnectionId)
          .where("id", "=", input.absenceId)
          .forUpdate()
          .executeTakeFirst();
        if (absence === undefined) return staleReplacementResult();

        const existing = await trx
          .selectFrom("reviewer_replacements")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("provider", "=", input.provider)
          .where("provider_connection_id", "=", input.providerConnectionId)
          .where("absence_id", "=", input.absenceId)
          .where("absence_revision", "=", input.absenceRevision)
          .where("decision_id", "=", input.decisionId)
          .forUpdate()
          .executeTakeFirst();
        if (existing !== undefined) {
          assertReplacementRetryMatches(existing, input);
          const hasPersistedEvent = await assertReplacementEventRetryMatches(
            trx,
            workspaceId,
            existing.id,
            input.event,
          );
          if (hasPersistedEvent) {
            await stagePlatformEvent(trx, workspaceId, existing.id, input.event);
          }
          return { inserted: false, activationCurrent: true, replacement: toReplacement(existing) };
        }

        await requireActiveConnection(trx, workspaceId, input.providerConnectionId, input.provider);
        if (
          absence.revision !== input.absenceRevision
          || absence.external_actor_id !== input.unavailableActorId
          || absence.status !== "scheduled"
          || absence.start_at > input.completedAt
          || absence.end_at <= input.completedAt
        ) return staleReplacementResult();

        const decision = await trx
          .selectFrom("routing_decisions")
          .innerJoin("repositories", (join) => join
            .onRef("repositories.workspace_id", "=", "routing_decisions.workspace_id")
            .onRef("repositories.id", "=", "routing_decisions.repository_id"))
          .select([
            "routing_decisions.id",
            "routing_decisions.change_request_id",
            "routing_decisions.head_sha",
            "routing_decisions.selected_reviewers",
            "routing_decisions.details",
            "routing_decisions.policy_check_state",
            "repositories.provider",
            "repositories.provider_connection_id",
            "repositories.external_repository_id",
          ])
          .where("routing_decisions.workspace_id", "=", workspaceId)
          .where("routing_decisions.id", "=", input.decisionId)
          .where("repositories.provider", "=", input.provider)
          .where("repositories.provider_connection_id", "=", input.providerConnectionId)
          .forUpdate("routing_decisions")
          .executeTakeFirst();
        if (decision === undefined || decision.head_sha !== input.expectedHeadRevision) {
          return staleReplacementResult();
        }

        const selectedActors = parseStrictActorList(decision.selected_reviewers);
        const original = parseOriginalReviewerPool(decision.details);
        if (
          selectedActors === null
          || original === null
          || !selectedActors.includes(input.unavailableActorId)
          || decision.external_repository_id !== input.event.repositoryId
          || decision.change_request_id !== input.event.changeRequestId
        ) return staleReplacementResult();

        if (replacesCohort(input.outcome)) {
          if (
            !input.replaceCohort
            || input.replacementActorId === null
            || !original.eligibleActors.includes(input.replacementActorId)
            || selectedActors.includes(input.replacementActorId)
            || decision.policy_check_state === "success"
            || decision.policy_check_state === "failure"
          ) return staleReplacementResult();
          await lockActorScopes(
            trx,
            workspaceId,
            input.provider,
            input.providerConnectionId,
            [input.replacementActorId],
          );
          const replacementAbsence = await trx
            .selectFrom("reviewer_absences")
            .select("id")
            .where("workspace_id", "=", workspaceId)
            .where("provider", "=", input.provider)
            .where("provider_connection_id", "=", input.providerConnectionId)
            .where("external_actor_id", "=", input.replacementActorId)
            .where("status", "=", "scheduled")
            .where("start_at", "<=", input.completedAt)
            .where("end_at", ">", input.completedAt)
            .forUpdate()
            .executeTakeFirst();
          if (replacementAbsence !== undefined) return staleReplacementResult();
        } else if (input.replaceCohort || input.replacementActorId !== null) {
          return staleReplacementResult();
        }

        const inserted = await trx
          .insertInto("reviewer_replacements")
          .values({
            workspace_id: workspaceId,
            provider: input.provider,
            provider_connection_id: input.providerConnectionId,
            absence_id: input.absenceId,
            absence_revision: input.absenceRevision,
            decision_id: input.decisionId,
            unavailable_actor_id: input.unavailableActorId,
            replacement_actor_id: input.replacementActorId,
            outcome: input.outcome,
            reason: input.reason,
            state: input.state,
            last_error: input.lastError,
            started_at: input.startedAt,
            completed_at: input.completedAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        if (replacesCohort(input.outcome) && input.replacementActorId !== null) {
          const nextActors = selectedActors.map((actor) =>
            actor === input.unavailableActorId ? input.replacementActorId! : actor,
          );
          await trx
            .updateTable("routing_decisions")
            .set({
              selected_reviewers: JSON.stringify(nextActors),
              selected_reviewer: nextActors[0] ?? null,
            })
            .where("workspace_id", "=", workspaceId)
            .where("id", "=", input.decisionId)
            .execute();
        }
        await stagePlatformEvent(trx, workspaceId, inserted.id, input.event);
        return { inserted: true, activationCurrent: true, replacement: toReplacement(inserted) };
      });
    },

    async updateReplacementState(input) {
      validateReplacementState(input.state);
      validateReplacementState(input.expectedState);
      validateStateError(input.state, input.lastError);
      return await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom("reviewer_replacements")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", input.replacementId)
          .forUpdate()
          .executeTakeFirst();
        if (current === undefined) return null;
        if (current.state === input.state && current.last_error === input.lastError) {
          return toReplacement(current);
        }
        if (current.state !== input.expectedState || current.state !== "finalizer_pending") return null;
        const updated = await trx
          .updateTable("reviewer_replacements")
          .set({ state: input.state, last_error: input.lastError })
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", input.replacementId)
          .returningAll()
          .executeTakeFirstOrThrow();
        return toReplacement(updated);
      });
    },
  };
}

async function ensureWorkspaceSettings(db: Kysely<Database>, workspaceId: WorkspaceId) {
  return await db
    .insertInto("workspace_operational_settings")
    .values({ workspace_id: workspaceId, timezone: "UTC" })
    .onConflict((conflict) => conflict.column("workspace_id").doUpdateSet({
      workspace_id: workspaceId,
    }))
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function findActiveConnection(
  db: DatabaseExecutor,
  workspaceId: WorkspaceId,
  providerConnectionId: ProviderConnectionId,
  provider?: ProviderKind,
) {
  let query = db
    .selectFrom("provider_connections")
    .select(["id", "provider"])
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", providerConnectionId)
    .where("status", "=", "active");
  if (provider !== undefined) query = query.where("provider", "=", provider);
  return await query.executeTakeFirst() ?? null;
}

async function requireActiveConnection(
  db: DatabaseExecutor,
  workspaceId: WorkspaceId,
  providerConnectionId: ProviderConnectionId,
  provider: ProviderKind,
) {
  const connection = await findActiveConnection(db, workspaceId, providerConnectionId, provider);
  if (connection === null) {
    throw new ProviderConnectionUnavailableError("Provider connection is not active in this workspace");
  }
  return connection;
}

async function lockCurrentAbsence(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
  input: { provider: ProviderKind; providerConnectionId: ProviderConnectionId; absenceId: string; expectedRevision: number },
) {
  const absence = await trx
    .selectFrom("reviewer_absences")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("provider", "=", input.provider)
    .where("provider_connection_id", "=", input.providerConnectionId)
    .where("id", "=", input.absenceId)
    .forUpdate()
    .executeTakeFirst();
  if (absence === undefined || absence.revision !== input.expectedRevision || absence.status !== "scheduled") {
    throw new ReviewerAbsenceRevisionError("Reviewer absence revision is stale");
  }
  return absence;
}

async function lockActorScopes(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
  provider: ProviderKind,
  providerConnectionId: ProviderConnectionId,
  actors: string[],
): Promise<void> {
  for (const actor of [...new Set(actors)].sort()) {
    const scope = `${workspaceId}:${provider}:${providerConnectionId}:${actor}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${scope}, 182736154))`.execute(trx);
  }
}

async function enqueueActivation(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
  absence: Selectable<ReviewerAbsencesTable>,
  requestedRunAt: Date,
  now: Date,
): Promise<void> {
  const payload: ReviewerAbsenceActivationJobPayload = {
    kind: "activate_reviewer_absence",
    workspaceId,
    providerConnectionId: absence.provider_connection_id,
    absenceId: absence.id,
    absenceRevision: absence.revision,
  };
  const runAt = requestedRunAt > now ? requestedRunAt : now;
  const idempotencyKey = buildReviewerAbsenceActivationKey(absence.id, absence.revision);
  const inserted = await trx
    .insertInto("jobs")
    .values({
      workspace_id: workspaceId,
      provider: absence.provider,
      provider_connection_id: absence.provider_connection_id,
      kind: payload.kind,
      payload,
      idempotency_key: idempotencyKey,
      run_at: runAt,
    })
    .onConflict((conflict) => conflict.columns(["workspace_id", "idempotency_key"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted !== undefined) return;

  const existing = await trx
    .selectFrom("jobs")
    .select(["provider", "provider_connection_id", "kind", "payload", "run_at"])
    .where("workspace_id", "=", workspaceId)
    .where("idempotency_key", "=", idempotencyKey)
    .forUpdate()
    .executeTakeFirst();
  if (
    existing === undefined
    || existing.provider !== absence.provider
    || existing.provider_connection_id !== absence.provider_connection_id
    || existing.kind !== payload.kind
    || existing.run_at.getTime() !== runAt.getTime()
    || !isDeepStrictEqual(existing.payload, payload)
  ) throw new Error("reviewer absence activation key conflicts with a different job");
}

async function listReplacementHistory(
  db: DatabaseExecutor,
  workspaceId: WorkspaceId,
  absenceId?: string,
  absenceRevision?: number,
  state?: ReviewerReplacementState,
): Promise<ReviewerReplacement[]> {
  let query = db
    .selectFrom("reviewer_replacements")
    .selectAll()
    .where("workspace_id", "=", workspaceId);
  if (absenceId !== undefined) query = query.where("absence_id", "=", absenceId);
  if (absenceRevision !== undefined) query = query.where("absence_revision", "=", absenceRevision);
  if (state !== undefined) query = query.where("state", "=", state);
  const rows = await query
    .orderBy("completed_at", "desc")
    .orderBy("id", "desc")
    .execute();
  return rows.map(toReplacement);
}

function validateAbsenceMutation<T extends {
  externalActorId: string;
  startAt: Date;
  endAt: Date;
  now: Date;
}>(input: T): T & { externalActorId: string } {
  const externalActorId = parseExternalActorId(input.externalActorId);
  if (externalActorId === null) {
    throw new ReviewerAvailabilityValidationError("External actor identifier must not be empty");
  }
  validateDate(input.startAt, "startAt");
  validateDate(input.endAt, "endAt");
  validateDate(input.now, "now");
  if (input.endAt <= input.startAt) {
    throw new ReviewerAvailabilityValidationError("Absence end must be after its start");
  }
  return { ...input, externalActorId };
}

function validateReplacementInput(input: PersistReviewerReplacementInput, workspaceId: WorkspaceId): void {
  validateDate(input.startedAt, "startedAt");
  validateDate(input.completedAt, "completedAt");
  validateExpectedRevision(input.absenceRevision);
  validateReplacementState(input.state);
  validateStateError(input.state, input.lastError);
  if (input.completedAt < input.startedAt) {
    throw new ReviewerAvailabilityValidationError("Replacement completion cannot precede its start");
  }
  const unavailableActorId = parseExternalActorId(input.unavailableActorId);
  const replacementActorId = input.replacementActorId === null
    ? null
    : parseExternalActorId(input.replacementActorId);
  if (
    unavailableActorId === null
    || unavailableActorId !== input.unavailableActorId
    || replacementActorId !== input.replacementActorId
  ) throw new ReviewerAvailabilityValidationError("Replacement actor identifiers must not be empty");
  if (
    input.event.workspaceId !== workspaceId
    || input.event.provider !== input.provider
    || input.event.providerConnectionId !== input.providerConnectionId
    || input.event.absenceId !== input.absenceId
    || input.event.absenceRevision !== input.absenceRevision
    || input.event.decisionId !== input.decisionId
    || input.event.unavailableActor !== input.unavailableActorId
    || input.event.replacementActor !== input.replacementActorId
    || input.event.outcome !== input.outcome
    || new Date(input.event.occurredAt).getTime() !== input.completedAt.getTime()
  ) {
    throw new ReviewerAvailabilityValidationError("Replacement event does not match replacement input");
  }
}

function validateTimezone(timezone: string): void {
  const supported = timezone === "UTC"
    || (typeof Intl.supportedValuesOf === "function" && Intl.supportedValuesOf("timeZone").includes(timezone));
  if (!supported) {
    throw new ReviewerAvailabilityValidationError("Timezone must be UTC or a canonical IANA timezone identifier");
  }
}

function validateDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ReviewerAvailabilityValidationError(`${field} must be a finite date`);
  }
}

function validateExpectedRevision(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ReviewerAvailabilityValidationError("Revision must be a positive integer");
  }
}

function validateReplacementState(value: string): asserts value is ReviewerReplacementState {
  if (value !== "finalizer_pending" && value !== "completed" && value !== "permanent_failure") {
    throw new ReviewerAvailabilityValidationError("Unknown reviewer replacement state");
  }
}

function validateStateError(state: ReviewerReplacementState, lastError: string | null): void {
  if (state === "completed" && lastError !== null) {
    throw new ReviewerAvailabilityValidationError("Completed replacements cannot retain a finalizer error");
  }
  if (state === "permanent_failure" && (lastError === null || lastError.trim() === "")) {
    throw new ReviewerAvailabilityValidationError("Permanent finalizer failure requires an error");
  }
}

function validActorList(actors: string[]): string[] {
  return [...new Set(actors.map(parseExternalActorId).filter((actor): actor is string => actor !== null))];
}

function replacesCohort(outcome: ReviewerReplacementOutcome): boolean {
  return outcome === "replaced" || outcome === "simulated_replacement";
}

function staleReplacementResult(): PersistReviewerReplacementResult {
  return { inserted: false, activationCurrent: false, replacement: null };
}

function assertReplacementRetryMatches(
  existing: Selectable<ReviewerReplacementsTable>,
  input: PersistReviewerReplacementInput,
): void {
  if (
    existing.unavailable_actor_id !== input.unavailableActorId
    || existing.replacement_actor_id !== input.replacementActorId
    || existing.outcome !== input.outcome
    || existing.reason !== input.reason
    || existing.started_at.getTime() !== input.startedAt.getTime()
    || existing.completed_at.getTime() !== input.completedAt.getTime()
  ) throw new Error("reviewer replacement retry conflicts with persisted history");
}

async function assertReplacementEventRetryMatches(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
  replacementId: string,
  event: ReviewerReplacementEventV1,
): Promise<boolean> {
  const existing = await trx
    .selectFrom("decision_outbox")
    .select(["event_id", "event_type", "schema_version", "payload", "occurred_at"])
    .where("workspace_id", "=", workspaceId)
    .where("reviewer_replacement_id", "=", replacementId)
    .forUpdate()
    .limit(2)
    .execute();
  if (existing.length === 0) return false;
  if (
    existing.length !== 1
    || existing[0]!.event_id !== event.eventId
    || existing[0]!.event_type !== event.eventType
    || existing[0]!.schema_version !== event.schemaVersion
    || existing[0]!.occurred_at.getTime() !== new Date(event.occurredAt).getTime()
    || !isDeepStrictEqual(existing[0]!.payload, event)
  ) throw new Error("reviewer replacement retry conflicts with persisted platform event");
  return true;
}

function translateAbsenceConflict(error: unknown): Error {
  if (
    typeof error === "object"
    && error !== null
    && "constraint" in error
    && error.constraint === "reviewer_absences_no_overlap"
  ) return new ReviewerAbsenceConflictError("Reviewer absence overlaps an existing scheduled interval");
  return error instanceof Error ? error : new Error("Unable to persist reviewer absence");
}

function toSettings(row: { workspace_id: string; timezone: string; updated_at: Date }): WorkspaceOperationalSettings {
  return { workspaceId: row.workspace_id, timezone: row.timezone, updatedAt: row.updated_at };
}

function toAbsence(row: Selectable<ReviewerAbsencesTable>): ReviewerAbsence {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    providerConnectionId: row.provider_connection_id,
    externalActorId: row.external_actor_id,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    revision: row.revision,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toReplacement(row: Selectable<ReviewerReplacementsTable>): ReviewerReplacement {
  validateReplacementState(row.state);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    providerConnectionId: row.provider_connection_id,
    absenceId: row.absence_id,
    absenceRevision: row.absence_revision,
    decisionId: row.decision_id,
    unavailableActorId: row.unavailable_actor_id,
    replacementActorId: row.replacement_actor_id,
    outcome: row.outcome,
    reason: row.reason,
    state: row.state,
    lastError: row.last_error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
