import { sql, type Kysely, type Transaction } from "kysely";
import type { GitHubId, GitHubInstallationMetadata, GitHubRepositoryMetadata } from "@triagepilot/shared";

import type { Database } from "./kysely";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export interface ConfiguredInstallationInput extends GitHubInstallationMetadata {
  repositories: GitHubRepositoryMetadata[];
}

export interface InstallationRepositoryUpdateInput extends GitHubInstallationMetadata {
  repositoriesAdded: GitHubRepositoryMetadata[];
  repositoryIdsRemoved: GitHubId[];
}

export async function upsertConfiguredInstallation(
  db: Kysely<Database>,
  input: ConfiguredInstallationInput,
): Promise<void> {
  await replaceInstallationRepositories(db, input);
}

export async function activateConfiguredInstallation(
  db: Kysely<Database>,
  input: GitHubInstallationMetadata,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await upsertActiveInstallation(trx, input);
  });
}

export async function replaceInstallationRepositories(
  db: Kysely<Database>,
  input: ConfiguredInstallationInput,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const installationId = await upsertActiveInstallation(trx, input);
    for (const repository of input.repositories) {
      await upsertRepository(trx, installationId, repository);
    }

    let deletion = trx.deleteFrom("repositories").where("installation_id", "=", installationId);
    if (input.repositories.length > 0) {
      deletion = deletion.where(
        "github_repository_id",
        "not in",
        input.repositories.map((repository) => repository.githubRepositoryId),
      );
    }
    await deletion.execute();
  });
}

export async function updateInstallationRepositories(
  db: Kysely<Database>,
  input: InstallationRepositoryUpdateInput,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await lockInstallationProjection(trx);
    const installation = await trx
      .selectFrom("installations")
      .select("id")
      .where("status", "=", "active")
      .where("github_installation_id", "=", input.githubInstallationId)
      .forUpdate()
      .executeTakeFirst();
    if (!installation) return;

    await trx
      .updateTable("installations")
      .set({
        account_login: input.accountLogin,
        account_type: "Organization",
        updated_at: new Date(),
      })
      .where("id", "=", installation.id)
      .execute();
    for (const repository of input.repositoriesAdded) {
      await upsertRepository(trx, installation.id, repository);
    }
    if (input.repositoryIdsRemoved.length > 0) {
      await trx
        .deleteFrom("repositories")
        .where("installation_id", "=", installation.id)
        .where("github_repository_id", "in", input.repositoryIdsRemoved)
        .execute();
    }
  });
}

export async function suspendConfiguredInstallation(
  db: Kysely<Database>,
  input: GitHubInstallationMetadata,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await lockInstallationProjection(trx);
    await trx
      .updateTable("installations")
      .set({
        account_login: input.accountLogin,
        account_type: "Organization",
        status: "suspended",
        updated_at: new Date(),
      })
      .where("github_installation_id", "=", input.githubInstallationId)
      .execute();
  });
}

export async function deleteConfiguredInstallation(
  db: Kysely<Database>,
  input: Pick<GitHubInstallationMetadata, "githubInstallationId">,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await lockInstallationProjection(trx);
    await trx
      .deleteFrom("installations")
      .where("github_installation_id", "=", input.githubInstallationId)
      .execute();
  });
}

export async function upsertDeliveryRepository(
  trx: Transaction<Database>,
  installation: GitHubInstallationMetadata,
  repository: GitHubRepositoryMetadata,
): Promise<string> {
  const installationId = await upsertActiveInstallation(trx, installation);
  return await upsertRepository(trx, installationId, repository);
}

async function upsertActiveInstallation(
  trx: Transaction<Database>,
  input: GitHubInstallationMetadata,
): Promise<string> {
  await lockInstallationProjection(trx);
  const active = await trx
    .selectFrom("installations")
    .select("id")
    .where("status", "=", "active")
    .forUpdate()
    .executeTakeFirst();
  const now = new Date();

  if (active) {
    const updated = await trx
      .updateTable("installations")
      .set({
        github_installation_id: input.githubInstallationId,
        account_login: input.accountLogin,
        account_type: "Organization",
        status: "active",
        updated_at: now,
      })
      .where("id", "=", active.id)
      .returning("id")
      .executeTakeFirstOrThrow();
    return updated.id;
  }

  const inserted = await trx
    .insertInto("installations")
    .values({
      github_installation_id: input.githubInstallationId,
      account_login: input.accountLogin,
      account_type: "Organization",
      status: "active",
      permissions: {},
    })
    .onConflict((conflict) =>
      conflict.column("github_installation_id").doUpdateSet({
        account_login: input.accountLogin,
        account_type: "Organization",
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
  installationId: string,
  repository: GitHubRepositoryMetadata,
): Promise<string> {
  const now = new Date();
  const row = await db
    .insertInto("repositories")
    .values({
      installation_id: installationId,
      github_repository_id: repository.githubRepositoryId,
      owner: repository.owner,
      name: repository.name,
      default_branch: null,
      config_state: "unknown",
    })
    .onConflict((conflict) =>
      conflict.column("github_repository_id").doUpdateSet({
        installation_id: installationId,
        owner: repository.owner,
        name: repository.name,
        updated_at: now,
      }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function lockInstallationProjection(trx: Transaction<Database>): Promise<void> {
  await sql`select pg_advisory_xact_lock(764737450)`.execute(trx);
}
