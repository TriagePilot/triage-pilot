import type {
  ChangeRequestId,
  Clock,
  ExternalActorId,
  ProviderConnectionId,
  ProviderKind,
  RepositoryMode,
  RepositoryRef,
  ReviewerAbsenceActivationJobPayload,
  ReviewerReplacementEventV1,
  ReviewerReplacementOutcome,
  WorkspaceId,
} from "@triagepilot/contracts";
import {
  activeApprovedReviewers,
  selectReplacement,
  type ReviewMetadata,
  type ReviewerAbsenceWindow,
} from "@triagepilot/core";

const NO_REPLACEMENT_POLICY_SUMMARY = "No replacement is available for an absent required reviewer.";

export interface ReviewerReplacementCandidateDecision {
  decisionId: string;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  repository: RepositoryRef;
  changeRequestId: ChangeRequestId;
  changeRequestNumber: number;
  routedHeadRevision: string;
  mode: RepositoryMode;
  selectedActors: ExternalActorId[];
  originalPreferredActors: ExternalActorId[];
  originalEligibleActors: ExternalActorId[];
  requestedReviewerCount: 1 | 2;
  policyCheckState: "not_started" | "in_progress" | "success" | "failure";
}

export interface ReviewerAbsenceActivation {
  absenceId: string;
  revision: number;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  externalActorId: ExternalActorId;
  startAt: Date;
  endAt: Date;
  candidates: ReviewerReplacementCandidateDecision[];
}

export interface ReviewerReplacementProviderState {
  state: "open" | "closed" | string;
  currentHeadRevision: string;
  authorActor: ExternalActorId;
  requestedActors: ExternalActorId[];
  reviews: ReviewMetadata[];
}

export type ReviewerReplacementState = "finalizer_pending" | "completed" | "permanent_failure";

export interface PersistReviewerReplacementInput {
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  expectedHeadRevision: string;
  unavailableActorId: ExternalActorId;
  replacementActorId: ExternalActorId | null;
  outcome: ReviewerReplacementOutcome;
  reason: string;
  state: ReviewerReplacementState;
  lastError: string | null;
  startedAt: Date;
  completedAt: Date;
  replaceCohort: boolean;
  event: ReviewerReplacementEventV1;
}

export interface ReviewerReplacementFinalizerRecord {
  id: string;
  decisionId: string;
  replacementActorId?: ExternalActorId | null;
  outcome: ReviewerReplacementOutcome;
  state: "finalizer_pending";
}

export interface PersistReviewerReplacementResult {
  inserted: boolean;
  activationCurrent: boolean;
  replacement: { id: string; state: ReviewerReplacementState } | null;
}

export type ReviewerReplacementFinalizerAction = {
  action: "reevaluate_policy" | "fail_policy";
  decisionId: string;
  summary: string | null;
};

export interface ReviewerReplacementFinalizerRecovery {
  kind: "reviewer_replacement_finalizer";
  phase: "persist_replacement" | "run_finalizer" | "complete_replacement";
  job: ReviewerAbsenceActivationJobPayload;
  finalizer: ReviewerReplacementFinalizerAction | null;
  replacementId: string | null;
  providerEffectsApplied: boolean;
  persistence: PersistReviewerReplacementInput | null;
  lastError: string;
}

export interface ReviewerAvailabilityPorts {
  clock: Clock;
  availability: {
    listPendingFinalizers(input: {
      absenceId: string;
      absenceRevision: number;
    }): Promise<ReviewerReplacementFinalizerRecord[]>;
    loadActivation(absenceId: string, revision: number): Promise<ReviewerAbsenceActivation | null>;
    findActive(input: {
      workspaceId: WorkspaceId;
      providerConnectionId: ProviderConnectionId;
      actors: ExternalActorId[];
      at: Date;
    }): Promise<ReviewerAbsenceWindow[]>;
    persistReplacement(input: PersistReviewerReplacementInput): Promise<PersistReviewerReplacementResult>;
    updateReplacementState(input: {
      replacementId: string;
      expectedState: ReviewerReplacementState;
      state: ReviewerReplacementState;
      lastError: string | null;
    }): Promise<{ id: string; state: ReviewerReplacementState } | null>;
  };
  provider: {
    inspectChangeRequest(input: ReviewerReplacementTarget): Promise<ReviewerReplacementProviderState>;
    reconcileReviewRequest(input: ReviewerReplacementTarget & {
      unavailableActor: ExternalActorId;
      replacementActor: ExternalActorId;
    }): Promise<{ changed: boolean }>;
    classifyError(error: unknown): {
      kind: "permanent" | "retryable";
      message: string;
    };
  };
  reviewerLoad(input: {
    workspaceId: WorkspaceId;
    actors: ExternalActorId[];
  }): Promise<Record<string, number>>;
  finalizers: {
    run(input: {
      workspaceId: WorkspaceId;
      providerConnectionId: ProviderConnectionId;
      decisionId: string;
      action: ReviewerReplacementFinalizerAction["action"];
      summary: string | null;
    }): Promise<void>;
  };
}

