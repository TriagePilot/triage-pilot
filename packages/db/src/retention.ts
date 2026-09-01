import type { Kysely } from "kysely";
import type { WorkspaceId } from "@triagepilot/contracts";

import type { Database } from "./kysely.js";

export const RECEIPT_AND_COMPLETED_JOB_DAYS = 30;
export const DECISION_AND_FAILURE_DAYS = 90;

export async function applyFixedRetention(db: Kysely<Database>, workspaceId: WorkspaceId, now: Date): Promise<void> {
  const receiptAndCompletedJobCutoff = daysAgo(now, RECEIPT_AND_COMPLETED_JOB_DAYS);
  const decisionAndFailureCutoff = daysAgo(now, DECISION_AND_FAILURE_DAYS);

  await db.deleteFrom("webhook_receipts").where("workspace_id", "=", workspaceId).where("created_at", "<", receiptAndCompletedJobCutoff).execute();
  await db
    .deleteFrom("jobs")
    .where("workspace_id", "=", workspaceId)
    .where("status", "=", "succeeded")
    .where("updated_at", "<", receiptAndCompletedJobCutoff)
    .execute();
  await db
    .deleteFrom("jobs")
    .where("workspace_id", "=", workspaceId)
    .where("status", "=", "failed")
    .where("updated_at", "<", decisionAndFailureCutoff)
    .execute();
  await db.deleteFrom("routing_decisions")
    .where("workspace_id", "=", workspaceId)
    .where("created_at", "<", decisionAndFailureCutoff)
    .where(({ not, exists, selectFrom }) => not(exists(
      selectFrom("reviewer_mutation_intents")
        .select("reviewer_mutation_intents.id")
        .whereRef("reviewer_mutation_intents.workspace_id", "=", "routing_decisions.workspace_id")
        .whereRef("reviewer_mutation_intents.decision_id", "=", "routing_decisions.id"),
    )))
    .where(({ not, exists, selectFrom }) => not(exists(
      selectFrom("reviewer_replacements")
        .select("reviewer_replacements.id")
        .whereRef("reviewer_replacements.workspace_id", "=", "routing_decisions.workspace_id")
        .whereRef("reviewer_replacements.decision_id", "=", "routing_decisions.id"),
    )))
    .where(({ not, exists, selectFrom }) => not(exists(
      selectFrom("jobs")
        .innerJoin("repositories", (join) => join
          .onRef("repositories.workspace_id", "=", "jobs.workspace_id")
          .onRef("repositories.provider", "=", "jobs.provider")
          .onRef("repositories.provider_connection_id", "=", "jobs.provider_connection_id"))
        .select("jobs.id")
        .whereRef("jobs.workspace_id", "=", "routing_decisions.workspace_id")
        .whereRef("repositories.id", "=", "routing_decisions.repository_id")
        .where("jobs.kind", "=", "activate_reviewer_absence")
        .where("jobs.status", "in", ["queued", "running"]),
    )))
    .execute();
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
