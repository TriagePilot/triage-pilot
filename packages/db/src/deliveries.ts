import type { Kysely, Transaction } from "kysely";
import { legacyRoutingKey, type HumanReviewPolicyJobPayload, type QueueInvalidationRef, type RoutingJobPayload, type WorkspaceId, type ProviderKind } from "@triagepilot/contracts";
import { upsertDeliveryRepository, type ProviderConnectionMetadata, type ProviderRepositoryMetadata } from "./provider-connections.js";
import { invalidateQueuePullTransaction } from "./pull-request-projection.js";
import type { Database } from "./kysely.js";
import type { JobLease } from "./jobs.js";
import { sql } from "kysely";

export interface RoutingDeliveryInput {
  deliveryId: string; eventName: string; eventAction: string; hookId: string | null;
  connection: ProviderConnectionMetadata; repository: ProviderRepositoryMetadata;
  payload: Omit<RoutingJobPayload, "workspaceId" | "providerConnectionId">;
}
export interface HumanReviewPolicyDeliveryInput {
  deliveryId: string; eventName: string; eventAction?: string; hookId?: string | null;
  connection: ProviderConnectionMetadata; repository: ProviderRepositoryMetadata;
  payload: Omit<HumanReviewPolicyJobPayload, "workspaceId" | "providerConnectionId">;
}
export interface PullRequestDeliveryInput {
  deliveryId: string; eventName: string; eventAction?: string; hookId?: string | null;
  connection: ProviderConnectionMetadata; repository: ProviderRepositoryMetadata;
  invalidation: QueueInvalidationRef;
  routingPayload?: RoutingDeliveryInput["payload"];
  policyPayload?: HumanReviewPolicyDeliveryInput["payload"];
}
export async function acceptPullRequestDelivery(db: Kysely<Database>, workspaceId: WorkspaceId, input: PullRequestDeliveryInput): Promise<{ inserted: boolean; routingJobId: string | null; policyJobId: string | null; deferred?: boolean }> {
  return db.transaction().execute(trx => acceptPullRequestDeliveryTransaction(trx, workspaceId, input));
}
async function acceptPullRequestDeliveryTransaction(trx: Transaction<Database>, workspaceId: WorkspaceId, input: PullRequestDeliveryInput): Promise<{ inserted: boolean; routingJobId: string | null; policyJobId: string | null; deferred?: boolean }> {
  const none = { inserted: false, routingJobId: null, policyJobId: null };
    if (input.invalidation.externalInstallationId !== input.connection.externalConnectionId || input.invalidation.repository.provider !== input.repository.provider || input.invalidation.repository.externalId !== input.repository.externalRepositoryId) throw new Error("delivery scope mismatch");
    for (const payload of [input.routingPayload, input.policyPayload]) {
      if (payload && (payload.changeRequest.number !== input.invalidation.pullNumber || payload.changeRequest.repository.provider !== input.invalidation.repository.provider || payload.changeRequest.repository.externalId !== input.invalidation.repository.externalId)) throw new Error("delivery payload scope mismatch");
    }
    const projection = await upsertDeliveryRepository(trx, workspaceId, input.connection, input.repository);
    if (projection && "unavailableConnectionId" in projection) {
      const receipt = await trx.selectFrom("webhook_receipts").select("delivery_id").where("workspace_id", "=", workspaceId).where("provider", "=", input.connection.provider).where("delivery_id", "=", input.deliveryId).executeTakeFirst();
      if (receipt) return none;
      const pending = await trx.insertInto("deferred_pull_request_deliveries").values({ workspace_id: workspaceId, provider: input.connection.provider, delivery_id: input.deliveryId, provider_connection_id: projection.unavailableConnectionId, external_installation_id: input.connection.externalConnectionId, external_repository_id: input.repository.externalRepositoryId, input: JSON.stringify(input), dispatch_job_id: null }).onConflict(c => c.columns(["workspace_id", "provider", "delivery_id"]).doNothing()).returningAll().executeTakeFirst();
      if (pending) await dispatchDeferred(trx, pending, 1);
      return { ...none, deferred: true };
    }
    if (!projection) return none;
    const { providerConnectionId, repositoryId } = projection;
    const receipt = await trx.insertInto("webhook_receipts").values({ workspace_id: workspaceId, provider: input.connection.provider, delivery_id: input.deliveryId, event_name: input.eventName, event_action: input.eventAction ?? null, hook_id: input.hookId ?? null, external_connection_id: input.connection.externalConnectionId, payload_summary: { repositoryId } }).onConflict(c => c.columns(["workspace_id", "provider", "delivery_id"]).doNothing()).returning("delivery_id").executeTakeFirst();
    if (!receipt) return none;
    await invalidateQueuePullTransaction(trx, { workspaceId, providerConnectionId, externalInstallationId: input.connection.externalConnectionId, repositoryId, externalRepositoryId: input.repository.externalRepositoryId, pullNumber: input.invalidation.pullNumber });
    let routingJobId: string | null = null;
    let policyJobId: string | null = null;
    if (input.routingPayload) {
      const legacyKey = input.routingPayload.routingKey ?? legacyRoutingKey(input.deliveryId);
      const routingKey = `installation-routing:${JSON.stringify([providerConnectionId, input.connection.externalConnectionId, input.repository.externalRepositoryId, legacyKey])}`;
      // Only immutable provenance can establish that an old unscoped key represents
      // this installation. An unknown or different generation must never suppress it.
      const legacy = await trx.selectFrom("jobs").select("id").where("workspace_id", "=", workspaceId)
        .where("provider", "=", input.repository.provider).where("kind", "=", "process_pull_request")
        .where("idempotency_key", "=", legacyKey).where("provider_connection_id", "=", providerConnectionId)
        .where("external_installation_id", "=", input.connection.externalConnectionId)
        .where("external_repository_id", "=", input.repository.externalRepositoryId).executeTakeFirst();
      if (!legacy) {
        const job = await trx.insertInto("jobs").values({ workspace_id: workspaceId, provider: input.repository.provider, provider_connection_id: providerConnectionId, external_installation_id: input.connection.externalConnectionId, external_repository_id: input.repository.externalRepositoryId, kind: "process_pull_request", payload: { ...input.routingPayload, routingKey, workspaceId, providerConnectionId }, idempotency_key: routingKey }).onConflict(c => c.columns(["workspace_id", "idempotency_key"]).doNothing()).returning("id").executeTakeFirst();
        routingJobId = job?.id ?? null;
      }
    }
    if (input.policyPayload) {
      const job = await trx.insertInto("jobs").values({ workspace_id: workspaceId, provider: input.repository.provider, provider_connection_id: providerConnectionId, external_installation_id: input.connection.externalConnectionId, external_repository_id: input.repository.externalRepositoryId, kind: "evaluate_human_review_policy", payload: { ...input.policyPayload, workspaceId, providerConnectionId }, idempotency_key: `review-policy:${JSON.stringify([providerConnectionId, input.connection.externalConnectionId, input.deliveryId])}` }).returning("id").executeTakeFirstOrThrow();
      policyJobId = job.id;
    }
    return { inserted: true, routingJobId, policyJobId };
}
async function dispatchDeferred(trx: Transaction<Database>, row: { workspace_id: string; provider: ProviderKind; delivery_id: string; provider_connection_id: string; external_installation_id: string; external_repository_id: string }, epoch: number): Promise<void> {
  const job = await trx.insertInto("jobs").values({ workspace_id: row.workspace_id, provider: row.provider, provider_connection_id: row.provider_connection_id, external_installation_id: row.external_installation_id, external_repository_id: row.external_repository_id, kind: "replay_deferred_delivery", payload: { deliveryId: row.delivery_id }, idempotency_key: `deferred-delivery:${JSON.stringify([row.provider_connection_id, row.external_installation_id, row.delivery_id, epoch])}` }).returning("id").executeTakeFirstOrThrow();
  await trx.updateTable("deferred_pull_request_deliveries").set({ dispatch_epoch: epoch, dispatch_job_id: job.id }).where("workspace_id", "=", row.workspace_id).where("provider", "=", row.provider).where("delivery_id", "=", row.delivery_id).execute();
}
/** Recover at most one eligible terminal dispatch per maintenance iteration. */
export async function recoverDeferredPullRequestDelivery(db: Kysely<Database>, workspaceId: WorkspaceId, now: Date): Promise<boolean> {
  return db.transaction().execute(async trx => {
    const row = await trx.selectFrom("deferred_pull_request_deliveries as d").selectAll("d").where("d.workspace_id", "=", workspaceId)
      .where(sql<boolean>`exists (select 1 from provider_connections c join repositories r on r.workspace_id = c.workspace_id and r.provider = c.provider and r.provider_connection_id = c.id and r.external_repository_id = d.external_repository_id where c.workspace_id = d.workspace_id and c.id = d.provider_connection_id and c.provider = d.provider and c.status = 'active' and c.external_connection_id = d.external_installation_id and not exists (select 1 from provider_connection_revocations v where v.workspace_id = c.workspace_id and v.provider = c.provider and v.external_connection_id = c.external_connection_id))`)
      .where(sql<boolean>`not exists (select 1 from jobs j where j.id = d.dispatch_job_id and (j.status in ('queued', 'running') or j.updated_at > ${new Date(now.getTime() - 60_000)}))`)
      .orderBy("d.created_at").orderBy("d.delivery_id").forUpdate().skipLocked().executeTakeFirst();
    if (!row) return false;
    await dispatchDeferred(trx, row, row.dispatch_epoch + 1);
    return true;
  });
}
export async function replayDeferredPullRequestDelivery(db: Kysely<Database>, lease: JobLease): Promise<boolean> {
  return db.transaction().execute(async trx => {
    const job = await trx.selectFrom("jobs").selectAll().where("id", "=", lease.jobId).where("workspace_id", "=", lease.workspaceId).where("kind", "=", "replay_deferred_delivery").where("provider_connection_id", "=", lease.providerConnectionId).where("status", "=", "running").where("locked_by", "=", lease.lockedBy).where("locked_at", "=", lease.lockedAt).where("attempt_count", "=", lease.attemptCount).where(sql<boolean>`locked_at > now() - interval '15 minutes'`).forUpdate().executeTakeFirst();
    if (!job || !job.external_installation_id || !job.external_repository_id || !job.payload || typeof job.payload !== "object" || !("deliveryId" in job.payload) || typeof job.payload.deliveryId !== "string") return false;
    const row = await trx.selectFrom("deferred_pull_request_deliveries").selectAll().where("workspace_id", "=", lease.workspaceId).where("provider", "=", lease.provider).where("delivery_id", "=", job.payload.deliveryId).where("provider_connection_id", "=", lease.providerConnectionId).where("external_installation_id", "=", job.external_installation_id).where("external_repository_id", "=", job.external_repository_id).forUpdate().executeTakeFirst();
    if (!row || row.dispatch_job_id !== job.id) return false;
    const result = await acceptPullRequestDeliveryTransaction(trx, lease.workspaceId, row.input as PullRequestDeliveryInput);
    if (result.deferred || (!result.inserted && !await trx.selectFrom("webhook_receipts").select("delivery_id").where("workspace_id", "=", lease.workspaceId).where("provider", "=", lease.provider).where("delivery_id", "=", row.delivery_id).executeTakeFirst())) throw new Error("deferred delivery authority unavailable");
    await trx.deleteFrom("deferred_pull_request_deliveries").where("workspace_id", "=", lease.workspaceId).where("provider", "=", row.provider).where("delivery_id", "=", row.delivery_id).execute();
    await trx.updateTable("jobs").set({ status: "succeeded", locked_at: null, locked_by: null, updated_at: new Date() }).where("id", "=", job.id).execute();
    return true;
  });
}
function invalidation(input: RoutingDeliveryInput | HumanReviewPolicyDeliveryInput): QueueInvalidationRef {
  return { externalInstallationId: input.connection.externalConnectionId, repository: input.payload.changeRequest.repository, pullNumber: input.payload.changeRequest.number };
}
export async function acceptRoutingDelivery(db: Kysely<Database>, workspaceId: WorkspaceId, input: RoutingDeliveryInput): Promise<{ inserted: boolean; jobId: string | null }> {
  const result = await acceptPullRequestDelivery(db, workspaceId, { ...input, invalidation: invalidation(input), routingPayload: input.payload });
  return { inserted: result.inserted, jobId: result.routingJobId };
}
export async function acceptHumanReviewPolicyDelivery(db: Kysely<Database>, workspaceId: WorkspaceId, input: HumanReviewPolicyDeliveryInput): Promise<{ inserted: boolean; jobId: string | null }> {
  const result = await acceptPullRequestDelivery(db, workspaceId, { ...input, invalidation: invalidation(input), policyPayload: input.payload });
  return { inserted: result.inserted, jobId: result.policyJobId };
}
