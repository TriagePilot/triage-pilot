import type { Kysely } from "kysely";
import { legacyRoutingKey, type HumanReviewPolicyJobPayload, type RoutingJobPayload, type WorkspaceId } from "@triagepilot/contracts";

import { upsertDeliveryRepository, type ProviderConnectionMetadata, type ProviderRepositoryMetadata } from "./provider-connections";
import type { Database } from "./kysely";

export interface RoutingDeliveryInput {
  deliveryId: string;
  eventName: string;
  eventAction: string;
  hookId: string | null;
  connection: ProviderConnectionMetadata;
  repository: ProviderRepositoryMetadata;
  payload: Omit<RoutingJobPayload, "workspaceId" | "providerConnectionId">;
}

export interface HumanReviewPolicyDeliveryInput {
  deliveryId: string;
  eventName: string;
  eventAction?: string;
  hookId?: string | null;
  connection: ProviderConnectionMetadata;
  repository: ProviderRepositoryMetadata;
  payload: Omit<HumanReviewPolicyJobPayload, "workspaceId" | "providerConnectionId">;
}

export async function acceptRoutingDelivery(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: RoutingDeliveryInput,
): Promise<{ inserted: boolean; jobId: string | null }> {
  return await db.transaction().execute(async (trx) => {
    const { providerConnectionId, repositoryId } = await upsertDeliveryRepository(
      trx,
      workspaceId,
      input.connection,
      input.repository,
    );
    const receipt = await trx
      .insertInto("webhook_receipts")
      .values({
        workspace_id: workspaceId,
        provider: input.connection.provider,
        delivery_id: input.deliveryId,
        event_name: input.eventName,
        event_action: input.eventAction,
        hook_id: input.hookId,
        external_connection_id: input.connection.externalConnectionId,
        payload_summary: { repositoryId },
      })
      .onConflict((conflict) => conflict.columns(["workspace_id", "provider", "delivery_id"]).doNothing())
      .returning("delivery_id")
      .executeTakeFirst();

    if (!receipt) return { inserted: false, jobId: null };

    const job = await trx
      .insertInto("jobs")
      .values({
        workspace_id: workspaceId,
        provider: input.repository.provider,
        provider_connection_id: providerConnectionId,
        kind: "process_pull_request",
        payload: { ...input.payload, workspaceId, providerConnectionId },
        idempotency_key: input.payload.routingKey ?? legacyRoutingKey(input.deliveryId),
      })
      .onConflict((conflict) => conflict.columns(["workspace_id", "idempotency_key"]).doNothing())
      .returning("id")
      .executeTakeFirst();

    return { inserted: true, jobId: job?.id ?? null };
  });
}

export async function acceptHumanReviewPolicyDelivery(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: HumanReviewPolicyDeliveryInput,
): Promise<{ inserted: boolean; jobId: string | null }> {
  return await db.transaction().execute(async (trx) => {
    const { providerConnectionId, repositoryId } = await upsertDeliveryRepository(
      trx,
      workspaceId,
      input.connection,
      input.repository,
    );
    const receipt = await trx
      .insertInto("webhook_receipts")
      .values({
        workspace_id: workspaceId,
        provider: input.connection.provider,
        delivery_id: input.deliveryId,
        event_name: input.eventName,
        event_action: input.eventAction ?? null,
        hook_id: input.hookId ?? null,
        external_connection_id: input.connection.externalConnectionId,
        payload_summary: { repositoryId },
      })
      .onConflict((conflict) => conflict.columns(["workspace_id", "provider", "delivery_id"]).doNothing())
      .returning("delivery_id")
      .executeTakeFirst();

    if (!receipt) return { inserted: false, jobId: null };

    const job = await trx
      .insertInto("jobs")
      .values({
        workspace_id: workspaceId,
        provider: input.repository.provider,
        provider_connection_id: providerConnectionId,
        kind: "evaluate_human_review_policy",
        payload: { ...input.payload, workspaceId, providerConnectionId },
        idempotency_key: `review-policy:${input.deliveryId}`,
      })
      .onConflict((conflict) => conflict.columns(["workspace_id", "idempotency_key"]).doNothing())
      .returning("id")
      .executeTakeFirst();

    if (!job) throw new Error("review policy receipt inserted without a policy-evaluation job");
    return { inserted: true, jobId: job.id };
  });
}
