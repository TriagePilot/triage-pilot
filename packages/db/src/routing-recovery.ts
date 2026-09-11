import { sql, type Kysely } from "kysely";
import type {
  ChangeRequestId,
  ProviderConnectionId,
  ProviderKind,
  RepositoryRef,
  RoutingJobPayload,
  WorkspaceId,
} from "@triagepilot/contracts";

import type { Database } from "./kysely.js";
import { lockProviderConnectionProjection } from "./provider-connections.js";

export type RoutingRecoveryTargetRequest =
  | { decisionId: string }
  | {
      changeRequest: {
        repository: RepositoryRef;
        externalId: ChangeRequestId;
        number: number;
      };
    };

export interface RoutingRecoveryTarget {
  providerConnectionId: ProviderConnectionId;
  repository: RepositoryRef;
  changeRequestId: ChangeRequestId;
  changeRequestNumber: number;
}

export interface RoutingRecoveryEnqueueInput {
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  payload: RoutingJobPayload;
  idempotencyKey: string;
}

export interface WorkspaceRoutingRecoveryRepository {
  findTarget(request: RoutingRecoveryTargetRequest): Promise<RoutingRecoveryTarget | null>;
  findActiveRepository(input: { provider: ProviderKind; owner: string; name: string }): Promise<RepositoryRef | null>;
  findActiveExternalConnectionId(input: {
    provider: ProviderKind;
    providerConnectionId: ProviderConnectionId;
  }): Promise<string | null>;
  enqueue(input: RoutingRecoveryEnqueueInput): Promise<{ inserted: boolean; jobId: string } | null>;
}

export function createWorkspaceRoutingRecoveryRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): WorkspaceRoutingRecoveryRepository {
  return {
    findTarget: (request) => findRoutingRecoveryTarget(db, workspaceId, request),
    findActiveRepository: (input) => findActiveRecoveryRepository(db, workspaceId, input),
    findActiveExternalConnectionId: (input) => findActiveExternalConnectionId(db, workspaceId, input),
    enqueue: (input) => enqueueRoutingRecovery(db, workspaceId, input),
  };
}

export async function findRoutingRecoveryTarget(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  request: RoutingRecoveryTargetRequest,
): Promise<RoutingRecoveryTarget | null> {
  if ("decisionId" in request) {
    const target = await db
      .selectFrom("routing_decisions")
      .innerJoin("repositories", (join) => join
        .onRef("repositories.id", "=", "routing_decisions.repository_id")
        .onRef("repositories.workspace_id", "=", "routing_decisions.workspace_id"))
      .innerJoin("provider_connections", (join) => join
        .onRef("provider_connections.id", "=", "repositories.provider_connection_id")
        .onRef("provider_connections.workspace_id", "=", "repositories.workspace_id")
        .onRef("provider_connections.provider", "=", "repositories.provider"))
      .select([
        "repositories.provider",
        "repositories.provider_connection_id",
        "repositories.external_repository_id",
        "repositories.owner",
        "repositories.name",
        "routing_decisions.change_request_id",
        "routing_decisions.pull_number",
      ])
      .where("routing_decisions.workspace_id", "=", workspaceId)
      .where("routing_decisions.id", "=", request.decisionId)
      .where("provider_connections.status", "=", "active")
      .executeTakeFirst();
    return target === undefined ? null : toRoutingRecoveryTarget(target);
  }

  const reference = request.changeRequest;
  const target = await db
    .selectFrom("repositories")
    .innerJoin("provider_connections", (join) => join
      .onRef("provider_connections.id", "=", "repositories.provider_connection_id")
      .onRef("provider_connections.workspace_id", "=", "repositories.workspace_id")
      .onRef("provider_connections.provider", "=", "repositories.provider"))
    .select([
      "repositories.provider",
      "repositories.provider_connection_id",
      "repositories.external_repository_id",
      "repositories.owner",
      "repositories.name",
    ])
    .where("repositories.workspace_id", "=", workspaceId)
    .where("repositories.provider", "=", reference.repository.provider)
    .where("repositories.external_repository_id", "=", reference.repository.externalId)
    .where("repositories.owner", "=", reference.repository.owner)
    .where("repositories.name", "=", reference.repository.name)
    .where("provider_connections.status", "=", "active")
    .executeTakeFirst();
  if (target === undefined) return null;
  return toRoutingRecoveryTarget({
    ...target,
    change_request_id: reference.externalId,
    pull_number: reference.number,
  });
}

