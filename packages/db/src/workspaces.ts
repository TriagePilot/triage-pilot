import type { Kysely } from "kysely";
import type { WorkspaceId } from "@triagepilot/contracts";

import type { Database } from "./kysely.js";
import {
  findLatestHumanReviewPolicyDecision,
  markActionFailed,
  markActionSucceeded,
  persistDecision,
  recordPolicyCheck,
  updatePolicyCheckState,
  type DecisionInput,
  type HumanReviewPolicyDecision,
  type PersistedDecision,
} from "./decisions.js";
import {
  acceptHumanReviewPolicyDelivery,
  acceptRoutingDelivery,
  type HumanReviewPolicyDeliveryInput,
  type RoutingDeliveryInput,
} from "./deliveries.js";
import { createWorkspaceJobQueue, recoverStaleJobs, type WorkspaceJobQueue } from "./jobs.js";
import { readOperationsOverview, type OperationsOverview, type ReadOperationsOverviewInput } from "./operations.js";
import {
  activateConfiguredProviderConnection,
  deleteConfiguredProviderConnection,
  replaceProviderConnectionRepositories,
  suspendConfiguredProviderConnection,
  updateProviderConnectionRepositories,
  upsertConfiguredProviderConnection,
  type ConfiguredProviderConnectionInput,
  type ProviderConnectionMetadata,
  type ProviderConnectionRepositoryUpdateInput,
} from "./provider-connections.js";
import { applyFixedRetention } from "./retention.js";

export const LOCAL_WORKSPACE_EXTERNAL_KEY = "self-hosted";

export async function ensureLocalWorkspace(db: Kysely<Database>): Promise<WorkspaceId> {
  const workspace = await db
    .insertInto("workspaces")
    .values({ external_key: LOCAL_WORKSPACE_EXTERNAL_KEY })
    .onConflict((conflict) => conflict.column("external_key").doUpdateSet({
      external_key: LOCAL_WORKSPACE_EXTERNAL_KEY,
    }))
    .returning("id")
    .executeTakeFirstOrThrow();
  return workspace.id;
}

export interface WorkspaceRepositories {
  workspaceId: WorkspaceId;
  jobs: WorkspaceJobQueue;
  persistDecision(input: DecisionInput): Promise<PersistedDecision>;
  recordPolicyCheck(input: { decisionId: string; checkRunId: string; state: "in_progress" | "success" | "failure" }): Promise<void>;
  findLatestHumanReviewPolicyDecision(input: { repositoryId: string; pullNumber: number }): Promise<HumanReviewPolicyDecision | null>;
  updatePolicyCheckState(input: { decisionId: string; state: "in_progress" | "success" | "failure" }): Promise<void>;
  markActionSucceeded(decisionId: string, at: Date): Promise<void>;
  markActionFailed(decisionId: string, error: string, at: Date): Promise<void>;
  readOperations(input: ReadOperationsOverviewInput): Promise<OperationsOverview>;
  recoverStaleJobs(now: Date, staleAfterMs?: number): Promise<void>;
  applyFixedRetention(now: Date): Promise<void>;
  acceptRoutingDelivery(input: RoutingDeliveryInput): Promise<{ inserted: boolean; jobId: string | null }>;
  acceptHumanReviewPolicyDelivery(input: HumanReviewPolicyDeliveryInput): Promise<{ inserted: boolean; jobId: string | null }>;
  activateConfiguredProviderConnection(input: ProviderConnectionMetadata): Promise<void>;
  upsertConfiguredProviderConnection(input: ConfiguredProviderConnectionInput): Promise<void>;
  replaceProviderConnectionRepositories(input: ConfiguredProviderConnectionInput): Promise<void>;
  updateProviderConnectionRepositories(input: ProviderConnectionRepositoryUpdateInput): Promise<void>;
  suspendConfiguredProviderConnection(input: ProviderConnectionMetadata): Promise<void>;
  deleteConfiguredProviderConnection(input: Pick<ProviderConnectionMetadata, "provider" | "externalConnectionId">): Promise<void>;
}

export function createWorkspaceRepositories(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): WorkspaceRepositories {
  return {
    workspaceId,
    jobs: createWorkspaceJobQueue(db, workspaceId),
    persistDecision: (input) => persistDecision(db, workspaceId, input),
    recordPolicyCheck: (input) => recordPolicyCheck(db, workspaceId, input),
    findLatestHumanReviewPolicyDecision: (input) => findLatestHumanReviewPolicyDecision(db, workspaceId, input),
    updatePolicyCheckState: (input) => updatePolicyCheckState(db, workspaceId, input),
    markActionSucceeded: (decisionId, at) => markActionSucceeded(db, workspaceId, decisionId, at),
    markActionFailed: (decisionId, error, at) => markActionFailed(db, workspaceId, decisionId, error, at),
    readOperations: (input) => readOperationsOverview(db, workspaceId, input),
    recoverStaleJobs: (now, staleAfterMs) => recoverStaleJobs(db, workspaceId, now, staleAfterMs),
    applyFixedRetention: (now) => applyFixedRetention(db, workspaceId, now),
    acceptRoutingDelivery: (input) => acceptRoutingDelivery(db, workspaceId, input),
    acceptHumanReviewPolicyDelivery: (input) => acceptHumanReviewPolicyDelivery(db, workspaceId, input),
    activateConfiguredProviderConnection: (input) => activateConfiguredProviderConnection(db, workspaceId, input),
    upsertConfiguredProviderConnection: (input) => upsertConfiguredProviderConnection(db, workspaceId, input),
    replaceProviderConnectionRepositories: (input) => replaceProviderConnectionRepositories(db, workspaceId, input),
    updateProviderConnectionRepositories: (input) => updateProviderConnectionRepositories(db, workspaceId, input),
    suspendConfiguredProviderConnection: (input) => suspendConfiguredProviderConnection(db, workspaceId, input),
    deleteConfiguredProviderConnection: (input) => deleteConfiguredProviderConnection(db, workspaceId, input),
  };
}
