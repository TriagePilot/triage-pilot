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
  readEffectiveConfiguration(workspace: WorkspaceContext): Promise<EffectiveConfigurationOverview>;
}

export interface RepositoryOverview {
  id: string;
  owner: string;
  name: string;
  configState: string;
  mode: RepositoryMode;
}

export interface DecisionOverview {
  id: string;
  repository: string;
  pullNumber: number | null;
  mode: RepositoryMode;
  action: RoutingAction;
  actionStatus: ActionStatus;
  actionError: string | null;
  policyCheckState: "not_started" | "in_progress" | "success" | "failure";
  riskScore: number;
  riskBreakdown: RiskBreakdown | null;
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
  repository: string;
  error: string;
  failedAt: string;
}

export interface OperationsOverview {
  organization: string;
  githubApp: {
    appId: string;
    configured: boolean;
    installationId: string | null;
  };
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
