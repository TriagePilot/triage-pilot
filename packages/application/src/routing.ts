import type { EffectiveConfigurationProvenance, EffectiveConfigurationResult } from "@triagepilot/config";
import {
  type ActionStatus,
  type BranchExclusion,
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
  type ReviewerLoadRequest,
  type ReviewerLoadObservation,
  type TrackedPullRequest,
  type WorkspaceId,
} from "@triagepilot/contracts";
import {
  availableActorsAt,
  decideRouting,
  isBranchExcluded,
  matchOwnership,
  scorePullRequestRisk,
  type ChangedFileMetadata,
  type ReviewerAbsenceWindow,
  type RiskScoringResult,
  type RoutingDecision,
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

export interface PersistedDecisionEventContext extends PersistedDecision {
  occurredAt: Date;
}

export type DecisionEventFactory = (persisted: PersistedDecisionEventContext) => DecisionEventV1;

type BranchExclusionAssessment = {
  risk: null;
  branchExclusion: BranchExclusion;
  expectedBranches: { source: string; target: string };
  expectedBaseRevision: string;
};

export type RoutingActionInput = {
  workspaceId: WorkspaceId;
  providerConnectionId: ProviderConnectionId;
  repository: RepositoryRef;
  changeRequestId: ChangeRequestId;
  changeRequestNumber: number;
  expectedHeadRevision: string;
  decisionId: string;
  selectedActors: ExternalActorId[];
  actorsToRequest: ExternalActorId[];
  noHumanReason?: string;
} & (
  | { action: RoutingAction; risk: RiskScoringResult; branchExclusion?: never }
  | ({ action: "policy_approval" } & BranchExclusionAssessment)
);

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
    applyActions(input: RoutingActionInput): Promise<void>;
  };
  resolveTrackedPullRequest?(job: RoutingJobPayload): Promise<TrackedPullRequest>;
  reviewerBacklog?(input: ReviewerLoadRequest): Promise<ReviewerLoadObservation>;
  reviewerLoad(input: { workspaceId: WorkspaceId; actors: ExternalActorId[] }): Promise<Record<string, number>>;
  availability: {
    findActive(input: {
      workspaceId: WorkspaceId;
      providerConnectionId: ProviderConnectionId;
      actors: ExternalActorId[];
      at: Date;
    }): Promise<ReviewerAbsenceWindow[]>;
  };
  decisions: {
    findCompleted?(job: RoutingJobPayload): Promise<{ decisionId: string; mode: RepositoryMode; actionStatus: "succeeded" } | null>;
    persistWithEvent(input: DecisionInput, event: DecisionEventFactory): Promise<PersistedDecision>;
    markActionSucceeded(decisionId: string, at: Date): Promise<void>;
    markActionFailed(decisionId: string, error: string, at: Date): Promise<void>;
  };
  enqueueReviewPolicy(input: HumanReviewPolicyJobPayload): Promise<void>;
  clock: Clock;
}

export type RoutingOutcome =
  | { status: "skipped"; reason: "draft" | "stale_revision" }
  | { status: "configuration_failure"; decisionId: string }
  | { status: "decided"; decisionId: string; mode: RepositoryMode; actionStatus: ActionStatus };

