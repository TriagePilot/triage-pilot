import { sql, type Kysely } from "kysely";
import type { ReviewerAbsenceActivationJobPayload } from "@triagepilot/shared";

import { createJobQueue } from "./jobs";
import {
  findReviewerReplacementCandidates,
  replaceDecisionReviewerCohort,
  type ReviewerReplacementCandidate,
} from "./decisions";
import type { Database } from "./kysely";

export type ReviewerAbsenceStatus = "upcoming" | "active" | "ended" | "cancelled";
export type ReviewerReplacementOutcome =
  | "replaced"
  | "simulated_replacement"
  | "no_replacement_available"
  | "skipped_approved"
  | "skipped_closed"
  | "skipped_changed_head"
  | "skipped_policy_satisfied"
  | "permanent_failure";

export interface ReviewerReplacementView {
  id: string;
  repository: string;
  pullNumber: number;
  unavailableReviewer: string;
  replacementReviewer: string | null;
  outcome: ReviewerReplacementOutcome;
  reason: string;
  completedAt: string;
}

export interface ReviewerAbsenceView {
  id: string;
  reviewerHandle: string;
  startAt: string;
  endAt: string;
  status: ReviewerAbsenceStatus;
  revision: number;
  replacements: ReviewerReplacementView[];
}

export interface AvailabilityOverview {
  timezone: string;
  absences: ReviewerAbsenceView[];
}

export interface ReviewerAbsenceWindow {
  reviewerHandle: string;
  startAt: Date;
  endAt: Date;
}

export interface ReviewerAbsenceActivation {
  absenceId: string;
  revision: number;
  reviewerHandle: string;
  startAt: Date;
  endAt: Date;
  candidates: ReviewerReplacementCandidate[];
}

export interface RecordReviewerReplacementInput {
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  unavailableReviewer: string;
  replacementReviewer: string | null;
  outcome: ReviewerReplacementOutcome;
  reason: string;
  startedAt: Date;
  completedAt: Date;
  replaceCohort: boolean;
}

export interface ReviewerAbsenceMutation {
  reviewerHandle: string;
  startAt: Date;
  endAt: Date;
  now: Date;
}

export class ReviewerAbsenceValidationError extends Error {}
export class ReviewerAbsenceConflictError extends Error {}
export class ReviewerAbsenceNotFoundError extends Error {}
export class ReviewerAbsenceRevisionError extends Error {}

export function normalizeReviewerHandle(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const normalized = `@${trimmed.replace(/^@/, "")}`;
  return /^@[a-z0-9_.-]+$/.test(normalized) ? normalized : null;
}

export async function createReviewerAbsence(
  db: Kysely<Database>,
  input: ReviewerAbsenceMutation,
): Promise<ReviewerAbsenceView> {
  const mutation = validateMutation(input);

  try {
    return await db.transaction().execute(async (trx) => {
      const absence = await trx
        .insertInto("reviewer_absences")
        .values({
          reviewer_handle: mutation.reviewerHandle,
          start_at: mutation.startAt,
          end_at: mutation.endAt,
          updated_at: mutation.now,
        })
        .returning(["id", "reviewer_handle", "start_at", "end_at", "status", "revision"])
        .executeTakeFirstOrThrow();
      await enqueueActivation(trx, absence.id, absence.revision, mutation.startAt, mutation.now);
      return toAbsenceView(absence, mutation.now);
    });
  } catch (error) {
    throw translateConflict(error);
  }
}

