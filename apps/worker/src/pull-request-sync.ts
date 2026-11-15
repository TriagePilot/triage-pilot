import { createPullRequestSyncService } from "@triagepilot/application";
import { claimQueuePullChunk, continueQueuePullChunk, commitQueuePull, completeQueueWork, claimQueueSyncCheckpoint, readQueueSyncRun, commitQueueSyncPage, completeQueueSyncChunk, type QueueInstallationKey, type QueueProjectionKey, type JobLease, type createDatabase } from "@triagepilot/db";
import { createGitHubPullRequestQueueReader, createInstallationRequester, type GitHubAppCredentials } from "@triagepilot/provider-github";
import type { RepositoryRef } from "@triagepilot/contracts";

type Database = ReturnType<typeof createDatabase>;

export function createWorkerPullRequestSync(input: { db: Database; github: GitHubAppCredentials; githubOrganization: string; createRequester?: typeof createInstallationRequester }) {
  const { db } = input;
  async function authorized(scope: QueueInstallationKey, repository?: RepositoryRef) {
    const connection = await db.selectFrom("provider_connections").select("id").where("workspace_id", "=", scope.workspaceId).where("id", "=", scope.providerConnectionId).where("provider", "=", "github").where("status", "=", "active").where("external_connection_id", "=", scope.externalInstallationId)
      .where(eb => eb.not(eb.exists(eb.selectFrom("provider_connection_revocations").select("revoked_connection_id").whereRef("workspace_id", "=", "provider_connections.workspace_id").whereRef("external_connection_id", "=", "provider_connections.external_connection_id").where("provider", "=", "github")))).executeTakeFirst();
    if (!connection) throw new Error("queue authority unavailable");
    if (repository) {
      const row = await db.selectFrom("repositories").select("id").where("workspace_id", "=", scope.workspaceId).where("provider_connection_id", "=", scope.providerConnectionId).where("provider", "=", "github").where("external_repository_id", "=", repository.externalId).where("owner", "=", repository.owner).where("name", "=", repository.name).executeTakeFirst();
      if (!row || ("repositoryId" in scope && row.id !== scope.repositoryId)) throw new Error("queue authority unavailable");
    }
  }
  async function reader(scope: QueueInstallationKey) {
    await authorized(scope);
    const id = Number(scope.externalInstallationId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid installation identity");
    const requester = await (input.createRequester ?? createInstallationRequester)({ ...input.github, installationId: id });
    return createGitHubPullRequestQueueReader(requester);
  }
  const createService = (activeScope: QueueInstallationKey) => createPullRequestSyncService<JobLease, QueueInstallationKey, Awaited<ReturnType<typeof claimQueueSyncCheckpoint>>>({
    now: () => new Date(),
    async resolveRepository(key) {
      await authorized(key);
      const row = await db.selectFrom("repositories").select(["owner", "name"]).where("id", "=", key.repositoryId).where("workspace_id", "=", key.workspaceId).where("provider_connection_id", "=", key.providerConnectionId).where("external_repository_id", "=", key.externalRepositoryId).executeTakeFirstOrThrow();
      return { provider: "github", externalId: key.externalRepositoryId, owner: row.owner, name: row.name };
    },
    assertAuthorized: authorized,
    claimPull: (key, lease) => claimQueuePullChunk(db, key, lease),
    continuePull: (key, token, checkpoint) => continueQueuePullChunk(db, key, token, checkpoint),
    commitPull: (key, token, snapshot) => commitQueuePull(db, key, token, snapshot),
    async readPull(context) { return (await reader(activeScope)).readPullRequest({ ...context, githubOrganization: input.githubOrganization }); },
    async listReviews(context) { return (await reader(activeScope)).listReviewsPage({ ...context, githubOrganization: input.githubOrganization }); },
    async listLifecycle(context) { return (await reader(activeScope)).listLifecyclePage({ ...context, githubOrganization: input.githubOrganization }); },
    async claimRun(scope, runId, lease) { const token = await claimQueueSyncCheckpoint(db, scope, runId, lease); const run = await readQueueSyncRun(db, scope, runId); if (!run) throw new Error("queue run unavailable"); return { token, checkpoint: run.checkpoint }; },
    commitRunPage: (scope, runId, token, checkpoint, effect) => commitQueueSyncPage(db, scope, runId, token, checkpoint, effect),
    async listRepositories(scope, context) { return (await reader(scope)).listRepositoriesPage({ ...context, githubOrganization: input.githubOrganization }); },
    async listPulls(scope, context) { return (await reader(scope)).listOpenPullRequestsPage({ ...context, githubOrganization: input.githubOrganization }); },
  });
  return {
    async refresh(key: QueueProjectionKey, lease: JobLease) {
      const result = await createService(key).refreshPullChunk(key, lease);
      if (result.done && (await completeQueueWork(db, key, lease)).state === "stale_lease") throw new Error("stale queue lease");
    },
    async reconcile(scope: QueueInstallationKey, runId: string, lease: JobLease) {
      const result = await createService(scope).reconcileConnectionChunk(scope, runId, lease);
      if ((await completeQueueSyncChunk(db, scope, runId, lease, result)).state === "stale_lease") throw new Error("stale queue lease");
    },
  };
}
