import { randomUUID } from "node:crypto";
import { createPullRequestQueueService } from "@triagepilot/application";
import { PullRequestQueueUnavailableError, type PullRequestQueueScope, type WorkspaceId } from "@triagepilot/contracts";
import { assertPullRequestQueueScopeActive, readQueueAssessments, readQueueProjection, readWorkerHeartbeat, requestQueueReconciliation, resolvePullRequestQueueScope, type createDatabase } from "@triagepilot/db";
import { githubChangeRequestUrl, type createInstallationRequester, type GitHubAppCredentialShape } from "@triagepilot/provider-github";
import type { PullRequestQueueServices } from "./routes/pull-request-queue.js";

export function createPullRequestQueueRuntime(input: { db: ReturnType<typeof createDatabase>; workspaceId: WorkspaceId; githubOrganization: string; github: GitHubAppCredentialShape; createRequester?: typeof createInstallationRequester; now(): Date }): Pick<PullRequestQueueServices, "readPullRequestQueue"> & { disposePullRequestQueue(): void } {
  const key = (scope: PullRequestQueueScope) => ({ workspaceId: scope.workspaceId, providerConnectionId: scope.providerConnectionId, externalInstallationId: scope.externalConnectionId });
  const service = createPullRequestQueueService({
    now: input.now, createSnapshotId: randomUUID,
    resolveScope: workspaceId => {
      if (workspaceId !== input.workspaceId) throw new PullRequestQueueUnavailableError("authority");
      return resolvePullRequestQueueScope(input.db, workspaceId, { githubOrganization: input.githubOrganization });
    },
    assertActive: scope => assertPullRequestQueueScopeActive(input.db, scope),
    readProjection: scope => readQueueProjection(input.db, key(scope)),
    requestRefresh: scope => requestQueueReconciliation(input.db, key(scope), "manual", input.now()),
    workerAvailable: async () => { const heartbeat = await readWorkerHeartbeat(input.db); return heartbeat !== null && input.now().getTime() - heartbeat.heartbeatAt.getTime() < 60_000; },
    readAssessments: (scope, pulls) => readQueueAssessments(input.db, scope, pulls),
    linksFor: (_scope, pull, assessment) => ({ provider: githubChangeRequestUrl(pull.repository, pull.number), decision: assessment ? "/#decisions" : null }),
  });
  return { readPullRequestQueue: ({ phase: _phase, ...request }) => service.read({ ...request, workspaceId: input.workspaceId }), disposePullRequestQueue: () => service.dispose() };
}