export interface ReviewerReplacementTarget {
  workspaceId: WorkspaceId;
  providerConnectionId: ProviderConnectionId;
  repository: RepositoryRef;
  changeRequestId: ChangeRequestId;
  changeRequestNumber: number;
}

export interface ReviewerAbsenceActivationResult {
  decisionId: string;
  outcome: ReviewerReplacementOutcome;
  replacementActor: ExternalActorId | null;
  finalized: boolean;
}

export type ReviewerAbsenceActivationOutcome =
  | {
    status: "skipped";
    reason: "stale_activation" | "inactive_activation" | "final_revalidation";
    results: ReviewerAbsenceActivationResult[];
  }
  | { status: "completed"; results: ReviewerAbsenceActivationResult[] }
  | {
    status: "finalizer_pending";
    results: ReviewerAbsenceActivationResult[];
    recovery: ReviewerReplacementFinalizerRecovery;
  };

type PlannedReplacement = {
  outcome: ReviewerReplacementOutcome;
  replacementActor: ExternalActorId | null;
  reason: string;
  replaceCohort: boolean;
  finalizer: ReviewerReplacementFinalizerAction | null;
  providerIntent: "none" | "apply" | "recovered";
};

type SelectionContext = {
  absences: ReviewerAbsenceWindow[];
  load: Record<string, number>;
};

export async function activateReviewerAbsence(
  job: ReviewerAbsenceActivationJobPayload,
  ports: ReviewerAvailabilityPorts,
): Promise<ReviewerAbsenceActivationOutcome> {
  const startedAt = ports.clock.now();
  const results: ReviewerAbsenceActivationResult[] = [];

  const pending = await ports.availability.listPendingFinalizers({
    absenceId: job.absenceId,
    absenceRevision: job.absenceRevision,
  });
  for (const record of pending) {
    const replay = await replayPendingFinalizer(job, record, ports);
    if (replay.recovery !== null) {
      return { status: "finalizer_pending", results, recovery: replay.recovery };
    }
    results.push({
      decisionId: record.decisionId,
      outcome: record.outcome,
      replacementActor: record.replacementActorId ?? null,
      finalized: true,
    });
  }

  const activation = await ports.availability.loadActivation(job.absenceId, job.absenceRevision);
  if (activation === null) return { status: "skipped", reason: "stale_activation", results };
  if (
    activation.providerConnectionId !== job.providerConnectionId
    || activation.absenceId !== job.absenceId
    || activation.revision !== job.absenceRevision
  ) return { status: "skipped", reason: "stale_activation", results };
  if (activation.startAt > startedAt || activation.endAt <= startedAt) {
    return { status: "skipped", reason: "inactive_activation", results };
  }

  for (const candidate of activation.candidates) {
    const processed = await processCandidate(job, activation, candidate, startedAt, ports);
    if ("recovery" in processed) {
      return { status: "finalizer_pending", results, recovery: processed.recovery };
    }
    if (processed.result === null) {
      return { status: "skipped", reason: "final_revalidation", results };
    }
    results.push(processed.result);
  }
  return { status: "completed", results };
}

async function processCandidate(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  startedAt: Date,
  ports: ReviewerAvailabilityPorts,
): Promise<
  | { result: ReviewerAbsenceActivationResult | null }
  | { recovery: ReviewerReplacementFinalizerRecovery }
