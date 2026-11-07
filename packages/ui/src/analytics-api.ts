import type { AnalyticsQuery, AnalyticsReport, CurrentWorkloadReport } from "@triagepilot/contracts";
import type { WorkspaceContext } from "./api.js";

/** Hosts own authentication, transport, and provider identity. */
export interface AnalyticsApiClient {
  readAnalytics(workspace: WorkspaceContext, query: AnalyticsQuery, signal?: AbortSignal): Promise<AnalyticsReport>;
  readCurrentWorkload(
    workspace: WorkspaceContext,
    query: { repositoryIds: string[]; averageReviewMinutes: number; forceRefresh?: boolean },
    signal?: AbortSignal,
  ): Promise<CurrentWorkloadReport>;
}
