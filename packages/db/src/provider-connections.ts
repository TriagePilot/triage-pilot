import { sql, type Kysely, type Transaction } from "kysely";
import type { ProviderConnectionId, ProviderKind, RepositoryId, WorkspaceId } from "@triagepilot/contracts";

import type { Database } from "./kysely";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export interface ProviderConnectionMetadata {
  provider: ProviderKind;
  externalConnectionId: string;
  workspaceLogin: string;
  accountType: string;
}

export interface ProviderRepositoryMetadata {
  provider: ProviderKind;
  externalRepositoryId: RepositoryId;
  owner: string;
  name: string;
}

export interface ConfiguredProviderConnectionInput extends ProviderConnectionMetadata {
  repositories: ProviderRepositoryMetadata[];
}

export interface ProviderConnectionRepositoryUpdateInput extends ProviderConnectionMetadata {
  repositoriesAdded: ProviderRepositoryMetadata[];
  repositoryIdsRemoved: RepositoryId[];
}

export async function upsertConfiguredProviderConnection(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: ConfiguredProviderConnectionInput,
): Promise<void> {
  await replaceProviderConnectionRepositories(db, workspaceId, input);
}

export async function activateConfiguredProviderConnection(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: ProviderConnectionMetadata,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await upsertActiveProviderConnection(trx, workspaceId, input);
  });
}

export async function replaceProviderConnectionRepositories(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: ConfiguredProviderConnectionInput,
): Promise<void> {
  assertRepositoryProviders(input.provider, input.repositories);
  await db.transaction().execute(async (trx) => {
    const providerConnectionId = await upsertActiveProviderConnection(trx, workspaceId, input);
    for (const repository of input.repositories) {
      await upsertRepository(trx, workspaceId, providerConnectionId, repository);
    }

    let deletion = trx
      .deleteFrom("repositories")
      .where("workspace_id", "=", workspaceId)
      .where("provider_connection_id", "=", providerConnectionId);
    if (input.repositories.length > 0) {
      deletion = deletion.where(
        "external_repository_id",
        "not in",
        input.repositories.map((repository) => repository.externalRepositoryId),
      );
    }
    await deletion.execute();
  });
}

export async function updateProviderConnectionRepositories(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: ProviderConnectionRepositoryUpdateInput,
): Promise<void> {
  assertRepositoryProviders(input.provider, input.repositoriesAdded);
  await db.transaction().execute(async (trx) => {
    await lockProviderConnectionProjection(trx, workspaceId);
    const connection = await trx
      .selectFrom("provider_connections")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("provider", "=", input.provider)
      .where("status", "=", "active")
      .where("external_connection_id", "=", input.externalConnectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!connection) return;

    await trx
      .updateTable("provider_connections")
      .set({
        workspace_login: input.workspaceLogin,
        account_type: input.accountType,
        updated_at: new Date(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", connection.id)
      .execute();
    for (const repository of input.repositoriesAdded) {
      await upsertRepository(trx, workspaceId, connection.id, repository);
    }
    if (input.repositoryIdsRemoved.length > 0) {
      await trx
        .deleteFrom("repositories")
        .where("workspace_id", "=", workspaceId)
        .where("provider_connection_id", "=", connection.id)
        .where("provider", "=", input.provider)
        .where("external_repository_id", "in", input.repositoryIdsRemoved)
        .execute();
    }
  });
}

export async function suspendConfiguredProviderConnection(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: ProviderConnectionMetadata,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await lockProviderConnectionProjection(trx, workspaceId);
    await trx
      .updateTable("provider_connections")
      .set({
        workspace_login: input.workspaceLogin,
        account_type: input.accountType,
        status: "suspended",
        updated_at: new Date(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("provider", "=", input.provider)
      .where("external_connection_id", "=", input.externalConnectionId)
      .execute();
  });
}

export async function deleteConfiguredProviderConnection(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: Pick<ProviderConnectionMetadata, "provider" | "externalConnectionId">,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await lockProviderConnectionProjection(trx, workspaceId);
    await trx
      .deleteFrom("provider_connections")
      .where("workspace_id", "=", workspaceId)
      .where("provider", "=", input.provider)
      .where("external_connection_id", "=", input.externalConnectionId)
      .execute();
  });
}

export async function upsertDeliveryRepository(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
  connection: ProviderConnectionMetadata,
  repository: ProviderRepositoryMetadata,
): Promise<{ providerConnectionId: ProviderConnectionId; repositoryId: string }> {
  assertRepositoryProviders(connection.provider, [repository]);
  const providerConnectionId = await upsertActiveProviderConnection(trx, workspaceId, connection);
  const repositoryId = await upsertRepository(trx, workspaceId, providerConnectionId, repository);
  return { providerConnectionId, repositoryId };
}

async function upsertActiveProviderConnection(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
  input: ProviderConnectionMetadata,
): Promise<ProviderConnectionId> {
  await lockProviderConnectionProjection(trx, workspaceId);
  const active = await trx
    .selectFrom("provider_connections")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("status", "=", "active")
    .forUpdate()
    .executeTakeFirst();
  const now = new Date();

  if (active) {
    const updated = await trx
      .updateTable("provider_connections")
      .set({
        provider: input.provider,
        external_connection_id: input.externalConnectionId,
        workspace_login: input.workspaceLogin,
        account_type: input.accountType,
        status: "active",
        updated_at: now,
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", active.id)
      .returning("id")
      .executeTakeFirstOrThrow();
    return updated.id;
  }

  const inserted = await trx
    .insertInto("provider_connections")
    .values({
      workspace_id: workspaceId,
      provider: input.provider,
      external_connection_id: input.externalConnectionId,
      workspace_login: input.workspaceLogin,
      account_type: input.accountType,
      status: "active",
      permissions: {},
    })
    .onConflict((conflict) =>
      conflict.columns(["workspace_id", "provider", "external_connection_id"]).doUpdateSet({
        workspace_login: input.workspaceLogin,
        account_type: input.accountType,
        status: "active",
        updated_at: now,
      }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return inserted.id;
}

async function upsertRepository(
  db: DatabaseExecutor,
  workspaceId: WorkspaceId,
  providerConnectionId: ProviderConnectionId,
  repository: ProviderRepositoryMetadata,
): Promise<string> {
  const now = new Date();
  const row = await db
    .insertInto("repositories")
    .values({
      workspace_id: workspaceId,
      provider: repository.provider,
      provider_connection_id: providerConnectionId,
      external_repository_id: repository.externalRepositoryId,
      owner: repository.owner,
      name: repository.name,
      default_branch: null,
      config_state: "unknown",
    })
    .onConflict((conflict) =>
      conflict.columns(["workspace_id", "provider", "external_repository_id"]).doUpdateSet({
        provider_connection_id: providerConnectionId,
        owner: repository.owner,
        name: repository.name,
        updated_at: now,
      }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function lockProviderConnectionProjection(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 764737450))`.execute(trx);
}

function assertRepositoryProviders(
  connectionProvider: ProviderKind,
  repositories: ProviderRepositoryMetadata[],
): void {
  if (repositories.some((repository) => repository.provider !== connectionProvider)) {
    throw new Error("repository provider must match its provider connection");
  }
}