> {
  const read = await readCandidatePlan(job, activation, candidate, startedAt, ports);
  const applied = await applyCandidatePlan(job, activation, candidate, startedAt, read, ports);
  return await finalizeCandidatePlan(
    job,
    activation,
    candidate,
    startedAt,
    applied.plan,
    applied.providerEffectsApplied,
    ports,
  );
}

async function readCandidatePlan(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  startedAt: Date,
  ports: ReviewerAvailabilityPorts,
): Promise<{
  plan: PlannedReplacement;
  selection: SelectionContext | null;
  revalidateProvider: boolean;
}> {
  if (candidate.policyCheckState === "failure") {
    return {
      plan: terminalPlan(
        "permanent_failure",
        "Human-review policy is already in a terminal failure state.",
      ),
      selection: null,
      revalidateProvider: false,
    };
  }
  if (candidate.policyCheckState === "success") {
    return {
      plan: terminalPlan(
        "skipped_policy_satisfied",
        "Required human approval count is already satisfied.",
      ),
      selection: null,
      revalidateProvider: false,
    };
  }
  const inspected = await inspectProviderState(job, candidate, ports);
  if (inspected.state === null) {
    return { plan: permanentFailurePlan(inspected.permanentError), selection: null, revalidateProvider: false };
  }
  const planned = await planFromProviderState(
    job,
    activation,
    candidate,
    inspected.state,
    startedAt,
    null,
    ports,
  );
  return { ...planned, revalidateProvider: true };
}

async function applyCandidatePlan(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  startedAt: Date,
  read: {
    plan: PlannedReplacement;
    selection: SelectionContext | null;
    revalidateProvider: boolean;
  },
  ports: ReviewerAvailabilityPorts,
): Promise<{ plan: PlannedReplacement; providerEffectsApplied: boolean }> {
  if (!read.revalidateProvider) {
    return { plan: read.plan, providerEffectsApplied: false };
  }

  const inspected = await inspectProviderState(job, candidate, ports);
  if (inspected.state === null) {
    return { plan: permanentFailurePlan(inspected.permanentError), providerEffectsApplied: false };
  }
  const planned = await planFromProviderState(
    job,
    activation,
    candidate,
    inspected.state,
    startedAt,
    read.selection,
    ports,
  );
  if (planned.plan.providerIntent === "recovered") {
    return { plan: planned.plan, providerEffectsApplied: true };
  }
  if (
    candidate.mode !== "enforce"
    || planned.plan.providerIntent !== "apply"
    || planned.plan.replacementActor === null
  ) return { plan: planned.plan, providerEffectsApplied: false };
  try {
    await ports.provider.reconcileReviewRequest({
      ...target(job, candidate),
      unavailableActor: activation.externalActorId,
      replacementActor: planned.plan.replacementActor,
    });
  } catch (error) {
    const classified = ports.provider.classifyError(error);
    if (classified.kind === "retryable") throw error;
    return { plan: permanentFailurePlan(classified.message), providerEffectsApplied: true };
  }
  return { plan: planned.plan, providerEffectsApplied: true };
}

async function finalizeCandidatePlan(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  startedAt: Date,
  plan: PlannedReplacement,
  providerEffectsApplied: boolean,
  ports: ReviewerAvailabilityPorts,
): Promise<
  | { result: ReviewerAbsenceActivationResult | null }
  | { recovery: ReviewerReplacementFinalizerRecovery }
