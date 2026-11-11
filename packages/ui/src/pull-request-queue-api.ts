import type { PullRequestQueueSnapshot } from "@triagepilot/contracts";
import type { WorkspaceContext } from "./api.js";

export interface PullRequestQueueApiClient {
  readPullRequestQueue(workspace: WorkspaceContext, input: { forceRefresh: boolean; phase?: "initial" | "details" }, signal?: AbortSignal): Promise<PullRequestQueueSnapshot>;
}
