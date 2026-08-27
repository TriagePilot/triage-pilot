import type { EffectiveConfigurationProvenance, EffectiveConfigurationResult } from "@triagepilot/config";
import {
  type ActionStatus,
  type ChangeRequestId,
  type Clock,
  type DecisionEventV1,
  type ExternalActorId,
  type HumanReviewPolicyJobPayload,
  type ProviderConnectionId,
  type RepositoryMode,
  type RepositoryRef,
  type RoutingAction,
  type RoutingJobPayload,
  type WorkspaceId,
} from "@triagepilot/contracts";
import {
  decideRouting,
  isBranchExcluded,
  matchOwnership,
  scorePullRequestRisk,
  type ChangedFileMetadata,
  type RiskScoringResult,
} from "@triagepilot/core";

export interface DecisionInput {
  workspaceId: WorkspaceId;
  repository: RepositoryRef;
  deliveryId: string;
  routingKey: string;
  changeRequestId: ChangeRequestId;
  changeRequestNumber: number;
  headRevision: string;
  mode: RepositoryMode;
  action: RoutingAction;
  actionStatus: ActionStatus;
  riskScore: number;
  selectedActors?: ExternalActorId[];
  noHumanReason?: string;
  details: unknown;
  organizationConfigVersion: string | null;
  repositoryConfigPath: string | null;
  repositoryConfigRevision: string | null;
  effectiveConfigHash: string | null;
  inheritanceMode: EffectiveConfigurationProvenance["inheritanceMode"];
  configDiagnostics: unknown[];
  configSources: Record<string, unknown>;
}

export interface PersistedDecision {
  decisionId: string;
  actionStatus: ActionStatus;
  actionError: string | null;
  actionAppliedAt: Date | null;
}

export interface RoutingApplicationPorts {
  resolveConfiguration(job: RoutingJobPayload): Promise<EffectiveConfigurationResult>;
  provider: {
    fetchChangeRequestMetadata(job: RoutingJobPayload): Promise<{
      author: ExternalActorId;
      sourceBranch: string;
      targetBranch: string;
      currentHeadRevision: string;
    }>;
    fetchChangedFiles(job: RoutingJobPayload): Promise<ChangedFileMetadata[]>;
    fetchCommitMessages(job: RoutingJobPayload): Promise<string[]>;
    fetchCurrentRevisionApprovals(job: RoutingJobPayload): Promise<ExternalActorId[]>;
    applyActions(input: {
      workspaceId: WorkspaceId;
      providerConnectionId: ProviderConnectionId;
      repository: RepositoryRef;
      changeRequestId: ChangeRequestId;
      changeRequestNumber: number;
      expectedHeadRevision: string;
      decisionId: string;
      action: RoutingAction;
      risk: RiskScoringResult;
      selectedActors: ExternalActorId[];
      actorsToRequest: ExternalActorId[];
      noHumanReason?: string;
    }): Promise<void>;
  };
  reviewerLoad(input: { workspaceId: WorkspaceId; actors: ExternalActorId[] }): Promise<Record<string, number>>;
  decisions: {
    persist(input: DecisionInput): Promise<PersistedDecision>;
    markActionSucceeded(decisionId: string, at: Date): Promise<void>;
    markActionFailed(decisionId: string, error: string, at: Date): Promise<void>;
  };
  enqueueReviewPolicy(input: HumanReviewPolicyJobPayload): Promise<void>;
  stageDecisionEvent(event: DecisionEventV1): Promise<void>;
  clock: Clock;
}

export type RoutingOutcome =
  | { status: "skipped"; reason: "draft" | "target_branch" | "source_branch" | "stale_revision" }
  | { status: "configuration_failure"; decisionId: string }
  | { status: "decided"; decisionId: string; mode: RepositoryMode; actionStatus: ActionStatus };