> {
  const completedAt = ports.clock.now();
  const persistence = persistenceInput(job, activation, candidate, plan, startedAt, completedAt);
  let persisted: PersistReviewerReplacementResult;
  try {
    persisted = await ports.availability.persistReplacement(persistence);
  } catch (error) {
    if (!providerEffectsApplied) throw error;
    return {
      recovery: recovery(job, "persist_replacement", plan.finalizer, null, true, persistence, errorMessage(error)),
    };
  }
  if (!persisted.activationCurrent || persisted.replacement === null) {
    if (providerEffectsApplied) {
      return {
        recovery: recovery(
          job,
          "persist_replacement",
          plan.finalizer,
          null,
          true,
          persistence,
          "Final replacement persistence rejected stale state.",
        ),
      };
    }
    return { result: null };
  }

  if (plan.finalizer === null) {
    return {
      result: result(candidate, plan, true),
    };
  }

  try {
    await runFinalizer(job, plan.finalizer, ports);
  } catch (error) {
    return {
      recovery: recovery(
        job,
        "run_finalizer",
        plan.finalizer,
        persisted.replacement.id,
        providerEffectsApplied,
        persistence,
        errorMessage(error),
      ),
    };
  }

  try {
    const completed = await ports.availability.updateReplacementState({
      replacementId: persisted.replacement.id,
      expectedState: "finalizer_pending",
      state: "completed",
      lastError: null,
    });
    if (completed === null) {
      return {
        recovery: recovery(
          job,
          "complete_replacement",
          plan.finalizer,
          persisted.replacement.id,
          providerEffectsApplied,
          persistence,
          "Finalizer completion state was not persisted.",
        ),
      };
    }
  } catch (error) {
    return {
      recovery: recovery(
        job,
        "complete_replacement",
        plan.finalizer,
        persisted.replacement.id,
        providerEffectsApplied,
        persistence,
        errorMessage(error),
      ),
    };
  }
  return { result: result(candidate, plan, true) };
}

async function replayPendingFinalizer(
  job: ReviewerAbsenceActivationJobPayload,
  record: ReviewerReplacementFinalizerRecord,
  ports: ReviewerAvailabilityPorts,
): Promise<{ recovery: ReviewerReplacementFinalizerRecovery | null }> {
  const finalizer = finalizerFor(record.decisionId, record.outcome);
  if (finalizer === null) throw new Error("Pending reviewer replacement has no mapped finalizer");
  try {
    await runFinalizer(job, finalizer, ports);
  } catch (error) {
    return {
      recovery: recovery(
        job,
        "run_finalizer",
        finalizer,
        record.id,
        record.outcome === "replaced",
        null,
        errorMessage(error),
      ),
    };
  }
  try {
    const completed = await ports.availability.updateReplacementState({
      replacementId: record.id,
      expectedState: "finalizer_pending",
      state: "completed",
      lastError: null,
    });
    if (completed === null) {
      return {
        recovery: recovery(
          job,
          "complete_replacement",
          finalizer,
          record.id,
          record.outcome === "replaced",
          null,
          "Finalizer completion state was not persisted.",
        ),
      };
    }
  } catch (error) {
    return {
      recovery: recovery(
        job,
        "complete_replacement",
        finalizer,
        record.id,
        record.outcome === "replaced",
        null,
        errorMessage(error),
      ),
    };
  }
  return { recovery: null };
}

async function loadSelectionContext(
  job: ReviewerAbsenceActivationJobPayload,
  candidate: ReviewerReplacementCandidateDecision,
  at: Date,
  ports: ReviewerAvailabilityPorts,
): Promise<SelectionContext> {
  const [absences, load] = await Promise.all([
    ports.availability.findActive({
      workspaceId: job.workspaceId,
      providerConnectionId: job.providerConnectionId,
      actors: candidate.originalEligibleActors,
      at,
    }),
    ports.reviewerLoad({
      workspaceId: job.workspaceId,
      actors: candidate.originalEligibleActors,
    }),
  ]);
  return { absences, load };
}

async function inspectProviderState(
  job: ReviewerAbsenceActivationJobPayload,
  candidate: ReviewerReplacementCandidateDecision,
  ports: ReviewerAvailabilityPorts,
): Promise<
  | { state: ReviewerReplacementProviderState; permanentError: null }
  | { state: null; permanentError: string }
> {
  try {
    return {
      state: await ports.provider.inspectChangeRequest(target(job, candidate)),
      permanentError: null,
    };
  } catch (error) {
    const classified = ports.provider.classifyError(error);
    if (classified.kind === "retryable") throw error;
    return { state: null, permanentError: classified.message };
  }
}

async function planFromProviderState(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  current: ReviewerReplacementProviderState,
  at: Date,
  existingSelection: SelectionContext | null,
  ports: ReviewerAvailabilityPorts,
): Promise<{ plan: PlannedReplacement; selection: SelectionContext | null }> {
  const terminal = terminalProviderPlan(activation, candidate, current, candidate.mode === "enforce");
  if (terminal !== null) return { plan: terminal, selection: existingSelection };
  const applied = providerAppliedPlan(activation, candidate, current);
  if (applied !== null) return { plan: applied, selection: existingSelection };
  const selection = existingSelection ?? await loadSelectionContext(job, candidate, at, ports);
  return {
    plan: replacementPlan(activation, candidate, current, selection, at),
    selection,
  };
}