export async function updateReviewerAbsence(
  db: Kysely<Database>,
  input: ReviewerAbsenceMutation & { absenceId: string; expectedRevision: number },
): Promise<ReviewerAbsenceView> {
  const mutation = validateMutation(input);
  validateExpectedRevision(input.expectedRevision);

  try {
    return await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("reviewer_absences")
        .select(["id", "revision", "status"])
        .where("id", "=", input.absenceId)
        .forUpdate()
        .executeTakeFirst();
      assertCurrentAbsence(current, input.expectedRevision);

      const revision = current.revision + 1;
      const absence = await trx
        .updateTable("reviewer_absences")
        .set({
          reviewer_handle: mutation.reviewerHandle,
          start_at: mutation.startAt,
          end_at: mutation.endAt,
          revision,
          updated_at: mutation.now,
        })
        .where("id", "=", input.absenceId)
        .returning(["id", "reviewer_handle", "start_at", "end_at", "status", "revision"])
        .executeTakeFirstOrThrow();
      await enqueueActivation(trx, absence.id, revision, mutation.startAt, mutation.now);
      return toAbsenceView(absence, mutation.now);
    });
  } catch (error) {
    throw translateConflict(error);
  }
}

export async function cancelReviewerAbsence(
  db: Kysely<Database>,
  input: { absenceId: string; expectedRevision: number; now: Date },
): Promise<ReviewerAbsenceView> {
  validateDate(input.now, "now");
  validateExpectedRevision(input.expectedRevision);

  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("reviewer_absences")
      .select(["id", "revision", "status"])
      .where("id", "=", input.absenceId)
      .forUpdate()
      .executeTakeFirst();
    assertCurrentAbsence(current, input.expectedRevision);

    const revision = current.revision + 1;
    const absence = await trx
      .updateTable("reviewer_absences")
      .set({
        status: "cancelled",
        cancelled_at: input.now,
        revision,
        updated_at: input.now,
      })
      .where("id", "=", input.absenceId)
      .returning(["id", "reviewer_handle", "start_at", "end_at", "status", "revision"])
      .executeTakeFirstOrThrow();
    await enqueueActivation(trx, absence.id, revision, input.now, input.now);
    return toAbsenceView(absence, input.now);
  });
}

export async function updateOrganizationTimezone(
  db: Kysely<Database>,
  input: { timezone: string; now: Date },
): Promise<void> {
  validateDate(input.now, "now");
  await db
    .insertInto("organization_settings")
    .values({ id: true, timezone: input.timezone, updated_at: input.now })
    .onConflict((oc) => oc.column("id").doUpdateSet({ timezone: input.timezone, updated_at: input.now }))
    .execute();
}

export async function readAvailabilityOverview(
  db: Kysely<Database>,
  input: { now: Date },
): Promise<AvailabilityOverview> {
  validateDate(input.now, "now");
  const [settings, rows] = await Promise.all([
    db.selectFrom("organization_settings").select("timezone").where("id", "=", true).executeTakeFirst(),
    db
      .selectFrom("reviewer_absences")
      .leftJoin("reviewer_replacements", "reviewer_replacements.absence_id", "reviewer_absences.id")
      .leftJoin("routing_decisions", "routing_decisions.id", "reviewer_replacements.decision_id")
      .leftJoin("repositories", "repositories.id", "routing_decisions.repository_id")
      .select([
        "reviewer_absences.id as absenceId",
        "reviewer_absences.reviewer_handle as reviewerHandle",
        "reviewer_absences.start_at as startAt",
        "reviewer_absences.end_at as endAt",
        "reviewer_absences.status as absenceStatus",
        "reviewer_absences.revision as revision",
        "reviewer_replacements.id as replacementId",
        "reviewer_replacements.unavailable_reviewer as unavailableReviewer",
        "reviewer_replacements.replacement_reviewer as replacementReviewer",
        "reviewer_replacements.outcome as outcome",
        "reviewer_replacements.reason as reason",
        "reviewer_replacements.completed_at as completedAt",
        "routing_decisions.pull_number as pullNumber",
        "repositories.owner as owner",
        "repositories.name as repositoryName",
      ])
      .orderBy(sql<number>`case when reviewer_absences.status = 'scheduled' and reviewer_absences.end_at > ${input.now} then 0 else 1 end`)
      .orderBy(sql<Date>`case when reviewer_absences.status = 'scheduled' and reviewer_absences.end_at > ${input.now} then reviewer_absences.start_at end`)
      .orderBy("reviewer_absences.updated_at", "desc")
      .orderBy("reviewer_replacements.completed_at", "desc")
      .execute(),
  ]);

  const absences = new Map<string, ReviewerAbsenceView>();
  for (const row of rows) {
    let absence = absences.get(row.absenceId);
    if (!absence) {
      absence = {
        id: row.absenceId,
        reviewerHandle: row.reviewerHandle,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
        status: deriveStatus(row.absenceStatus, row.startAt, row.endAt, input.now),
        revision: row.revision,
        replacements: [],
      };
      absences.set(row.absenceId, absence);
    }
    if (
      row.replacementId !== null &&
      row.owner !== null &&
      row.repositoryName !== null &&
      row.pullNumber !== null &&
      row.unavailableReviewer !== null &&
      row.outcome !== null &&
      row.reason !== null &&
      row.completedAt !== null
    ) {
      absence.replacements.push({
        id: row.replacementId,
        repository: `${row.owner}/${row.repositoryName}`,
        pullNumber: row.pullNumber,
        unavailableReviewer: row.unavailableReviewer,
        replacementReviewer: row.replacementReviewer,
        outcome: row.outcome as ReviewerReplacementOutcome,
        reason: row.reason,
        completedAt: row.completedAt.toISOString(),
      });
    }
  }

  return { timezone: settings?.timezone ?? "UTC", absences: [...absences.values()] };
}