export async function processChangeRequest(
  job: RoutingJobPayload,
  ports: RoutingApplicationPorts,
): Promise<RoutingOutcome> {
  const configuration = await ports.resolveConfiguration(job);
  if (!configuration.ok) {
    const persisted = await ports.decisions.persist({
      ...decisionIdentity(job),
      mode: "shadow",
      action: "configuration_failure",
      actionStatus: "not_applied",
      riskScore: 0,
      details: { changeRequestNumber: job.changeRequest.number, diagnostics: configuration.diagnostics },
      ...persistenceProvenance(configuration.provenance, configuration.diagnostics),
    });
    await ports.stageDecisionEvent(decisionEvent({
      job,
      decisionId: persisted.decisionId,
      mode: "shadow",
      action: "configuration_failure",
      riskScore: 0,
      selectedActors: [],
      effectiveConfigurationHash: configuration.provenance.effectiveHash ?? "invalid",
      occurredAt: ports.clock.now(),
    }));
    return { status: "configuration_failure", decisionId: persisted.decisionId };
  }

  const { config, provenance } = configuration;
  if (job.isDraft && !config.routing.includeDraftPullRequests) {
    return { status: "skipped", reason: "draft" };
  }

  const metadata = await ports.provider.fetchChangeRequestMetadata(job);
  if (metadata.currentHeadRevision !== job.changeRequest.headRevision) {
    return { status: "skipped", reason: "stale_revision" };
  }
  if (config.routing.excludeTargetBranches.includes(metadata.targetBranch)) {
    return { status: "skipped", reason: "target_branch" };
  }
  if (isBranchExcluded(metadata.sourceBranch, config.routing.excludeSourceBranchPatterns)) {
    return { status: "skipped", reason: "source_branch" };
  }

  const [changedFiles, commitMessages] = await Promise.all([
    ports.provider.fetchChangedFiles(job),
    ports.provider.fetchCommitMessages(job),
  ]);
  const ownership = matchOwnership({
    files: changedFiles.map((file) => file.path),
    rules: config.ownership.rules,
    fallbackReviewers: config.ownership.fallbackReviewers,
  });
  const load = await ports.reviewerLoad({
    workspaceId: job.workspaceId,
    actors: ownership.eligibleReviewers,
  });
  const risk = scorePullRequestRisk({
    files: changedFiles,
    author: metadata.author,
    branchName: metadata.sourceBranch,
    commitMessages,
    config: config.risk,
  });
  const existingApprovedReviewers = risk.tier === "low"
    ? []
    : await ports.provider.fetchCurrentRevisionApprovals(job);
  const routing = decideRouting({
    risk,
    author: metadata.author,
    eligibleReviewers: ownership.eligibleReviewers,
    existingApprovedReviewers,
    load,
    highRiskReviewers: config.routing.highRiskReviewers,
    selectionKey: `${job.changeRequest.repository.owner}/${job.changeRequest.repository.name}#${job.changeRequest.number}`,
  });
  const initialActionStatus: ActionStatus = config.mode === "enforce" && routing.action !== "no_eligible_reviewer"
    ? "pending"
    : "not_applied";
  const decision: DecisionInput = {
    ...decisionIdentity(job),
    mode: config.mode,
    action: routing.action,
    actionStatus: initialActionStatus,
    riskScore: risk.score,
    details: { changeRequestNumber: job.changeRequest.number, risk, ownership, routing },
    ...persistenceProvenance(provenance, []),
  };
  if (routing.selectedReviewers.length > 0) decision.selectedActors = routing.selectedReviewers;
  if (routing.noHumanReason !== undefined) decision.noHumanReason = routing.noHumanReason;

  const persisted = await ports.decisions.persist(decision);
  await ports.stageDecisionEvent(decisionEvent({
    job,
    decisionId: persisted.decisionId,
    mode: config.mode,
    action: routing.action,
    riskScore: risk.score,
    selectedActors: routing.selectedReviewers,
    effectiveConfigurationHash: provenance.effectiveHash ?? "invalid",
    occurredAt: ports.clock.now(),
  }));
  if (persisted.actionStatus === "succeeded") {
    return { status: "decided", decisionId: persisted.decisionId, mode: config.mode, actionStatus: "succeeded" };
  }

  let actionStatus: ActionStatus = persisted.actionStatus;
  if (config.mode === "enforce") {
    try {
      await ports.provider.applyActions({
        workspaceId: job.workspaceId,
        providerConnectionId: job.providerConnectionId,
        repository: job.changeRequest.repository,
        changeRequestId: job.changeRequest.externalId,
        changeRequestNumber: job.changeRequest.number,
        expectedHeadRevision: job.changeRequest.headRevision,
        decisionId: persisted.decisionId,
        action: routing.action,
        risk,
        selectedActors: routing.selectedReviewers,
        actorsToRequest: routing.reviewersToRequest,
        ...(routing.noHumanReason === undefined ? {} : { noHumanReason: routing.noHumanReason }),
      });
      if (routing.action === "request_human_review") {
        await ports.enqueueReviewPolicy({
          kind: "evaluate_human_review_policy",
          deliveryId: `routing-policy:${job.deliveryId}`,
          workspaceId: job.workspaceId,
          providerConnectionId: job.providerConnectionId,
          changeRequest: {
            repository: job.changeRequest.repository,
            externalId: job.changeRequest.externalId,
            number: job.changeRequest.number,
          },
        });
      }
    } catch (error) {
      await ports.decisions.markActionFailed(
        persisted.decisionId,
        error instanceof Error ? error.message : "provider action failed",
        ports.clock.now(),
      );
      throw error;
    }
    if (persisted.actionStatus === "pending") {
      await ports.decisions.markActionSucceeded(persisted.decisionId, ports.clock.now());
      actionStatus = "succeeded";
    }
  }

  return { status: "decided", decisionId: persisted.decisionId, mode: config.mode, actionStatus };
}

