import type { ActionStatus, RepositoryMode, RiskTier, RoutingAction } from "./events.js";
import type { ExternalActorId } from "./ids.js";
import type { AnalyticsRepositoryScope, CurrentBacklogSnapshot, TrackedPullRequest } from "./reviewer-backlog.js";

export type AnalyticsPeriodDays = 7 | 30 | 90;
export type RequestedAnalyticsMode = RepositoryMode | "auto";
export interface AnalyticsQuery {
  periodDays: AnalyticsPeriodDays;
  mode: RequestedAnalyticsMode;
  repositoryIds: string[];
  averageReviewMinutes: number;
}
export interface AnalyticsDecisionFact {
  decisionId: string;
  changeRequest: TrackedPullRequest;
  createdAt: string;
  actionAppliedAt: string | null;
  mode: RepositoryMode;
  action: RoutingAction;
  actionStatus: ActionStatus;
  riskScore: number | null;
  riskTier: RiskTier | null;
  requiredReviews: 0 | 1 | 2 | null;
}
export interface ReviewerAssignmentFact {
  changeRequest: TrackedPullRequest;
  actor: ExternalActorId;
  occurredAt: string;
  mode: RepositoryMode;
  source: "routing" | "replacement";
}
export interface AnalyticsFacts {
  latestDecisions: AnalyticsDecisionFact[];
  assignments: ReviewerAssignmentFact[];
  knownActors: ExternalActorId[];
  coverage: { unidentifiedDecisions: number; unknownOriginalAssignments: number };
}
export interface AnalyticsReport {
  query: AnalyticsQuery;
  mode: RepositoryMode;
  start: string;
  end: string;
  repositories: AnalyticsRepositoryScope["repositories"];
  counts: {
    assessed: number;
    couldNotAssess: number;
    humanRequired: number;
    noHumanRequired: number;
    unknownRequirements: number;
    riskLow: number;
    riskMedium: number;
    riskHigh: number;
    riskUnknown: number;
  };
  noHumanSharePercent: number | null;
  savings: {
    eligiblePrs: number;
    excludedPrs: number;
    baselineReviews: number;
    requiredReviews: number;
    netFewerReviews: number;
    estimatedHoursSaved: number;
    reductionPercent: number | null;
  };
  assignments: Array<{ actor: ExternalActorId; count: number; sharePercent: number; days: Array<{ day: string; count: number }> }>;
  coverage: AnalyticsFacts["coverage"];
}
export interface CurrentWorkloadReport {
  status: CurrentBacklogSnapshot["status"];
  observedAt: CurrentBacklogSnapshot["observedAt"];
  trackedSince: CurrentBacklogSnapshot["trackedSince"];
  scope: CurrentBacklogSnapshot["scope"];
  coveredRepositoryIds: CurrentBacklogSnapshot["coveredRepositoryIds"];
  unavailableRepositoryIds: CurrentBacklogSnapshot["unavailableRepositoryIds"];
  averageReviewMinutes: number;
  totalPending: number | null;
  totalEstimatedHours: number | null;
  rows: Array<{ actor: ExternalActorId; pendingCount: number | null; estimatedHours: number | null }>;
}
