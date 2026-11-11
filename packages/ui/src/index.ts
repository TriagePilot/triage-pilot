// Keep the composite dashboard export compatible for existing package hosts.
// The self-hosted app uses the dedicated pages exported below.
export {
  OperationsDashboard,
  type OperationsDashboardProps,
} from "./components/OperationsDashboard.js";
export {
  EffectiveConfiguration,
  type EffectiveConfigurationProps,
} from "./components/EffectiveConfiguration.js";
export {
  ReviewerAvailability,
  type ReviewerAvailabilityProps,
} from "./components/ReviewerAvailability.js";
export type {
  ActionFailureOverview,
  AvailabilitySettingsOverview,
  AuthorizationCapabilities,
  DecisionOverview,
  EffectiveConfigurationOverview,
  EffectiveConfigurationValue,
  JobFailureOverview,
  NavigationHost,
  NavigationTarget,
  OperationsApiClient,
  OperationsOverview,
  ProviderLink,
  ProviderStatusOverview,
  RepositoryContext,
  RepositoryOverview,
  RiskBreakdown,
  ReviewerAbsenceMutation,
  ReviewerAbsenceOverview,
  ReviewerReplacementOverview,
  WorkspaceContext,
} from "./api.js";
export { Analytics, type AnalyticsProps } from "./components/Analytics.js";
export { AnalyticsCharts } from "./components/AnalyticsCharts.js";
export type { AnalyticsApiClient } from "./analytics-api.js";
export { PullRequests, type PullRequestsProps } from "./components/PullRequests.js";
export { PullRequestDetails, type PullRequestDetailsProps } from "./components/PullRequestDetails.js";
export { buildPullRequestQueueView, matchedQueueRoles, type PullRequestQueueFilters } from "./pull-request-queue-view.js";
export type { PullRequestQueueApiClient } from "./pull-request-queue-api.js";

export { OverviewPage, RepositoriesPage, RoutingDecisionsPage, SystemHealthPage, type OperationsPageProps, type OperationsPageNavigation, type RoutingDecisionsPageProps } from "./components/OperationsPages.js";
