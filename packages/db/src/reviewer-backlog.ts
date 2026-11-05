import { sql, type Kysely } from "kysely";
import type { AnalyticsRepositoryScope, ExternalActorId, TrackedPullRequest, WorkspaceId } from "@triagepilot/contracts";
import { ProviderConnectionUnavailableError } from "./availability.js";
import type { Database } from "./kysely.js";

export class AnalyticsScopeUnavailableError extends Error {}

// A DTO, copied token, or changed scope cannot grant authority. Recheck the live
// projection on every use of a scope issued by this process.
const issuedScopes = new WeakMap<AnalyticsRepositoryScope, {
  db: Kysely<Database>;
  githubOrganization: string;
  signature: string;
}>();

export async function resolveAnalyticsScope(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  input: { githubOrganization: string; repositoryIds: string[] },
): Promise<AnalyticsRepositoryScope> {
  const connection = await readAuthorizedConnection(db, workspaceId, input.githubOrganization);
  const repositories = await readRepositories(db, workspaceId, connection.id, input.githubOrganization);
  const requested = new Set(input.repositoryIds);
  if ([...requested].some(id => !repositories.some(repository => repository.recordId === id))) {
    throw new AnalyticsScopeUnavailableError("Requested repository is unavailable");
  }
  const scope: AnalyticsRepositoryScope = {
    workspaceId,
    providerConnectionId: connection.id,
    externalConnectionId: connection.external_connection_id,
    repositories: requested.size === 0 ? repositories : repositories.filter(repository => requested.has(repository.recordId)),
  };
  issuedScopes.set(scope, { db, githubOrganization: input.githubOrganization, signature: JSON.stringify(scope) });
  await assertAnalyticsScopeActive(db, scope);
  return scope;
}

export async function assertAnalyticsScopeActive(db: Kysely<Database>, scope: AnalyticsRepositoryScope): Promise<void> {
  const issued = issuedScopes.get(scope);
  if (issued === undefined || issued.db !== db || issued.signature !== JSON.stringify(scope)) {
    throw new AnalyticsScopeUnavailableError("Analytics scope was not issued or has changed");
  }
  const connection = await readAuthorizedConnection(db, scope.workspaceId, issued.githubOrganization);
  if (connection.id !== scope.providerConnectionId || connection.external_connection_id !== scope.externalConnectionId) {
    throw new ProviderConnectionUnavailableError("Analytics provider connection is unavailable");
  }
  const repositories = await readRepositories(db, scope.workspaceId, connection.id, issued.githubOrganization);
  if (scope.repositories.some(repository => !repositories.some(current => JSON.stringify(current) === JSON.stringify(repository)))) {
    throw new AnalyticsScopeUnavailableError("Analytics repository membership has changed");
  }
}

export async function readTrackedPullRequests(
  db: Kysely<Database>,
  scope: AnalyticsRepositoryScope,
  input: { since: Date; end: Date },
): Promise<{ pullRequests: TrackedPullRequest[]; knownActors: ExternalActorId[] }> {
  await assertAnalyticsScopeActive(db, scope);
  if (!Number.isFinite(input.since.getTime()) || !Number.isFinite(input.end.getTime()) || input.since > input.end) {
    throw new RangeError("Invalid tracked pull request interval");
  }
  if (scope.repositories.length === 0) return { pullRequests: [], knownActors: [] };
  const rows = await db.selectFrom("routing_decisions")
    .innerJoin("repositories", join => join
      .onRef("repositories.id", "=", "routing_decisions.repository_id")
      .onRef("repositories.workspace_id", "=", "routing_decisions.workspace_id"))
    .innerJoin("provider_connections", join => join
      .onRef("provider_connections.id", "=", "repositories.provider_connection_id")
      .onRef("provider_connections.workspace_id", "=", "repositories.workspace_id")
      .onRef("provider_connections.provider", "=", "repositories.provider"))
    .select(["repositories.id", "routing_decisions.change_request_id", "routing_decisions.pull_number", "routing_decisions.details"])
    .where("routing_decisions.workspace_id", "=", scope.workspaceId)
    .where("repositories.provider", "=", "github")
    .where("repositories.provider_connection_id", "=", scope.providerConnectionId)
    .where("provider_connections.status", "=", "active")
    .where("repositories.id", "in", scope.repositories.map(repository => repository.recordId))
    .where("routing_decisions.created_at", ">=", input.since)
    .where("routing_decisions.created_at", "<", input.end)
    .orderBy("repositories.id")
    .orderBy("routing_decisions.created_at")
    .orderBy("routing_decisions.id")
    .execute();
  const pullRequests = new Map<string, TrackedPullRequest>();
  const knownActors = new Set<ExternalActorId>();
  for (const row of rows) {
    if (row.change_request_id === null || row.change_request_id.trim() === ""
      || row.pull_number === null || !Number.isSafeInteger(row.pull_number) || row.pull_number <= 0) continue;
    const repository = scope.repositories.find(repository => repository.recordId === row.id)!;
    const identity = JSON.stringify([row.id, row.change_request_id, row.pull_number]);
    pullRequests.set(identity, {
      repositoryRecordId: row.id,
      repository: { ...repository.repository },
      providerConnectionId: scope.providerConnectionId,
      changeRequestId: row.change_request_id,
      changeRequestNumber: row.pull_number,
    });
    for (const actor of readEligibleActors(row.details)) knownActors.add(actor);
  }
  await assertAnalyticsScopeActive(db, scope);
  return { pullRequests: [...pullRequests.values()], knownActors: [...knownActors].sort() };
}