function terminalProviderPlan(
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  current: ReviewerReplacementProviderState,
  mapPolicyFinalizer: boolean,
): PlannedReplacement | null {
  if (current.state !== "open") {
    return terminalPlan("skipped_closed", "Change request is no longer open.");
  }
  if (current.currentHeadRevision !== candidate.routedHeadRevision) {
    return terminalPlan("skipped_changed_head", "Change request head no longer matches the routed head.");
  }
  const approvedActors = activeApprovedReviewers(current.reviews);
  if (approvedActors.length >= candidate.requestedReviewerCount) {
    return {
      ...terminalPlan("skipped_policy_satisfied", "Required human approval count is already satisfied."),
      finalizer: mapPolicyFinalizer ? finalizerFor(candidate.decisionId, "skipped_policy_satisfied") : null,
    };
  }
  if (approvedActors.includes(activation.externalActorId)) {
    return terminalPlan("skipped_approved", "Unavailable actor has already approved the change request.");
  }
  return null;
}

function replacementPlan(
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  current: ReviewerReplacementProviderState,
  selection: SelectionContext,
  at: Date,
): PlannedReplacement {
  const approvedActors = activeApprovedReviewers(current.reviews);
  const selected = selectReplacement({
    author: current.authorActor,
    unavailableActor: activation.externalActorId,
    activeCohort: [...candidate.selectedActors, ...current.requestedActors],
    approvedActors,
    originalEligibleActors: candidate.originalEligibleActors,
    originalPreferredActors: candidate.originalPreferredActors,
    absences: selection.absences,
    load: selection.load,
    selectionKey: `${candidate.repository.externalId}:${candidate.changeRequestId}`,
    now: at,
  });
  if (selected.replacementActor === null) {
    return {
      outcome: "no_replacement_available",
      replacementActor: null,
      reason: "No available actor remains in the original ownership-eligible pool.",
      replaceCohort: false,
      finalizer: candidate.mode === "enforce"
        ? finalizerFor(candidate.decisionId, "no_replacement_available")
        : null,
      providerIntent: "none",
    };
  }
  const outcome = candidate.mode === "enforce" ? "replaced" : "simulated_replacement";
  return {
    outcome,
    replacementActor: selected.replacementActor,
    reason: candidate.mode === "enforce"
      ? `Replaced unavailable actor ${activation.externalActorId} with ${selected.replacementActor}.`
      : `Would replace unavailable actor ${activation.externalActorId} with ${selected.replacementActor}.`,
    replaceCohort: true,
    finalizer: finalizerFor(candidate.decisionId, outcome),
    providerIntent: candidate.mode === "enforce" ? "apply" : "none",
  };
}

function providerAppliedPlan(
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  current: ReviewerReplacementProviderState,
): PlannedReplacement | null {
  if (candidate.mode !== "enforce" || current.requestedActors.includes(activation.externalActorId)) return null;
  const originalEligibleActors = new Set(candidate.originalEligibleActors);
  const originalCohort = new Set(candidate.selectedActors);
  const approvedActors = new Set(activeApprovedReviewers(current.reviews));
  const possibleReplacements = [...new Set(current.requestedActors)].filter((actor) =>
    originalEligibleActors.has(actor)
    && !originalCohort.has(actor)
    && actor !== activation.externalActorId
    && actor !== current.authorActor
    && !approvedActors.has(actor)
  );
  if (possibleReplacements.length > 1) {
    return permanentFailurePlan(
      "Current provider requests contain multiple possible previously applied replacements.",
    );
  }
  const replacementActor = possibleReplacements[0];
  if (replacementActor === undefined) return null;
  return {
    outcome: "replaced",
    replacementActor,
    reason: `Recovered previously applied replacement of ${activation.externalActorId} with ${replacementActor}.`,
    replaceCohort: true,
    finalizer: finalizerFor(candidate.decisionId, "replaced"),
    providerIntent: "recovered",
  };
}