function decisionIdentity(job: RoutingJobPayload): Pick<
  DecisionInput,
  | "workspaceId"
  | "repository"
  | "deliveryId"
  | "routingKey"
  | "changeRequestId"
  | "changeRequestNumber"
  | "headRevision"
> {
  return {
    workspaceId: job.workspaceId,
    repository: job.changeRequest.repository,
    deliveryId: job.deliveryId,
    routingKey: job.routingKey,
    changeRequestId: job.changeRequest.externalId,
    changeRequestNumber: job.changeRequest.number,
    headRevision: job.changeRequest.headRevision,
  };
}

function persistenceProvenance(
  provenance: EffectiveConfigurationProvenance,
  diagnostics: unknown[],
): Pick<
  DecisionInput,
  | "organizationConfigVersion"
  | "repositoryConfigPath"
  | "repositoryConfigRevision"
  | "effectiveConfigHash"
  | "inheritanceMode"
  | "configDiagnostics"
  | "configSources"
> {
  return {
    organizationConfigVersion: provenance.organizationVersion,
    repositoryConfigPath: provenance.repositoryPath,
    repositoryConfigRevision: provenance.repositoryRevision,
    effectiveConfigHash: provenance.effectiveHash,
    inheritanceMode: provenance.inheritanceMode,
    configDiagnostics: diagnostics,
    configSources: provenance.sources,
  };
}

function decisionEvent(input: {
  job: RoutingJobPayload;
  decisionId: string;
  mode: RepositoryMode;
  action: RoutingAction;
  riskScore: number;
  selectedActors: ExternalActorId[];
  effectiveConfigurationHash: string;
  occurredAt: Date;
}): DecisionEventV1 {
  return {
    schemaVersion: 1,
    eventId: `decision:${input.decisionId}:v1`,
    occurredAt: input.occurredAt.toISOString(),
    workspaceId: input.job.workspaceId,
    provider: input.job.changeRequest.repository.provider,
    decisionId: input.decisionId,
    repositoryId: input.job.changeRequest.repository.externalId,
    changeRequestId: input.job.changeRequest.externalId,
    routingKey: input.job.routingKey,
    mode: input.mode,
    action: input.action,
    riskScore: input.riskScore,
    selectedActors: input.selectedActors,
    effectiveConfigurationHash: input.effectiveConfigurationHash,
  };
}