export async function processChangeRequest(
  job: RoutingJobPayload,
  ports: RoutingApplicationPorts,
): Promise<RoutingOutcome> {
  const completed = await ports.decisions.findCompleted?.(job);
  if (completed) return { status: "decided", ...completed };
  const configuration = await ports.resolveConfiguration(job);
  if (!configuration.ok) {
    const persisted = await ports.decisions.persistWithEvent(
      {
        ...decisionIdentity(job),
        mode: "shadow",
        action: "configuration_failure",
        actionStatus: "not_applied",
        riskScore: 0,
        details: { changeRequestNumber: job.changeRequest.number, diagnostics: configuration.diagnostics },
        ...persistenceProvenance(configuration.provenance, configuration.diagnostics),
      },
      ({ decisionId, occurredAt }) => decisionEvent({
        job,
        decisionId,
        mode: "shadow",
        action: "configuration_failure",
        riskScore: 0,
        selectedActors: [],
        effectiveConfigurationHash: configuration.provenance.effectiveHash ?? "invalid",
        occurredAt,
      }),
    );
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
  let branchExclusion: BranchExclusion | undefined;
  if (config.routing.excludeTargetBranches.includes(metadata.targetBranch)) {
    branchExclusion = { type: "target_branch", branch: metadata.targetBranch, matchingRule: metadata.targetBranch };
  } else {
    const sourceRule = config.routing.excludeSourceBranchPatterns.find(pattern => isBranchExcluded(metadata.sourceBranch, [pattern]));
    if (sourceRule !== undefined) {
      branchExclusion = { type: "source_branch", branch: metadata.sourceBranch, matchingRule: sourceRule };
    }
  }
  if (branchExclusion) {
    const noHumanReason = `Branch exclusion: ${branchExclusion.type === "target_branch" ? "target" : "source"} branch "${branchExclusion.branch}" matches "${branchExclusion.matchingRule}". Risk not evaluated.`;
    const routing: RoutingDecision = {
      action: "policy_approval",
      candidates: [],
      requestedReviewerCount: 0,
      selectedReviewers: [],
      reviewersToRequest: [],
      reviewerShortfall: 0,
      noHumanReason,
      loadSnapshot: {},
    };
    return persistAndApply(job, ports, {
      ...decisionIdentity(job),
      mode: config.mode,
      action: routing.action,
      actionStatus: config.mode === "enforce" ? "pending" : "not_applied",
      // Numeric storage/event compatibility only; this route has no risk assessment.
      riskScore: 0,
      selectedActors: [],
      noHumanReason,
      details: { changeRequestNumber: job.changeRequest.number, risk: null, branchExclusion, routing },
      ...persistenceProvenance(provenance, []),
    }, routing, {
      risk: null,
      branchExclusion,
      expectedBranches: { source: metadata.sourceBranch, target: metadata.targetBranch },
      expectedBaseRevision: provenance.repositoryRevision ?? job.changeRequest.baseRevision,
    });
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
  const availabilityEvaluatedAt = ports.clock.now();
  const availabilityActors = availableActorsAt({
    actors: [...ownership.preferredReviewers, ...ownership.eligibleReviewers],
    absences: [],
    now: availabilityEvaluatedAt,
  });
  const absences = await ports.availability.findActive({
    workspaceId: job.workspaceId,
    providerConnectionId: job.providerConnectionId,
    actors: availabilityActors,
    at: availabilityEvaluatedAt,
  });
  const canonicalEligibleReviewers = availableActorsAt({
    actors: ownership.eligibleReviewers,
    absences: [],
    now: availabilityEvaluatedAt,
  });
  const availableEligibleReviewers = availableActorsAt({
    actors: ownership.eligibleReviewers,
    absences,
    now: availabilityEvaluatedAt,
  });
  const availablePreferredReviewers = availableActorsAt({
    actors: ownership.preferredReviewers,
    absences,
    now: availabilityEvaluatedAt,
  });
  const availableEligibleSet = new Set(availableEligibleReviewers);
  const excludedReviewers = canonicalEligibleReviewers.filter((actor) => !availableEligibleSet.has(actor));
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
  let loadObservation: ReviewerLoadObservation | undefined;
  let load: Record<string, number> = {};
  if (ports.reviewerBacklog && risk.tier !== "low") {
    if (!ports.resolveTrackedPullRequest) throw new Error("Tracked pull request identity port is required for backlog routing");
    loadObservation = await ports.reviewerBacklog({
      workspaceId: job.workspaceId,
      providerConnectionId: job.providerConnectionId,
      actors: availableEligibleReviewers,
      exclude: await ports.resolveTrackedPullRequest(job),
    });
    load = loadObservation.status === "complete" ? loadObservation.loads : {};
  } else if (!ports.reviewerBacklog) {
    load = await ports.reviewerLoad({ workspaceId: job.workspaceId, actors: availableEligibleReviewers });
  }
  const routing = decideRouting({
    risk,
    author: metadata.author,
    preferredReviewers: availablePreferredReviewers,
    eligibleReviewers: availableEligibleReviewers,
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
    details: {
      changeRequestNumber: job.changeRequest.number,
      risk,
      ownership,
      availability: {
        evaluatedAt: availabilityEvaluatedAt.toISOString(),
        excludedReviewers,
      },
      routing: { ...routing, ...(loadObservation === undefined ? {} : { loadObservation }) },
    },
    ...persistenceProvenance(provenance, []),
  };
  if (routing.selectedReviewers.length > 0) decision.selectedActors = routing.selectedReviewers;
  if (routing.noHumanReason !== undefined) decision.noHumanReason = routing.noHumanReason;

  return persistAndApply(job, ports, decision, routing, { risk });
}

async function persistAndApply(
  job: RoutingJobPayload,
  ports: RoutingApplicationPorts,
  decision: DecisionInput,
  routing: RoutingDecision,
  assessment: { risk: RiskScoringResult; branchExclusion?: never } | BranchExclusionAssessment,
): Promise<RoutingOutcome> {
  const { mode } = decision;
  const persisted = await ports.decisions.persistWithEvent(
    decision,
    ({ decisionId, occurredAt }) => decisionEvent({
      job,
      decisionId,
      mode,
      action: routing.action,
      riskScore: decision.riskScore,
      selectedActors: routing.selectedReviewers,
      effectiveConfigurationHash: decision.effectiveConfigHash ?? "invalid",
      ...(assessment.branchExclusion ? { branchExclusion: assessment.branchExclusion } : {}),
      occurredAt,
    }),
  );
  if (persisted.actionStatus === "succeeded") {
    return { status: "decided", decisionId: persisted.decisionId, mode, actionStatus: "succeeded" };
  }

  let actionStatus: ActionStatus = persisted.actionStatus;
  if (mode === "enforce") {
    try {
      await ports.provider.applyActions({
        workspaceId: job.workspaceId,
        providerConnectionId: job.providerConnectionId,
        repository: job.changeRequest.repository,
        changeRequestId: job.changeRequest.externalId,
        changeRequestNumber: job.changeRequest.number,
        expectedHeadRevision: job.changeRequest.headRevision,
        decisionId: persisted.decisionId,
        ...(assessment.risk === null
          ? { action: "policy_approval" as const, ...assessment }
          : { action: routing.action, risk: assessment.risk }),
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

  return { status: "decided", decisionId: persisted.decisionId, mode, actionStatus };
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
  branchExclusion?: BranchExclusion;
  selectedActors: ExternalActorId[];
  effectiveConfigurationHash: string;
  occurredAt: Date;
}): DecisionEventV1 {
  return {
    schemaVersion: 1,
    eventType: "routing_decision",
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
    ...(input.branchExclusion ? { branchExclusion: input.branchExclusion } : {}),
    selectedActors: input.selectedActors,
    effectiveConfigurationHash: input.effectiveConfigurationHash,
  };
}
