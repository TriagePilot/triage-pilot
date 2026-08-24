import type { Kysely } from "kysely";
import type {
  GitHubInstallationMetadata,
  GitHubRepositoryMetadata,
  HumanReviewPolicyJobPayload,
  RoutingJobPayload,
} from "@triagepilot/shared";
import { legacyRoutingKey } from "@triagepilot/shared";

import { upsertDeliveryRepository } from "./installations";
import type { Database } from "./kysely";

export interface RoutingDeliveryInput {
  deliveryId: string;
  eventName: string;
  eventAction: string;
  hookId: string | null;
  installation: GitHubInstallationMetadata;
  repository: GitHubRepositoryMetadata;
  payload: RoutingJobPayload;
}

export interface HumanReviewPolicyDeliveryInput {
  deliveryId: string;
  eventName: string;
  eventAction?: string;
  hookId?: string | null;
  installation: GitHubInstallationMetadata;
  repository: GitHubRepositoryMetadata;
  payload: HumanReviewPolicyJobPayload;
}

export async function acceptRoutingDelivery(
  db: Kysely<Database>,
  input: RoutingDeliveryInput,
): Promise<{ inserted: boolean; jobId: string | null }> {
  return await db.transaction().execute(async (trx) => {
    const repositoryId = await upsertDeliveryRepository(trx, input.installation, input.repository);
    const receipt = await trx
      .insertInto("webhook_receipts")
      .values({
        delivery_id: input.deliveryId,
        event_name: input.eventName,
        event_action: input.eventAction,
        hook_id: input.hookId,
        installation_id: input.installation.githubInstallationId,
        payload_summary: { repositoryId },
      })
      .onConflict((conflict) => conflict.column("delivery_id").doNothing())
      .returning("delivery_id")
      .executeTakeFirst();

    if (!receipt) return { inserted: false, jobId: null };

    const job = await trx
      .insertInto("jobs")
      .values({
        kind: "process_pull_request",
        payload: input.payload,
        idempotency_key: input.payload.routingKey ?? legacyRoutingKey(input.deliveryId),
      })
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
      .returning("id")
      .executeTakeFirst();

    return { inserted: true, jobId: job?.id ?? null };
  });
}

export async function acceptHumanReviewPolicyDelivery(
  db: Kysely<Database>,
  input: HumanReviewPolicyDeliveryInput,
): Promise<{ inserted: boolean; jobId: string | null }> {
  return await db.transaction().execute(async (trx) => {
    const repositoryId = await upsertDeliveryRepository(trx, input.installation, input.repository);
    const receipt = await trx
      .insertInto("webhook_receipts")
      .values({
        delivery_id: input.deliveryId,
        event_name: input.eventName,
        event_action: input.eventAction ?? null,
        hook_id: input.hookId ?? null,
        installation_id: input.installation.githubInstallationId,
        payload_summary: { repositoryId },
      })
      .onConflict((conflict) => conflict.column("delivery_id").doNothing())
      .returning("delivery_id")
      .executeTakeFirst();

    if (!receipt) return { inserted: false, jobId: null };

    const job = await trx
      .insertInto("jobs")
      .values({
        kind: "evaluate_human_review_policy",
        payload: input.payload,
        idempotency_key: `review-policy:${input.deliveryId}`,
      })
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
      .returning("id")
      .executeTakeFirst();

    if (!job) throw new Error("review policy receipt inserted without a policy-evaluation job");
    return { inserted: true, jobId: job.id };
  });
}
