import type { PullRequestQueueSnapshot } from "@triagepilot/contracts";
import type { WorkspaceContext } from "./api.js";

export interface PullRequestQueueApiClient {
  readPullRequestQueue(workspace: WorkspaceContext, input: { forceRefresh: boolean }, signal?: AbortSignal): Promise<PullRequestQueueSnapshot>;
}
