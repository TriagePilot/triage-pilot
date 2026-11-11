import { randomUUID } from "node:crypto";
import { createPullRequestQueueService, type PullRequestQueueContext } from "@triagepilot/application";
import { PullRequestQueueUnavailableError, type PullRequestQueueScope, type WorkspaceId } from "@triagepilot/contracts";
import { assertPullRequestQueueScopeActive, readQueueAssessments, resolvePullRequestQueueScope, type createDatabase } from "@triagepilot/db";
import { createGitHubPullRequestQueueReader, createInstallationRequester, GitHubCredentialProvider, githubChangeRequestUrl, type GitHubAppCredentialShape } from "@triagepilot/provider-github";
import type { PullRequestQueueServices } from "./routes/pull-request-queue.js";

export function createPullRequestQueueRuntime(input: {
  db: ReturnType<typeof createDatabase>;
  workspaceId: WorkspaceId;
  githubOrganization: string;
  github: GitHubAppCredentialShape;
  createRequester?: typeof createInstallationRequester;
  now(): Date;
}): Pick<PullRequestQueueServices, "readPullRequestQueue"> & { disposePullRequestQueue(): void } {
  const credentials = new GitHubCredentialProvider(input.github);
  const createRequester = input.createRequester ?? createInstallationRequester;
  async function reader(scope: PullRequestQueueScope, context: PullRequestQueueContext) {
    context.signal.throwIfAborted();
    await context.assertAuthorized();
    const installationId = Number(scope.externalConnectionId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0 || String(installationId) !== scope.externalConnectionId) throw new PullRequestQueueUnavailableError("authority");
    const credential = await credentials.getCredential({ workspaceId: scope.workspaceId, providerConnectionId: scope.providerConnectionId });
    await context.assertAuthorized();
    context.signal.throwIfAborted();
    let requester: Awaited<ReturnType<typeof createRequester>>;
    try { requester = await createRequester({ appId: credential.appId, privateKey: credential.privateKey, installationId }); }
    catch (error) { throw tokenError(error); }
    context.signal.throwIfAborted();
    await context.assertAuthorized();
    return createGitHubPullRequestQueueReader(requester);
  }
  const service = createPullRequestQueueService({
    now: input.now,
    createSnapshotId: randomUUID,
    resolveScope: workspaceId => {
      if (workspaceId !== input.workspaceId) throw new PullRequestQueueUnavailableError("authority");
      return resolvePullRequestQueueScope(input.db, workspaceId, { githubOrganization: input.githubOrganization });
    },
    assertActive: scope => assertPullRequestQueueScopeActive(input.db, scope),
    readAssessments: (scope, pulls) => readQueueAssessments(input.db, scope, pulls),
    async listRepositories(scope, context) {
      return (await reader(scope, context)).listRepositories({ ...context, githubOrganization: scope.githubOrganization });
    },
    async listOpenPullRequests(scope, repository, context) {
      return (await reader(scope, context)).listOpenPullRequests({ ...context, githubOrganization: scope.githubOrganization, repository });
    },
    async readReviewState(scope, pullRequest, includeLifecycle, context) {
      return (await reader(scope, context)).readReviewState({ ...context, githubOrganization: scope.githubOrganization, pullRequest, includeLifecycle });
    },
    linksFor: (_scope, pull, assessment) => ({ provider: githubChangeRequestUrl(pull.repository, pull.number), decision: assessment ? "/#decisions" : null }),
  });
  return {
    readPullRequestQueue: ({ phase, ...request }) => phase === "initial"
      ? service.readInitial({ ...request, workspaceId: input.workspaceId })
      : service.read({ ...request, progressive: phase === "details", workspaceId: input.workspaceId }),
    disposePullRequestQueue: () => service.dispose(),
  };
}

// Token acquisition precedes the provider reader, so classify its failures here too.
function tokenError(error: unknown): PullRequestQueueUnavailableError {
  if (typeof error !== "object" || error === null) return new PullRequestQueueUnavailableError("provider_unavailable");
  const value = error as { status?: number; message?: unknown; response?: { headers?: Record<string, unknown> } };
  const headers = Object.entries(value.response?.headers ?? {});
  const limited = headers.some(([key, value]) => key.toLowerCase() === "retry-after" || (key.toLowerCase() === "x-ratelimit-remaining" && String(value) === "0")) || (typeof value.message === "string" && /rate limit|secondary limit|abuse|spam/i.test(value.message));
  if (value.status === 429 || ((value.status === 403 || value.status === 422) && limited)) return new PullRequestQueueUnavailableError("rate_limited");
  return new PullRequestQueueUnavailableError(value.status === 401 || value.status === 403 || value.status === 404 ? "authority" : "provider_unavailable");
}