export async function listReviewerAbsenceWindows(
  db: Kysely<Database>,
  input: { reviewers: string[]; endingAfter: Date },
): Promise<ReviewerAbsenceWindow[]> {
  validateDate(input.endingAfter, "endingAfter");
  const reviewers = [...new Set(input.reviewers.map(normalizeReviewerHandle).filter((value): value is string => value !== null))];
  if (reviewers.length === 0) return [];

  const rows = await db
    .selectFrom("reviewer_absences")
    .select(["reviewer_handle", "start_at", "end_at"])
    .where("status", "=", "scheduled")
    .where("reviewer_handle", "in", reviewers)
    .where("end_at", ">", input.endingAfter)
    .orderBy("start_at", "asc")
    .execute();
  return rows.map((row) => ({ reviewerHandle: row.reviewer_handle, startAt: row.start_at, endAt: row.end_at }));
}

export async function loadReviewerAbsenceActivation(
  db: Kysely<Database>,
  input: { absenceId: string; expectedRevision: number; now: Date },
): Promise<ReviewerAbsenceActivation | null> {
  validateDate(input.now, "now");
  const absence = await db
    .selectFrom("reviewer_absences")
    .select(["id", "revision", "reviewer_handle", "start_at", "end_at", "status"])
    .where("id", "=", input.absenceId)
    .executeTakeFirst();
  if (
    !absence ||
    absence.revision !== input.expectedRevision ||
    absence.status !== "scheduled" ||
    absence.start_at > input.now ||
    absence.end_at <= input.now
  ) return null;

  return {
    absenceId: absence.id,
    revision: absence.revision,
    reviewerHandle: absence.reviewer_handle,
    startAt: absence.start_at,
    endAt: absence.end_at,
    candidates: await findReviewerReplacementCandidates(db, { unavailableReviewer: absence.reviewer_handle }),
  };
}