function terminalPlan(outcome: ReviewerReplacementOutcome, reason: string): PlannedReplacement {
  return {
    outcome,
    replacementActor: null,
    reason,
    replaceCohort: false,
    finalizer: null,
    providerIntent: "none",
  };
}

function permanentFailurePlan(reason: string): PlannedReplacement {
  return terminalPlan("permanent_failure", reason);
}

function finalizerFor(
  decisionId: string,
  outcome: ReviewerReplacementOutcome,
): ReviewerReplacementFinalizerAction | null {
  if (outcome === "replaced" || outcome === "skipped_policy_satisfied") {
    return { action: "reevaluate_policy", decisionId, summary: null };
  }
  if (outcome === "no_replacement_available") {
    return { action: "fail_policy", decisionId, summary: NO_REPLACEMENT_POLICY_SUMMARY };
  }
  return null;
}

function persistenceInput(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  plan: PlannedReplacement,
  startedAt: Date,
  completedAt: Date,
): PersistReviewerReplacementInput {
  const state = plan.outcome === "permanent_failure"
    ? "permanent_failure"
    : plan.finalizer === null ? "completed" : "finalizer_pending";
  return {
    provider: candidate.provider,
    providerConnectionId: candidate.providerConnectionId,
    absenceId: activation.absenceId,
    absenceRevision: activation.revision,
    decisionId: candidate.decisionId,
    expectedHeadRevision: candidate.routedHeadRevision,
    unavailableActorId: activation.externalActorId,
    replacementActorId: plan.replacementActor,
    outcome: plan.outcome,
    reason: plan.reason,
    state,
    lastError: plan.outcome === "permanent_failure" ? plan.reason : null,
    startedAt,
    completedAt,
    replaceCohort: plan.replaceCohort,
    event: {
      schemaVersion: 1,
      eventType: "reviewer_replacement",
      eventId: `reviewer-replacement:${activation.absenceId}:revision:${activation.revision}:decision:${candidate.decisionId}:v1`,
      occurredAt: completedAt.toISOString(),
      workspaceId: job.workspaceId,
      provider: candidate.provider,
      providerConnectionId: candidate.providerConnectionId,
      absenceId: activation.absenceId,
      absenceRevision: activation.revision,
      decisionId: candidate.decisionId,
      repositoryId: candidate.repository.externalId,
      changeRequestId: candidate.changeRequestId,
      unavailableActor: activation.externalActorId,
      replacementActor: plan.replacementActor,
      outcome: plan.outcome,
    },
  };
}

function target(
  job: ReviewerAbsenceActivationJobPayload,
  candidate: ReviewerReplacementCandidateDecision,
): ReviewerReplacementTarget {
  return {
    workspaceId: job.workspaceId,
    providerConnectionId: job.providerConnectionId,
    repository: candidate.repository,
    changeRequestId: candidate.changeRequestId,
    changeRequestNumber: candidate.changeRequestNumber,
  };
}

async function runFinalizer(
  job: ReviewerAbsenceActivationJobPayload,
  finalizer: ReviewerReplacementFinalizerAction,
  ports: ReviewerAvailabilityPorts,
): Promise<void> {
  await ports.finalizers.run({
    workspaceId: job.workspaceId,
    providerConnectionId: job.providerConnectionId,
    decisionId: finalizer.decisionId,
    action: finalizer.action,
    summary: finalizer.summary,
  });
}

function result(
  candidate: ReviewerReplacementCandidateDecision,
  plan: PlannedReplacement,
  finalized: boolean,
): ReviewerAbsenceActivationResult {
  return {
    decisionId: candidate.decisionId,
    outcome: plan.outcome,
    replacementActor: plan.replacementActor,
    finalized,
  };
}

function recovery(
  job: ReviewerAbsenceActivationJobPayload,
  phase: ReviewerReplacementFinalizerRecovery["phase"],
  finalizer: ReviewerReplacementFinalizerAction | null,
  replacementId: string | null,
  providerEffectsApplied: boolean,
  persistence: PersistReviewerReplacementInput | null,
  lastError: string,
): ReviewerReplacementFinalizerRecovery {
  return {
    kind: "reviewer_replacement_finalizer",
    phase,
    job,
    finalizer,
    replacementId,
    providerEffectsApplied,
    persistence,
    lastError,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
