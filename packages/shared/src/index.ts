export const APP_NAME = "TriagePilot";
export const ROUTING_CHECK_NAME = "triagepilot/routing";
export const HUMAN_REVIEW_POLICY_CHECK_NAME = "triagepilot/human-review-policy";

export { formatLog, type LogRecord } from "./logging";

export type RiskTier = "low" | "medium" | "high";
export type RepositoryMode = "shadow" | "enforce";
export type RoutingAction =
  | "policy_approval"
  | "request_human_review"
  | "no_eligible_reviewer"
  | "configuration_failure";
export type ActionStatus = "not_applied" | "pending" | "succeeded" | "failed";
export type GitHubId = string;

export interface ScoreComponent {
  reason: string;
  score: number;
  detail: string;
}

export interface RoutingJobPayload {
  kind: "process_pull_request";
  deliveryId: string;
  installationId: GitHubId;
  repositoryId: GitHubId;
  owner: string;
  repo: string;
  pullNumber: number;
  /** Present on newly accepted jobs; absent only on pre-upgrade queued payloads. */
  baseSha?: string;
  headSha: string;
  /** Present on newly accepted jobs; absent only on pre-upgrade queued payloads. */
  isDraft?: boolean;
  eventName: string;
  /** Stable identity for one pull-request state, including its trusted configuration revision. */
  routingKey?: string;
}

export function buildRoutingKey(input: {
  repositoryId: GitHubId;
  pullNumber: number;
  baseSha: string;
  headSha: string;
}): string {
  return `routing:${input.repositoryId}:${input.pullNumber}:${input.baseSha}:${input.headSha}`;
}

export function legacyRoutingKey(deliveryId: string): string {
  return `legacy:${deliveryId}`;
}

export interface HumanReviewPolicyJobPayload {
  kind: "evaluate_human_review_policy";
  deliveryId: string;
  installationId: GitHubId;
  repositoryId: GitHubId;
  owner: string;
  repo: string;
  pullNumber: number;
}

export type TriagePilotJobPayload = RoutingJobPayload | HumanReviewPolicyJobPayload;

export function trustedBaseSha(payload: RoutingJobPayload): string | undefined {
  const baseSha = payload.baseSha?.trim();
  return baseSha || undefined;
}

export interface GitHubInstallationMetadata {
  githubInstallationId: GitHubId;
  accountLogin: string;
}

export interface GitHubRepositoryMetadata {
  githubRepositoryId: GitHubId;
  owner: string;
  name: string;
}
