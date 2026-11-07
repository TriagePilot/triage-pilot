import { createReviewerBacklogService, type ReviewerBacklogService } from "@triagepilot/application";
import type { Clock, CredentialProvider, WorkspaceId } from "@triagepilot/contracts";
import { AnalyticsScopeUnavailableError, ProviderConnectionUnavailableError, assertAnalyticsScopeActive, resolveAnalyticsScope, readTrackedPullRequests, type createDatabase } from "@triagepilot/db";
import { createInstallationRequester, GitHubBacklogError, listOpenReviewRequestsWithInstallationProbe, type GitHubAppCredentials } from "@triagepilot/provider-github";

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
  const requesters = new WeakMap<object, Promise<Awaited<ReturnType<RequesterFactory>>>>();
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
      let requesterPromise = requesters.get(request.acquisition);
      if (!requesterPromise) {
        requesterPromise = (async () => {
          const credential = await input.credentialProvider.getCredential({ workspaceId: request.scope.workspaceId, providerConnectionId: request.scope.providerConnectionId });
          const installationId = Number(request.scope.externalConnectionId);
          if (!Number.isSafeInteger(installationId) || installationId <= 0 || String(installationId) !== request.scope.externalConnectionId) throw new AnalyticsScopeUnavailableError("Invalid installation identity");
          await request.assertAuthorized();
          return input.createRequester({ ...credential, installationId });
        })();
        requesters.set(request.acquisition, requesterPromise);
      }
      const requester = await requesterPromise;
      return listOpenReviewRequestsWithInstallationProbe(requester, request);
    },
    classifyError(error) {
      if (error instanceof AnalyticsScopeUnavailableError || error instanceof ProviderConnectionUnavailableError) return "authority";
      if (error instanceof GitHubBacklogError) {
        if (error.reason === "unauthorized" || error.reason === "forbidden" || error.reason === "not_found") return "authority";
        return error.reason;
      }
      // Credential/token acquisition can fail before the GitHub adapter boundary.
      if (typeof error === "object" && error !== null && "status" in error) {
        if (error.status === 401 || error.status === 404) return "authority";
        if (error.status === 403) {
          const response = "response" in error ? error.response : null;
          const headers = typeof response === "object" && response !== null && "headers" in response ? response.headers : null;
          const entries = typeof headers === "object" && headers !== null ? Object.entries(headers) : [];
          const rateLimited = entries.some(([key, value]) => key.toLowerCase() === "retry-after"
            || (key.toLowerCase() === "x-ratelimit-remaining" && String(value) === "0"))
            || ("message" in error && typeof error.message === "string" && /rate limit|secondary limit|abuse|spam/i.test(error.message));
          return rateLimited ? "rate_limited" : "authority";
        }
      }
      return "provider_unavailable";
    },
  });
}