export async function recordReviewerReplacement(
  db: Kysely<Database>,
  input: RecordReviewerReplacementInput,
): Promise<{ inserted: boolean }> {
  return db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto("reviewer_replacements")
      .values({
        absence_id: input.absenceId,
        absence_revision: input.absenceRevision,
        decision_id: input.decisionId,
        unavailable_reviewer: input.unavailableReviewer,
        replacement_reviewer: input.replacementReviewer,
        outcome: input.outcome,
        reason: input.reason,
        started_at: input.startedAt,
        completed_at: input.completedAt,
      })
      .onConflict((conflict) => conflict.columns(["absence_id", "absence_revision", "decision_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!inserted) return { inserted: false };

    if (input.replaceCohort && replacesReviewerCohort(input.outcome) && input.replacementReviewer !== null) {
      await replaceDecisionReviewerCohort(trx, {
        decisionId: input.decisionId,
        unavailableReviewer: input.unavailableReviewer,
        replacementReviewer: input.replacementReviewer,
      });
    }
    return { inserted: true };
  });
}

export async function findReviewerReplacementOutcome(
  db: Kysely<Database>,
  input: { absenceId: string; absenceRevision: number; decisionId: string },
): Promise<ReviewerReplacementOutcome | null> {
  const replacement = await db
    .selectFrom("reviewer_replacements")
    .select("outcome")
    .where("absence_id", "=", input.absenceId)
    .where("absence_revision", "=", input.absenceRevision)
    .where("decision_id", "=", input.decisionId)
    .executeTakeFirst();
  return replacement ? replacement.outcome as ReviewerReplacementOutcome : null;
}

function replacesReviewerCohort(outcome: ReviewerReplacementOutcome): boolean {
  return outcome === "replaced" || outcome === "simulated_replacement";
}

function validateMutation(input: ReviewerAbsenceMutation): ReviewerAbsenceMutation & { reviewerHandle: string } {
  const reviewerHandle = normalizeReviewerHandle(input.reviewerHandle);
  if (!reviewerHandle) throw new ReviewerAbsenceValidationError("Reviewer handle must be an individual GitHub handle");
  validateDate(input.startAt, "startAt");
  validateDate(input.endAt, "endAt");
  validateDate(input.now, "now");
  if (input.endAt.getTime() <= input.startAt.getTime()) {
    throw new ReviewerAbsenceValidationError("Absence end must be after its start");
  }
  return { ...input, reviewerHandle };
}

function validateDate(value: Date, name: string): void {
  if (!Number.isFinite(value.getTime())) throw new ReviewerAbsenceValidationError(`${name} must be a finite date`);
}

function validateExpectedRevision(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new ReviewerAbsenceValidationError("expectedRevision must be positive");
}

function assertCurrentAbsence(
  absence: { id: string; revision: number; status: "scheduled" | "cancelled" } | undefined,
  expectedRevision: number,
): asserts absence is { id: string; revision: number; status: "scheduled" } {
  if (!absence) throw new ReviewerAbsenceNotFoundError("Reviewer absence was not found");
  if (absence.revision !== expectedRevision || absence.status !== "scheduled") {
    throw new ReviewerAbsenceRevisionError("Reviewer absence revision is stale");
  }
}

async function enqueueActivation(
  db: Kysely<Database>,
  absenceId: string,
  revision: number,
  startAt: Date,
  now: Date,
): Promise<void> {
  const payload: ReviewerAbsenceActivationJobPayload = {
    kind: "activate_reviewer_absence",
    absenceId,
    expectedRevision: revision,
  };
  await createJobQueue(db).enqueue({
    kind: payload.kind,
    payload,
    idempotencyKey: `reviewer-absence:${absenceId}:revision:${revision}`,
    runAt: startAt > now ? startAt : now,
  });
}

function toAbsenceView(
  absence: { id: string; reviewer_handle: string; start_at: Date; end_at: Date; status: "scheduled" | "cancelled"; revision: number },
  now: Date,
): ReviewerAbsenceView {
  return {
    id: absence.id,
    reviewerHandle: absence.reviewer_handle,
    startAt: absence.start_at.toISOString(),
    endAt: absence.end_at.toISOString(),
    status: deriveStatus(absence.status, absence.start_at, absence.end_at, now),
    revision: absence.revision,
    replacements: [],
  };
}

function deriveStatus(status: "scheduled" | "cancelled", startAt: Date, endAt: Date, now: Date): ReviewerAbsenceStatus {
  if (status === "cancelled") return "cancelled";
  if (now < startAt) return "upcoming";
  if (now < endAt) return "active";
  return "ended";
}

function translateConflict(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "constraint" in error &&
    error.constraint === "reviewer_absences_no_overlap"
  ) return new ReviewerAbsenceConflictError("Reviewer absence overlaps an existing absence");
  return error instanceof Error ? error : new Error("Unable to persist reviewer absence");
}
