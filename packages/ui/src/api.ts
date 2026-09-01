import type { ActionStatus, RepositoryMode, RiskTier, RoutingAction } from "@triagepilot/contracts";

export interface WorkspaceContext {
  id: string;
  displayName: string;
}

export interface AuthorizationCapabilities {
  canViewOperations: boolean;
  canManageConfiguration: boolean;
}

export type NavigationTarget = "configuration";

export interface NavigationHost {
  hrefFor(target: NavigationTarget): string;
}

export interface OperationsApiClient {
  readOperationsOverview(workspace: WorkspaceContext): Promise<OperationsOverview>;
  readEffectiveConfiguration(
    workspace: WorkspaceContext,
    repository: RepositoryContext,
  ): Promise<EffectiveConfigurationOverview>;
}

export interface ProviderLink {
  label: string;
  href: string | null;
}

export interface RepositoryContext {
  id: string;
  repository: ProviderLink;
}

export interface ProviderStatusOverview {
  id: string;
  label: string;
  value: string;
  detail?: string;
  state?: "neutral" | "healthy" | "failed";
}

export interface RepositoryOverview extends RepositoryContext {
  configState: string;
  mode: RepositoryMode;
}

export interface DecisionOverview {
  id: string;
  repository: ProviderLink;
  changeRequest: ProviderLink | null;
  mode: RepositoryMode;
  action: RoutingAction;
  actionStatus: ActionStatus;
  actionError: string | null;
  policyCheckState: "not_started" | "in_progress" | "success" | "failure";
  riskScore: number;
  riskBreakdown: RiskBreakdown | null;
  requestedReviewerCount: number | null;
  reviewerShortfall: number | null;
  selectedReviewer: string | null;
  selectedReviewers: string[];
  createdAt: string;
}

export interface RiskBreakdown {
  classifierVersion: string;
  tier: RiskTier;
  components: Array<{ reason: string; score: number; detail: string }>;
}

export interface JobFailureOverview {
  id: string;
  error: string;
  failedAt: string;
}

export interface ActionFailureOverview {
  decisionId: string;
  repository: ProviderLink;
  error: string;
  failedAt: string;
}

export interface OperationsOverview {
  statuses: ProviderStatusOverview[];
  repositories: RepositoryOverview[];
  decisions: DecisionOverview[];
  failures: {
    jobs: JobFailureOverview[];
    actions: ActionFailureOverview[];
  };
  worker: {
    available: boolean;
    workerId: string | null;
    lastHeartbeatAt: string | null;
  };
}

export interface EffectiveConfigurationOverview {
  repository: ProviderLink;
  trustedPath: string | null;
  trustedRevision: string;
  repositoryRevision: string | null;
  inheritanceMode: "defaults" | "organization" | "replace" | "inherit" | "legacy";
  effectiveHash: string | null;
  values: EffectiveConfigurationValue[];
}

export interface EffectiveConfigurationValue {
  path: string;
  label: string;
  value: unknown;
  source: "default" | "organization" | "repository";
}
