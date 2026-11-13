import { sql, type Kysely } from "kysely";
import { PullRequestQueueUnavailableError, queuePullRequestKey, type PullRequestQueueScope, type QueueAssessment, type QueuePullRequest, type WorkspaceId } from "@triagepilot/contracts";
import { actors, normalizeAnalyticsDecision } from "./analytics-records.js";
import type { Database } from "./kysely.js";

const issued = new WeakMap<PullRequestQueueScope, { db: Kysely<Database>; signature: string }>();
const unavailable = () => new PullRequestQueueUnavailableError("authority");
async function connection(db: Kysely<Database>, workspaceId: WorkspaceId, org: string) {
  const rows = await db.selectFrom("provider_connections").select(["id", "external_connection_id"]).where("workspace_id", "=", workspaceId).where("provider", "=", "github").where("status", "=", "active").where(sql<boolean>`lower(workspace_login) = lower(${org})`).where(sql<boolean>`lower(account_type) = 'organization'`).execute();
  if (rows.length !== 1) throw unavailable();
  const row = rows[0]!;
  if (await db.selectFrom("provider_connection_revocations").select("revoked_connection_id").where("workspace_id", "=", workspaceId).where("provider", "=", "github").where("external_connection_id", "=", row.external_connection_id).executeTakeFirst()) throw unavailable();
  return row;
}
async function repositories(db: Kysely<Database>, workspaceId: WorkspaceId, connectionId: string, org: string) {
  const rows = await db.selectFrom("repositories").select(["id", "provider", "external_repository_id", "owner", "name"]).where("workspace_id", "=", workspaceId).where("provider", "=", "github").where("provider_connection_id", "=", connectionId).where(sql<boolean>`lower(owner) = lower(${org})`).orderBy("id").execute();
  return rows.map(row => ({ recordId: row.id, repository: { provider: row.provider, externalId: row.external_repository_id, owner: row.owner, name: row.name } }));
}
export async function resolvePullRequestQueueScope(db: Kysely<Database>, workspaceId: WorkspaceId, input: { githubOrganization: string }): Promise<PullRequestQueueScope> {
  const c = await connection(db, workspaceId, input.githubOrganization);
  const scope: PullRequestQueueScope = { workspaceId, providerConnectionId: c.id, externalConnectionId: c.external_connection_id, githubOrganization: input.githubOrganization, knownRepositories: await repositories(db, workspaceId, c.id, input.githubOrganization) };
  issued.set(scope, { db, signature: JSON.stringify(scope) });
  await assertPullRequestQueueScopeActive(db, scope);
  return scope;
}
export async function assertPullRequestQueueScopeActive(db: Kysely<Database>, scope: PullRequestQueueScope): Promise<void> {
  const token = issued.get(scope);
  if (!token || token.db !== db || token.signature !== JSON.stringify(scope)) throw unavailable();
  const c = await connection(db, scope.workspaceId, scope.githubOrganization);
  if (c.id !== scope.providerConnectionId || c.external_connection_id !== scope.externalConnectionId || JSON.stringify(await repositories(db, scope.workspaceId, c.id, scope.githubOrganization)) !== JSON.stringify(scope.knownRepositories)) throw unavailable();
}
export async function readQueueAssessments(db: Kysely<Database>, scope: PullRequestQueueScope, pulls: QueuePullRequest[]): Promise<Map<string, QueueAssessment>> {
  await assertPullRequestQueueScopeActive(db, scope);
  const result = new Map<string, QueueAssessment>();
  const knownByExternalId = new Map(scope.knownRepositories.map(repository => [repository.repository.externalId, repository]));
  const requested = pulls.flatMap(pull => {
    const known = pull.repository.provider === "github" ? knownByExternalId.get(pull.repository.externalId) : undefined;
    return known && Number.isSafeInteger(pull.number) && pull.number > 0
      ? [{ repository_id: known.recordId, pull_number: pull.number }] : [];
  });
  if (requested.length) {
    const rows = await db.selectFrom("routing_decisions").innerJoin("repositories", join => join.onRef("repositories.id", "=", "routing_decisions.repository_id").onRef("repositories.workspace_id", "=", "routing_decisions.workspace_id")).innerJoin("provider_connections", join => join.onRef("provider_connections.id", "=", "repositories.provider_connection_id").onRef("provider_connections.workspace_id", "=", "repositories.workspace_id").onRef("provider_connections.provider", "=", "repositories.provider"))
      .distinctOn(["routing_decisions.repository_id", "routing_decisions.pull_number"])
      .select(["routing_decisions.id", "routing_decisions.repository_id", "routing_decisions.change_request_id", "routing_decisions.pull_number", "routing_decisions.created_at", "routing_decisions.action_applied_at", "routing_decisions.mode", "routing_decisions.action", "routing_decisions.action_status", "routing_decisions.risk_score", "routing_decisions.details", "routing_decisions.head_sha", "routing_decisions.repository_config_revision", "routing_decisions.policy_check_state", "routing_decisions.action_error", "routing_decisions.selected_reviewers", "repositories.external_repository_id", "repositories.provider"])
      // Null provenance remains unknown, including legacy rows without immutable evidence.
      .select(sql<boolean>`routing_decisions.origin_provider_connection_id = ${scope.providerConnectionId}::uuid
        and routing_decisions.origin_external_installation_id = ${scope.externalConnectionId}
        and routing_decisions.origin_external_repository_id = repositories.external_repository_id`.as("origin_proven"))
      .where("routing_decisions.workspace_id", "=", scope.workspaceId).where("repositories.provider", "=", "github").where("repositories.provider_connection_id", "=", scope.providerConnectionId).where("provider_connections.status", "=", "active").where(sql<boolean>`exists (select 1 from jsonb_to_recordset(${JSON.stringify(requested)}::jsonb) as requested(repository_id uuid, pull_number bigint) where requested.repository_id = routing_decisions.repository_id and requested.pull_number = routing_decisions.pull_number)`)
      .orderBy("routing_decisions.repository_id").orderBy("routing_decisions.pull_number").orderBy("routing_decisions.created_at", "desc").orderBy("routing_decisions.id", "desc").execute();
    for (const row of rows) {
      if (row.pull_number === null || !row.origin_proven) continue;
      const key = queuePullRequestKey({ provider: row.provider, externalId: row.external_repository_id, owner: "", name: "" }, row.pull_number);
      const known = scope.knownRepositories.find(r => r.recordId === row.repository_id)!;
      const fact = normalizeAnalyticsDecision({ ...row, change_request_id: row.change_request_id?.trim() || String(row.pull_number), repository_id: known.recordId, changeRequest: { repositoryRecordId: known.recordId, repository: known.repository, providerConnectionId: scope.providerConnectionId, changeRequestId: row.change_request_id ?? "", changeRequestNumber: row.pull_number } });
      if (!fact) continue;
      result.set(key, { decisionId: fact.decisionId, createdAt: fact.createdAt, headRevision: row.head_sha, repositoryConfigRevision: row.repository_config_revision, mode: fact.mode, action: fact.action, actionStatus: fact.actionStatus, policyCheckState: row.policy_check_state, failureReason: row.action_error === null ? null : "Routing action failed", riskTier: fact.riskTier, requiredReviews: fact.requiredReviews, selectedActors: actors(row.selected_reviewers) ?? [] });
    }
  }
  await assertPullRequestQueueScopeActive(db, scope);
  return result;
}