export async function findActiveRecoveryRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: { provider: ProviderKind; owner: string; name: string },
): Promise<RepositoryRef | null> {
  const matches = await db
    .selectFrom("repositories")
    .innerJoin("provider_connections", (join) => join
      .onRef("provider_connections.id", "=", "repositories.provider_connection_id")
      .onRef("provider_connections.workspace_id", "=", "repositories.workspace_id")
      .onRef("provider_connections.provider", "=", "repositories.provider"))
    .select([
      "repositories.provider",
      "repositories.external_repository_id",
      "repositories.owner",
      "repositories.name",
    ])
    .where("repositories.workspace_id", "=", workspaceId)
    .where("repositories.provider", "=", input.provider)
    .where(sql<boolean>`lower(repositories.owner) = lower(${input.owner})`)
    .where(sql<boolean>`lower(repositories.name) = lower(${input.name})`)
    .where("provider_connections.status", "=", "active")
    .limit(2)
    .execute();
  if (matches.length !== 1) return null;
  const repository = matches[0]!;
  return {
    provider: repository.provider,
    externalId: repository.external_repository_id,
    owner: repository.owner,
    name: repository.name,
  };
}

export async function findActiveExternalConnectionId(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: { provider: ProviderKind; providerConnectionId: ProviderConnectionId },
): Promise<string | null> {
  const connection = await db.selectFrom("provider_connections")
    .select("external_connection_id")
    .where("workspace_id", "=", workspaceId)
    .where("provider", "=", input.provider)
    .where("id", "=", input.providerConnectionId)
    .where("status", "=", "active")
    .executeTakeFirst();
  return connection?.external_connection_id ?? null;
}

export async function enqueueRoutingRecovery(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: RoutingRecoveryEnqueueInput,
): Promise<{ inserted: boolean; jobId: string } | null> {
  if (!matchesEnqueueScope(workspaceId, input)) return null;
  return await db.transaction().execute(async (trx) => {
    await lockProviderConnectionProjection(trx, workspaceId);
    const repository = await trx
      .selectFrom("repositories")
      .innerJoin("provider_connections", (join) => join
        .onRef("provider_connections.id", "=", "repositories.provider_connection_id")
        .onRef("provider_connections.workspace_id", "=", "repositories.workspace_id")
        .onRef("provider_connections.provider", "=", "repositories.provider"))
      .select("repositories.id")
      .where("repositories.workspace_id", "=", workspaceId)
      .where("repositories.provider", "=", input.provider)
      .where("repositories.provider_connection_id", "=", input.providerConnectionId)
      .where("repositories.external_repository_id", "=", input.payload.changeRequest.repository.externalId)
      .where("repositories.owner", "=", input.payload.changeRequest.repository.owner)
      .where("repositories.name", "=", input.payload.changeRequest.repository.name)
      .where("provider_connections.status", "=", "active")
      .executeTakeFirst();
    if (repository === undefined) return null;

    const inserted = await trx.insertInto("jobs").values({
      workspace_id: workspaceId,
      provider: input.provider,
      provider_connection_id: input.providerConnectionId,
      kind: "process_pull_request",
      payload: input.payload,
      idempotency_key: input.idempotencyKey,
    }).onConflict((conflict) => conflict
      .columns(["workspace_id", "idempotency_key"])
      .doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted !== undefined) return { inserted: true, jobId: inserted.id };

    const existing = await trx.selectFrom("jobs")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("provider", "=", input.provider)
      .where("provider_connection_id", "=", input.providerConnectionId)
      .where("kind", "=", "process_pull_request")
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();
    return existing === undefined ? null : { inserted: false, jobId: existing.id };
  });
}

function matchesEnqueueScope(workspaceId: WorkspaceId, input: RoutingRecoveryEnqueueInput): boolean {
  return input.payload.workspaceId === workspaceId
    && input.payload.providerConnectionId === input.providerConnectionId
    && input.payload.changeRequest.repository.provider === input.provider
    && input.payload.routingKey === input.idempotencyKey;
}

function toRoutingRecoveryTarget(input: {
  provider: ProviderKind;
  provider_connection_id: string;
  external_repository_id: string;
  owner: string;
  name: string;
  change_request_id: string | null;
  pull_number: number | null;
}): RoutingRecoveryTarget | null {
  if (input.change_request_id === null || input.change_request_id.trim().length === 0
    || input.pull_number === null || !Number.isSafeInteger(input.pull_number) || input.pull_number < 1) {
    return null;
  }
  return {
    providerConnectionId: input.provider_connection_id,
    repository: {
      provider: input.provider,
      externalId: input.external_repository_id,
      owner: input.owner,
      name: input.name,
    },
    changeRequestId: input.change_request_id,
    changeRequestNumber: input.pull_number,
  };
}
