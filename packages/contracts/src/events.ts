import type {
  ChangeRequestId,
  ChangeRequestRef,
  ExternalActorId,
  ProviderConnectionId,
  ProviderKind,
  RepositoryId,
  WorkspaceId,
} from "./ids.js";

export type RiskTier = "low" | "medium" | "high";

export interface ScoreComponent {
  reason: string;
  score: number;
  detail: string;
}

export type RepositoryMode = "shadow" | "enforce";
export type RoutingAction =
  | "policy_approval"
  | "request_human_review"
  | "no_eligible_reviewer"
  | "configuration_failure";
export type ActionStatus = "not_applied" | "pending" | "succeeded" | "failed";

export interface NormalizedChangeRequestEvent {
  deliveryId: string;
  eventName: "change_request" | "change_request_review";
  eventAction: string;
  provider: ProviderKind;
  externalConnectionId: string;
  changeRequest: ChangeRequestRef;
  actor: { externalId: ExternalActorId; displayName: string };
  isDraft: boolean;
}

export interface RoutingJobPayload {
  kind: "process_change_request";
  deliveryId: string;
  eventName: string;
  workspaceId: WorkspaceId;
  providerConnectionId: ProviderConnectionId;
  changeRequest: ChangeRequestRef;
  isDraft: boolean;
  routingKey: string;
}

export interface HumanReviewPolicyJobPayload {
  kind: "evaluate_human_review_policy";
  deliveryId: string;
  workspaceId: WorkspaceId;
  providerConnectionId: ProviderConnectionId;
  changeRequest: Pick<ChangeRequestRef, "repository" | "externalId" | "number">;
}

export interface ReviewerAbsenceActivationJobPayload {
  kind: "activate_reviewer_absence";
  workspaceId: WorkspaceId;
  providerConnectionId: ProviderConnectionId;
  absenceId: string;
  absenceRevision: number;
}

export interface DecisionEventV1 {
  schemaVersion: 1;
  eventType: "routing_decision";
  eventId: string;
  occurredAt: string;
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  decisionId: string;
  repositoryId: RepositoryId;
  changeRequestId: ChangeRequestId;
  routingKey: string;
  mode: RepositoryMode;
  action: RoutingAction;
  riskScore: number;
  selectedActors: ExternalActorId[];
  effectiveConfigurationHash: string;
}

export type ReviewerReplacementOutcome =
  | "replaced"
  | "simulated_replacement"
  | "no_replacement_available"
  | "skipped_approved"
  | "skipped_closed"
  | "skipped_changed_head"
  | "skipped_policy_satisfied"
  | "permanent_failure";

export interface ReviewerReplacementEventV1 {
  schemaVersion: 1;
  eventType: "reviewer_replacement";
  eventId: string;
  occurredAt: string;
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  repositoryId: RepositoryId;
  changeRequestId: ChangeRequestId;
  unavailableActor: ExternalActorId;
  replacementActor: ExternalActorId | null;
  outcome: ReviewerReplacementOutcome;
}

export type PlatformEventV1 = DecisionEventV1 | ReviewerReplacementEventV1;

export type TriagePilotJobPayload =
  | RoutingJobPayload
  | HumanReviewPolicyJobPayload
  | ReviewerAbsenceActivationJobPayload;

export function buildReviewerAbsenceActivationKey(absenceId: string, revision: number): string {
  return `reviewer-absence:${absenceId}:revision:${revision}`;
}

export function buildRoutingKey(input: {
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  repositoryId: RepositoryId;
  changeRequestId: ChangeRequestId;
  trustedConfigRevision: string;
  headRevision: string;
  isDraft: boolean;
}): string {
  return `routing:${input.workspaceId}:${input.provider}:${input.repositoryId}:${input.changeRequestId}:${input.trustedConfigRevision}:${input.headRevision}:${input.isDraft ? "draft" : "ready"}`;
}

export function legacyRoutingKey(deliveryId: string): string {
  return `legacy:${deliveryId}`;
}

export function trustedBaseSha(payload: Pick<RoutingJobPayload, "changeRequest">): string | undefined {
  const baseRevision = payload.changeRequest.baseRevision.trim();
  return baseRevision || undefined;
}
