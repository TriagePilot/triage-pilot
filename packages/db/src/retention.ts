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
  await db.deleteFrom("routing_decisions").where("workspace_id", "=", workspaceId).where("created_at", "<", decisionAndFailureCutoff).execute();
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
