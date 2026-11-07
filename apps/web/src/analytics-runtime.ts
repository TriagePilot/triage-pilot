import { buildAnalyticsReport, createReviewerBacklogService } from "@triagepilot/application";
import type { CurrentWorkloadReport, WorkspaceId } from "@triagepilot/contracts";
import { AnalyticsScopeUnavailableError, ProviderConnectionUnavailableError, assertAnalyticsScopeActive, resolveAnalyticsScope, readTrackedPullRequests, readAnalyticsFacts, type createDatabase } from "@triagepilot/db";
import { createInstallationRequester, GitHubBacklogError, listOpenReviewRequestsWithInstallationProbe, GitHubCredentialProvider, type GitHubAppCredentialShape } from "@triagepilot/provider-github";
import type { AnalyticsServices } from "./routes/analytics.js";

export function createAnalyticsRuntime(input: {
  db: ReturnType<typeof createDatabase>;
  workspaceId: WorkspaceId;
  githubOrganization: string;
  github: GitHubAppCredentialShape;
  createRequester?: typeof createInstallationRequester;
  now(): Date;
}): Pick<AnalyticsServices, "readAnalytics" | "readCurrentWorkload"> {
  const credentials = new GitHubCredentialProvider({ appId: input.github.appId, privateKey: input.github.privateKey });
  const createRequester = input.createRequester ?? createInstallationRequester;
  const resolveScope = (repositoryIds: string[]) => resolveAnalyticsScope(input.db, input.workspaceId, { githubOrganization: input.githubOrganization, repositoryIds });
  const backlog = createReviewerBacklogService({
    now: input.now,
    async loadScope(request) {
      if (request.workspaceId !== input.workspaceId) throw new AnalyticsScopeUnavailableError("Backlog workspace mismatch");
      const scope = await resolveScope(request.repositoryIds);
      if (scope.providerConnectionId !== request.providerConnectionId) throw new AnalyticsScopeUnavailableError("Backlog connection mismatch");
      return scope;
    },
    assertActive: scope => assertAnalyticsScopeActive(input.db, scope),
    readTracked: (scope, window) => readTrackedPullRequests(input.db, scope, window),
    async listOpenReviewRequests(request) {
      await request.assertAuthorized();
      const credential = await credentials.getCredential({ workspaceId: request.scope.workspaceId, providerConnectionId: request.scope.providerConnectionId });
      const installationId = Number(request.scope.externalConnectionId);
      if (!Number.isSafeInteger(installationId) || installationId <= 0 || String(installationId) !== request.scope.externalConnectionId) throw new AnalyticsScopeUnavailableError("Invalid installation identity");
      await request.assertAuthorized();
      const requester = await createRequester({ appId: credential.appId, privateKey: credential.privateKey, installationId }).catch(error => {
        // Token acquisition happens before the adapter can classify HTTP failures.
        // Preserve authorization failures here instead of reporting unknown load.
        if (typeof error === "object" && error !== null && "status" in error) {
          if (error.status === 401) throw new GitHubBacklogError("forbidden");
          if (error.status === 404) throw new GitHubBacklogError("not_found");
          if (error.status === 403) {
            const response = "response" in error ? error.response : null;
            const headers = typeof response === "object" && response !== null && "headers" in response ? response.headers : null;
            const entries = typeof headers === "object" && headers !== null ? Object.entries(headers) : [];
            const rateLimited = entries.some(([key, value]) => key.toLowerCase() === "retry-after" || (key.toLowerCase() === "x-ratelimit-remaining" && String(value) === "0"))
              || ("message" in error && typeof error.message === "string" && /rate limit|secondary limit|abuse|spam/i.test(error.message));
            throw new GitHubBacklogError(rateLimited ? "rate_limited" : "forbidden");
          }
        }
        throw error;
      });
      return listOpenReviewRequestsWithInstallationProbe(requester, request);
    },
    classifyError(error) {
      if (error instanceof AnalyticsScopeUnavailableError || error instanceof ProviderConnectionUnavailableError) return "authority";
      if (error instanceof GitHubBacklogError) {
        if (error.reason === "unauthorized" || error.reason === "forbidden" || error.reason === "not_found") return "authority";
        return error.reason;
      }
      return "provider_unavailable";
    },
  });
  return {
    async readAnalytics(query) {
      const end = input.now();
      const start = new Date(end.getTime() - query.periodDays * 86_400_000);
      const scope = await resolveScope(query.repositoryIds);
      const facts = await readAnalyticsFacts(input.db, scope, { start, end });
      return buildAnalyticsReport({ query, start: start.toISOString(), end: end.toISOString(), scope, facts });
    },
    async readCurrentWorkload(query) {
      const scope = await resolveScope(query.repositoryIds);
      const snapshot = await backlog.readCurrent({ workspaceId: input.workspaceId, providerConnectionId: scope.providerConnectionId, repositoryIds: query.repositoryIds, forceRefresh: query.forceRefresh });
      const complete = snapshot.status === "complete";
      const counts = new Map(snapshot.knownActors.map(actor => [actor.trim().toLowerCase(), 0]));
      for (const pair of snapshot.pairs) counts.set(pair.actor, (counts.get(pair.actor) ?? 0) + 1);
      const totalPending = complete ? snapshot.pairs.length : null;
      const report: CurrentWorkloadReport = {
        status: snapshot.status, observedAt: snapshot.observedAt, trackedSince: snapshot.trackedSince,
        scope: snapshot.scope, coveredRepositoryIds: snapshot.coveredRepositoryIds, unavailableRepositoryIds: snapshot.unavailableRepositoryIds,
        averageReviewMinutes: query.averageReviewMinutes, totalPending,
        totalEstimatedHours: totalPending === null ? null : totalPending * query.averageReviewMinutes / 60,
        rows: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([actor, count]) => ({ actor, pendingCount: complete ? count : null, estimatedHours: complete ? count * query.averageReviewMinutes / 60 : null })),
      };
      // Preserve the DB-issued identity through the application ports and final check.
      await assertAnalyticsScopeActive(input.db, snapshot.scope);
      return report;
    },
  };
}
