export const APP_NAME = "TriagePilot";
export const ROUTING_CHECK_NAME = "triagepilot/routing";
export const HUMAN_REVIEW_POLICY_CHECK_NAME = "triagepilot/human-review-policy";

export { formatLog, type LogRecord } from "./logging";

export type GitHubId = string;

export interface GitHubInstallationMetadata {
  githubInstallationId: GitHubId;
  accountLogin: string;
}

export interface GitHubRepositoryMetadata {
  githubRepositoryId: GitHubId;
  owner: string;
  name: string;
}