async function readAuthorizedConnection(db: Kysely<Database>, workspaceId: WorkspaceId, githubOrganization: string) {
  const connections = await db.selectFrom("provider_connections")
    .select(["id", "external_connection_id"])
    .where("workspace_id", "=", workspaceId)
    .where("provider", "=", "github")
    .where("status", "=", "active")
    .where(sql<boolean>`lower(workspace_login) = lower(${githubOrganization})`)
    .where(sql<boolean>`lower(account_type) = 'organization'`)
    .execute();
  if (connections.length !== 1) throw new ProviderConnectionUnavailableError("Analytics provider connection is unavailable or ambiguous");
  const connection = connections[0]!;
  const tombstone = await db.selectFrom("provider_connection_revocations")
    .select("revoked_connection_id")
    .where("workspace_id", "=", workspaceId)
    .where("provider", "=", "github")
    .where("external_connection_id", "=", connection.external_connection_id)
    .executeTakeFirst();
  if (tombstone !== undefined) throw new ProviderConnectionUnavailableError("Analytics provider connection is revoked");
  return connection;
}

async function readRepositories(db: Kysely<Database>, workspaceId: WorkspaceId, connectionId: string, githubOrganization: string) {
  const rows = await db.selectFrom("repositories")
    .innerJoin("provider_connections", join => join
      .onRef("provider_connections.id", "=", "repositories.provider_connection_id")
      .onRef("provider_connections.workspace_id", "=", "repositories.workspace_id")
      .onRef("provider_connections.provider", "=", "repositories.provider"))
    .select(["repositories.id", "repositories.provider", "repositories.external_repository_id", "repositories.owner", "repositories.name"])
    .where("repositories.workspace_id", "=", workspaceId)
    .where("repositories.provider", "=", "github")
    .where("repositories.provider_connection_id", "=", connectionId)
    .where("provider_connections.status", "=", "active")
    .where(sql<boolean>`lower(repositories.owner) = lower(${githubOrganization})`)
    .where(sql<boolean>`lower(provider_connections.workspace_login) = lower(${githubOrganization})`)
    .orderBy("repositories.owner").orderBy("repositories.name").orderBy("repositories.id")
    .execute();
  return rows.map(row => ({ recordId: row.id, repository: { provider: row.provider, externalId: row.external_repository_id, owner: row.owner, name: row.name } }));
}

function readEligibleActors(details: unknown): ExternalActorId[] {
  if (typeof details !== "object" || details === null || !("ownership" in details)
    || typeof details.ownership !== "object" || details.ownership === null || !("eligibleReviewers" in details.ownership)) return [];
  const actors = details.ownership.eligibleReviewers;
  return Array.isArray(actors) && actors.every((actor): actor is string => typeof actor === "string" && actor.trim() !== "") ? actors : [];
}
