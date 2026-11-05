import { createReviewerBacklogService, type ReviewerBacklogService } from "@triagepilot/application";
import type { Clock, CredentialProvider, WorkspaceId } from "@triagepilot/contracts";
import { AnalyticsScopeUnavailableError, ProviderConnectionUnavailableError, assertAnalyticsScopeActive, resolveAnalyticsScope, readTrackedPullRequests, type createDatabase } from "@triagepilot/db";
import { createInstallationRequester, GitHubBacklogError, GitHubAdapter, type GitHubAppCredentials } from "@triagepilot/provider-github";

type DatabaseClient = ReturnType<typeof createDatabase>;
type RequesterFactory = typeof createInstallationRequester;
export function createWorkerReviewerBacklogService(input: {
  db: DatabaseClient;
  workspaceId: WorkspaceId;
  githubOrganization: string;
  credentialProvider: CredentialProvider<GitHubAppCredentials>;
  createRequester: RequesterFactory;
  clock: Clock;
}): ReviewerBacklogService {
  return createReviewerBacklogService({
    now: () => input.clock.now(),
    async loadScope(request) {
      if (request.workspaceId !== input.workspaceId) throw new AnalyticsScopeUnavailableError("Backlog workspace mismatch");
      const scope = await resolveAnalyticsScope(input.db, input.workspaceId, { githubOrganization: input.githubOrganization, repositoryIds: request.repositoryIds });
      if (scope.providerConnectionId !== request.providerConnectionId) throw new AnalyticsScopeUnavailableError("Backlog connection mismatch");
      return scope;
    },
    assertActive: scope => assertAnalyticsScopeActive(input.db, scope),
    readTracked: (scope, window) => readTrackedPullRequests(input.db, scope, window),
    async listOpenReviewRequests(request) {
      await request.assertAuthorized();
      const credential = await input.credentialProvider.getCredential({ workspaceId: request.scope.workspaceId, providerConnectionId: request.scope.providerConnectionId });
      const installationId = Number(request.scope.externalConnectionId);
      if (!Number.isSafeInteger(installationId) || installationId <= 0 || String(installationId) !== request.scope.externalConnectionId) throw new AnalyticsScopeUnavailableError("Invalid installation identity");
      await request.assertAuthorized();
      const requester = await input.createRequester({ ...credential, installationId });
      return new GitHubAdapter(requester).listOpenReviewRequests(request);
    },
    classifyError(error) {
      if (error instanceof AnalyticsScopeUnavailableError || error instanceof ProviderConnectionUnavailableError) return "authority";
      if (error instanceof GitHubBacklogError) {
        if (error.reason === "forbidden" || error.reason === "not_found") return "authority";
        return error.reason;
      }
      return "provider_unavailable";
    },
  });
}
