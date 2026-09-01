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
const reviewerMutationIntentIdBrand: unique symbol = Symbol("ReviewerMutationIntentId");

export type ReviewerMutationIntentId = string & {
  readonly [reviewerMutationIntentIdBrand]: true;
};

export class ReviewerReplacementContractError extends Error {}

export function parseReviewerMutationIntentId(value: unknown): ReviewerMutationIntentId {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReviewerReplacementContractError("Reviewer mutation intent ID must not be empty");
  }
  return value as ReviewerMutationIntentId;
}

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
  reviews: ReviewerReplacementReviewMetadata[];
}

export interface ReviewerReplacementReviewMetadata extends ReviewMetadata {
  commitId: string | null;
}

export type ReviewerReplacementState = "finalizer_pending" | "completed" | "permanent_failure";

export interface ReviewerMutationIntentKey {
  workspaceId: WorkspaceId;
  providerConnectionId: ProviderConnectionId;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
}

export interface PrepareReviewerMutationIntentInput extends ReviewerMutationIntentKey {
  provider: ProviderKind;
  repositoryId: string;
  changeRequestId: ChangeRequestId;
  expectedHeadRevision: string;
  unavailableActorId: ExternalActorId;
  replacementActorId: ExternalActorId;
}

export interface ReviewerMutationIntent extends PrepareReviewerMutationIntentInput {
  id: ReviewerMutationIntentId;
}

type ReviewerReplacementNonMutationOutcome = Exclude<
  ReviewerReplacementOutcome,
  "replaced" | "simulated_replacement"
>;

export type ReviewerReplacementProvenance<
  Outcome extends ReviewerReplacementOutcome = ReviewerReplacementOutcome,
> = Outcome extends "replaced"
  ? {
    outcome: Outcome;
    replacementActorId: ExternalActorId;
    mutationIntentId: ReviewerMutationIntentId;
  }
  : Outcome extends "simulated_replacement"
    ? {
      outcome: Outcome;
      replacementActorId: ExternalActorId;
      mutationIntentId: null;
    }
    : Outcome extends ReviewerReplacementNonMutationOutcome
      ? {
        outcome: Outcome;
        replacementActorId: null;
        mutationIntentId: ReviewerMutationIntentId | null;
      }
      : never;

interface PersistReviewerReplacementCommon {
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  expectedHeadRevision: string;
  unavailableActorId: ExternalActorId;
  reason: string;
  state: ReviewerReplacementState;
  lastError: string | null;
  startedAt: Date;
  completedAt: Date;
}

type PersistReviewerReplacementFor<Outcome extends ReviewerReplacementOutcome> =
  Outcome extends ReviewerReplacementOutcome
    ? PersistReviewerReplacementCommon
      & ReviewerReplacementProvenance<Outcome>
      & {
        replaceCohort: Outcome extends "replaced" | "simulated_replacement" ? true : false;
        event: Omit<ReviewerReplacementEventV1, "outcome" | "replacementActor"> & {
          outcome: Outcome;
          replacementActor: ReviewerReplacementProvenance<Outcome>["replacementActorId"];
        };
      }
    : never;

export type PersistReviewerReplacementInput = PersistReviewerReplacementFor<ReviewerReplacementOutcome>;

type ReviewerReplacementFinalizerOutcome =
  | "replaced"
  | "skipped_policy_satisfied"
  | "no_replacement_available";

interface ReviewerReplacementFinalizerRecordCommon {
  id: string;
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  unavailableActorId: ExternalActorId;
  state: "finalizer_pending";
}

type ReviewerReplacementFinalizerRecordFor<Outcome extends ReviewerReplacementFinalizerOutcome> =
  Outcome extends ReviewerReplacementFinalizerOutcome
    ? ReviewerReplacementFinalizerRecordCommon & ReviewerReplacementProvenance<Outcome>
    : never;

export type ReviewerReplacementFinalizerRecord =
  ReviewerReplacementFinalizerRecordFor<ReviewerReplacementFinalizerOutcome>;

export interface ReviewerReplacementRecoveryRecord {
  id: string;
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  unavailableActorId: ExternalActorId;
  state: ReviewerReplacementState;
  outcome: ReviewerReplacementOutcome;
  replacementActorId: ExternalActorId | null;
  mutationIntentId: ReviewerMutationIntentId | null;
  lastError: string | null;
}

export function assertReviewerReplacementRecoveryRecord(
  value: unknown,
): asserts value is ReviewerReplacementRecoveryRecord {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.workspaceId)
    || !isProviderKind(value.provider)
    || !isNonEmptyString(value.providerConnectionId)
    || !isNonEmptyString(value.absenceId)
    || !isPositiveInteger(value.absenceRevision)
    || !isNonEmptyString(value.decisionId)
    || !isNonEmptyString(value.unavailableActorId)
    || !isReviewerReplacementState(value.state)
  ) throw new ReviewerReplacementContractError("Reviewer replacement recovery record is malformed");
  const record = value;
  assertReviewerReplacementProvenance(value);
  if (
    (record.outcome === "permanent_failure"
      && (record.state !== "permanent_failure" || !isNonEmptyString(record.lastError)))
    || (record.state === "permanent_failure" && !isNonEmptyString(record.lastError))
    || (record.state === "finalizer_pending"
      && (finalizerFor(record.decisionId as string, record.outcome as ReviewerReplacementOutcome) === null
        || record.lastError !== null))
    || (record.state === "completed"
      && (record.outcome === "permanent_failure" || record.lastError !== null))
  ) throw new ReviewerReplacementContractError("Reviewer replacement recovery state is malformed");
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

interface ReviewerReplacementFinalizerRecoveryCommon {
  kind: "reviewer_replacement_finalizer";
  job: ReviewerAbsenceActivationJobPayload;
  provider: ProviderKind;
  unavailableActorId: ExternalActorId;
  lastError: string;
  retryable: boolean;
}

type ReviewerReplacementRecoveryOutcome = ReviewerReplacementFinalizerOutcome | "permanent_failure";

type ReviewerReplacementRecoveryFinalizer<Outcome extends ReviewerReplacementRecoveryOutcome> =
  Outcome extends "replaced" | "skipped_policy_satisfied"
    ? { finalizer: ReviewerReplacementFinalizerAction & { action: "reevaluate_policy" } }
    : Outcome extends "no_replacement_available"
      ? { finalizer: ReviewerReplacementFinalizerAction & { action: "fail_policy" } }
      : { finalizer: null };

type ReviewerReplacementRecoveryEffects<Outcome extends ReviewerReplacementRecoveryOutcome> =
  Outcome extends "replaced"
    ? { providerEffectsApplied: true }
    : Outcome extends "permanent_failure"
      ? { providerEffectsApplied: true; mutationIntentId: ReviewerMutationIntentId }
      : { providerEffectsApplied: false };

type ReviewerReplacementRecoveryPersistence<Outcome extends ReviewerReplacementRecoveryOutcome> =
  Outcome extends "permanent_failure"
    ? PersistReviewerReplacementFor<Outcome> & { mutationIntentId: ReviewerMutationIntentId }
    : PersistReviewerReplacementFor<Outcome>;

type ReviewerReplacementRecoveryPhase<Outcome extends ReviewerReplacementRecoveryOutcome> =
  Outcome extends "permanent_failure"
    ? {
      phase: "persist_replacement";
      replacementId: null;
      persistence: ReviewerReplacementRecoveryPersistence<Outcome>;
    }
    :
      | {
        phase: "persist_replacement";
        replacementId: null;
        persistence: ReviewerReplacementRecoveryPersistence<Outcome>;
      }
      | {
        phase: "run_finalizer" | "complete_replacement";
        replacementId: string;
        persistence: ReviewerReplacementRecoveryPersistence<Outcome> | null;
      };

type ReviewerReplacementFinalizerRecoveryFor<Outcome extends ReviewerReplacementRecoveryOutcome> =
  Outcome extends ReviewerReplacementRecoveryOutcome
    ? ReviewerReplacementFinalizerRecoveryCommon
      & ReviewerReplacementProvenance<Outcome>
      & ReviewerReplacementRecoveryFinalizer<Outcome>
      & ReviewerReplacementRecoveryEffects<Outcome>
      & ReviewerReplacementRecoveryPhase<Outcome>
    : never;

export type ReviewerReplacementFinalizerRecovery =
  ReviewerReplacementFinalizerRecoveryFor<ReviewerReplacementRecoveryOutcome>;

export interface ReviewerAvailabilityPorts {
  clock: Clock;
  availability: {
    listPendingFinalizers(input: {
      absenceId: string;
      absenceRevision: number;
    }): Promise<ReviewerReplacementFinalizerRecord[]>;
    loadReplacement(replacementId: string): Promise<ReviewerReplacementRecoveryRecord | null>;
    loadActivation(absenceId: string, revision: number): Promise<ReviewerAbsenceActivation | null>;
    listUnfinalizedMutationIntents(input: {
      absenceId: string;
      absenceRevision: number;
    }): Promise<ReviewerMutationIntent[]>;
    /** Loads immutable provider-mutation provenance before any mutable replacement selection. */
    loadMutationIntent(input: ReviewerMutationIntentKey): Promise<ReviewerMutationIntent | null>;
    /**
     * Atomically creates or loads the immutable intent for this key. The returned record is authoritative;
     * implementations must never overwrite an existing actor selection. It remains durable until terminal
     * replacement history is persisted; later retention cleanup is outside activation processing.
     */
    prepareMutationIntent(input: PrepareReviewerMutationIntentInput): Promise<ReviewerMutationIntent>;
    findActive(input: {
      workspaceId: WorkspaceId;
      providerConnectionId: ProviderConnectionId;
      actors: ExternalActorId[];
      at: Date;
    }): Promise<ReviewerAbsenceWindow[]>;
    persistReplacement(input: PersistReviewerReplacementInput): Promise<PersistReviewerReplacementResult>;
    persistMutationIntentRecovery(input: PersistReviewerReplacementInput): Promise<PersistReviewerReplacementResult>;
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
    classifyError(error: unknown): { kind: "permanent" | "retryable"; message: string };
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
  mutationIntentId: ReviewerMutationIntentId | null;
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
  providerIntent: "none" | "prepare" | "apply";
  mutationIntentId: ReviewerMutationIntentId | null;
};

type SelectionContext = {
  absences: ReviewerAbsenceWindow[];
  load: Record<string, number>;
};

export function assertReviewerReplacementProvenance(
  value: unknown,
): asserts value is ReviewerReplacementProvenance {
  if (!isRecord(value)) {
    throw new ReviewerReplacementContractError("Reviewer replacement provenance is malformed");
  }
  const outcome = value.outcome;
  const replacementActorId = value.replacementActorId;
  const mutationIntentId = value.mutationIntentId;
  if (outcome === "replaced") {
    if (!isNonEmptyString(replacementActorId) || !isNonEmptyString(mutationIntentId)) {
      throw new ReviewerReplacementContractError(
        "Replaced reviewer outcome requires durable mutation provenance",
      );
    }
    return;
  }
  if (outcome === "simulated_replacement") {
    if (!isNonEmptyString(replacementActorId) || mutationIntentId !== null) {
      throw new ReviewerReplacementContractError(
        "Simulated reviewer replacement requires an actor and null mutation provenance",
      );
    }
    return;
  }
  if (!isReviewerReplacementNonMutationOutcome(outcome)) {
    throw new ReviewerReplacementContractError("Reviewer replacement outcome is malformed");
  }
  if (replacementActorId !== null) {
    throw new ReviewerReplacementContractError(
      "Non-mutating reviewer outcome requires a null replacement actor",
    );
  }
  if (mutationIntentId !== null) parseReviewerMutationIntentId(mutationIntentId);
}

export function assertReviewerReplacementFinalizerRecord(
  value: unknown,
): asserts value is ReviewerReplacementFinalizerRecord {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.workspaceId)
    || !isProviderKind(value.provider)
    || !isNonEmptyString(value.providerConnectionId)
    || !isNonEmptyString(value.absenceId)
    || !isPositiveInteger(value.absenceRevision)
    || !isNonEmptyString(value.decisionId)
    || !isNonEmptyString(value.unavailableActorId)
    || value.state !== "finalizer_pending"
  ) {
    throw new ReviewerReplacementContractError("Pending reviewer replacement finalizer is malformed");
  }
  if (
    value.outcome !== "replaced"
    && value.outcome !== "skipped_policy_satisfied"
    && value.outcome !== "no_replacement_available"
  ) {
    throw new ReviewerReplacementContractError("Pending reviewer replacement has no mapped finalizer");
  }
  assertReviewerReplacementProvenance(value);
}

export function assertPersistReviewerReplacementInput(
  value: unknown,
): asserts value is PersistReviewerReplacementInput {
  if (!isRecord(value)) {
    throw new ReviewerReplacementContractError("Reviewer replacement persistence is malformed");
  }
  const record = value;
  assertReviewerReplacementProvenance(value);
  if (
    !isProviderKind(record.provider)
    || !isNonEmptyString(record.providerConnectionId)
    || !isNonEmptyString(record.absenceId)
    || !isPositiveInteger(record.absenceRevision)
    || !isNonEmptyString(record.decisionId)
    || !isNonEmptyString(record.expectedHeadRevision)
    || !isNonEmptyString(record.unavailableActorId)
    || !isNonEmptyString(record.reason)
    || !isReviewerReplacementState(record.state)
    || (record.lastError !== null && typeof record.lastError !== "string")
    || !isFiniteDate(record.startedAt)
    || !isFiniteDate(record.completedAt)
    || record.completedAt < record.startedAt
  ) {
    throw new ReviewerReplacementContractError("Reviewer replacement persistence is malformed");
  }
  if (
    (record.state === "completed" && record.lastError !== null)
    || (record.state === "permanent_failure" && !isNonEmptyString(record.lastError))
  ) {
    throw new ReviewerReplacementContractError("Reviewer replacement persistence state is malformed");
  }
  const expectedState = value.outcome === "permanent_failure"
    ? "permanent_failure"
    : finalizerFor(record.decisionId as string, value.outcome) === null
      ? "completed"
      : "finalizer_pending";
  if (record.state !== expectedState) {
    throw new ReviewerReplacementContractError("Reviewer replacement persistence state does not match its outcome");
  }
  const replacesCohort = value.outcome === "replaced" || value.outcome === "simulated_replacement";
  if (record.replaceCohort !== replacesCohort || !isRecord(record.event)) {
    throw new ReviewerReplacementContractError("Reviewer replacement persistence is malformed");
  }
  const event = record.event;
  if (
    event.schemaVersion !== 1
    || event.eventType !== "reviewer_replacement"
    || !isNonEmptyString(event.eventId)
    || !isNonEmptyString(event.occurredAt)
    || !isNonEmptyString(event.workspaceId)
    || event.provider !== record.provider
    || event.providerConnectionId !== record.providerConnectionId
    || event.absenceId !== record.absenceId
    || event.absenceRevision !== record.absenceRevision
    || event.decisionId !== record.decisionId
    || !isNonEmptyString(event.repositoryId)
    || !isNonEmptyString(event.changeRequestId)
    || event.unavailableActor !== record.unavailableActorId
    || event.outcome !== value.outcome
    || event.replacementActor !== value.replacementActorId
    || new Date(event.occurredAt).getTime() !== record.completedAt.getTime()
  ) {
    throw new ReviewerReplacementContractError(
      "Reviewer replacement event does not match persistence provenance",
    );
  }
}

export function assertReviewerReplacementFinalizerRecovery(
  value: unknown,
): asserts value is ReviewerReplacementFinalizerRecovery {
  if (
    !isRecord(value)
    || value.kind !== "reviewer_replacement_finalizer"
    || !isNonEmptyString(value.lastError)
    || typeof value.retryable !== "boolean"
    || !isRecord(value.job)
    || value.job.kind !== "activate_reviewer_absence"
    || !isNonEmptyString(value.job.workspaceId)
    || !isNonEmptyString(value.job.providerConnectionId)
    || !isNonEmptyString(value.job.absenceId)
    || !isPositiveInteger(value.job.absenceRevision)
    || !isProviderKind(value.provider)
    || !isNonEmptyString(value.unavailableActorId)
  ) {
    throw new ReviewerReplacementContractError("Reviewer replacement recovery is malformed");
  }
  const record = value;
  if (value.providerEffectsApplied === true) {
    if (!isNonEmptyString(value.mutationIntentId)) {
      throw new ReviewerReplacementContractError(
        "Provider-effect recovery requires durable mutation provenance",
      );
    }
    if (value.outcome !== "replaced" && value.outcome !== "permanent_failure") {
      throw new ReviewerReplacementContractError(
        "Provider-effect recovery has an invalid reviewer outcome",
      );
    }
  } else if (
    value.providerEffectsApplied !== false
    || (value.outcome !== "skipped_policy_satisfied" && value.outcome !== "no_replacement_available")
  ) {
    throw new ReviewerReplacementContractError("Reviewer replacement recovery effects are malformed");
  }
  assertReviewerReplacementProvenance(value);

  if (value.outcome === "permanent_failure") {
    if (record.finalizer !== null || record.phase !== "persist_replacement") {
      throw new ReviewerReplacementContractError("Permanent provider failure recovery is malformed");
    }
  } else {
    if (!isRecord(record.finalizer)) {
      throw new ReviewerReplacementContractError("Reviewer replacement recovery finalizer is malformed");
    }
    const expectedAction = value.outcome === "no_replacement_available"
      ? "fail_policy"
      : "reevaluate_policy";
    if (
      record.finalizer.action !== expectedAction
      || !isNonEmptyString(record.finalizer.decisionId)
      || (record.finalizer.summary !== null && typeof record.finalizer.summary !== "string")
    ) {
      throw new ReviewerReplacementContractError("Reviewer replacement recovery finalizer is malformed");
    }
  }

  if (record.phase === "persist_replacement") {
    if (record.replacementId !== null || record.persistence === null) {
      throw new ReviewerReplacementContractError("Reviewer replacement persistence recovery is malformed");
    }
  } else if (record.phase === "run_finalizer" || record.phase === "complete_replacement") {
    if (!isNonEmptyString(record.replacementId) || record.persistence !== null) {
      throw new ReviewerReplacementContractError("Reviewer replacement finalizer recovery is malformed");
    }
  } else {
    throw new ReviewerReplacementContractError("Reviewer replacement recovery phase is malformed");
  }

  if (record.persistence !== null) {
    assertPersistReviewerReplacementInput(record.persistence);
    if (
      record.persistence.outcome !== value.outcome
      || record.persistence.provider !== record.provider
      || record.persistence.unavailableActorId !== record.unavailableActorId
      || record.persistence.replacementActorId !== value.replacementActorId
      || record.persistence.mutationIntentId !== value.mutationIntentId
    ) {
      throw new ReviewerReplacementContractError(
        "Reviewer replacement recovery does not match persistence provenance",
      );
    }
  }
}

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
    assertReviewerReplacementFinalizerRecord(record);
    const replay = await replayPendingFinalizer(job, record, ports);
    if (replay.recovery !== null) {
      return { status: "finalizer_pending", results, recovery: replay.recovery };
    }
    results.push({
      decisionId: record.decisionId,
      outcome: record.outcome,
      replacementActor: record.replacementActorId ?? null,
      mutationIntentId: record.mutationIntentId,
      finalized: true,
    });
  }

  const unfinalizedIntents = await ports.availability.listUnfinalizedMutationIntents({
    absenceId: job.absenceId,
    absenceRevision: job.absenceRevision,
  });
  const activation = await ports.availability.loadActivation(job.absenceId, job.absenceRevision);
  if (activation === null) {
    return await auditUnfinalizedIntents(job, unfinalizedIntents, startedAt, results, ports, "stale_activation");
  }
  if (
    activation.providerConnectionId !== job.providerConnectionId
    || activation.absenceId !== job.absenceId
    || activation.revision !== job.absenceRevision
  ) return await auditUnfinalizedIntents(job, unfinalizedIntents, startedAt, results, ports, "stale_activation");
  if (activation.startAt > startedAt || activation.endAt <= startedAt) {
    return await auditUnfinalizedIntents(job, unfinalizedIntents, startedAt, results, ports, "inactive_activation");
  }

  const processedDecisions = new Set<string>();
  for (const candidate of activation.candidates) {
    const processed = await processCandidate(job, activation, candidate, startedAt, ports);
    if ("recovery" in processed) {
      return { status: "finalizer_pending", results, recovery: processed.recovery };
    }
    if (processed.result === null) {
      return { status: "skipped", reason: "final_revalidation", results };
    }
    processedDecisions.add(candidate.decisionId);
    results.push(processed.result);
  }
  const remainingIntents = unfinalizedIntents.filter((intent) => !processedDecisions.has(intent.decisionId));
  if (remainingIntents.length > 0) {
    return await auditUnfinalizedIntents(job, remainingIntents, startedAt, results, ports, "stale_activation");
  }
  return { status: "completed", results };
}

async function auditUnfinalizedIntents(
  job: ReviewerAbsenceActivationJobPayload,
  intents: ReviewerMutationIntent[],
  startedAt: Date,
  results: ReviewerAbsenceActivationResult[],
  ports: ReviewerAvailabilityPorts,
  emptyReason: "stale_activation" | "inactive_activation",
): Promise<ReviewerAbsenceActivationOutcome> {
  if (intents.length === 0) return { status: "skipped", reason: emptyReason, results };
  for (const intent of intents) {
    const completedAt = ports.clock.now();
    const reason = "Durable reviewer mutation intent could not resume after activation scope changed.";
    const persistence = mutationIntentRecoveryPersistence(job, intent, reason, startedAt, completedAt);
    try {
      const persisted = await ports.availability.persistMutationIntentRecovery(persistence);
      if (persisted.replacement === null) throw new Error("Mutation intent recovery audit was not persisted");
    } catch (error) {
      const plan = permanentFailurePlan(reason, intent.id);
      return {
        status: "finalizer_pending",
        results,
        recovery: recovery(
          job,
          "persist_replacement",
          null,
          null,
          true,
          persistence,
          errorMessage(error),
          plan,
          true,
        ),
      };
    }
    results.push({
      decisionId: intent.decisionId,
      outcome: "permanent_failure",
      replacementActor: null,
      mutationIntentId: intent.id,
      finalized: true,
    });
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
  mutationIntent: ReviewerMutationIntent | null;
  revalidateProvider: boolean;
}> {
  const mutationIntent = candidate.mode === "enforce"
    ? await ports.availability.loadMutationIntent(mutationIntentKey(job, candidate))
    : null;
  if (mutationIntent !== null) {
    const mismatch = mutationIntentMismatch(job, activation, candidate, mutationIntent);
    if (mismatch !== null) {
      return {
        plan: permanentFailurePlan(mismatch, mutationIntent.id),
        selection: null,
        mutationIntent,
        revalidateProvider: false,
      };
    }
  }
  if (candidate.policyCheckState === "failure") {
    return {
      plan: withMutationIntent(terminalPlan(
        "permanent_failure",
        "Human-review policy is already in a terminal failure state.",
      ), mutationIntent),
      selection: null,
      mutationIntent,
      revalidateProvider: false,
    };
  }
  if (candidate.policyCheckState === "success") {
    return {
      plan: withMutationIntent({
        ...terminalPlan(
          "skipped_policy_satisfied",
          "Required human approval count is already satisfied.",
        ),
        finalizer: finalizerFor(candidate.decisionId, "skipped_policy_satisfied"),
      }, mutationIntent),
      selection: null,
      mutationIntent,
      revalidateProvider: false,
    };
  }
  const inspected = await inspectProviderState(job, candidate, ports);
  if (inspected.state === null) {
    return {
      plan: permanentFailurePlan(inspected.permanentError, mutationIntent?.id ?? null),
      selection: null,
      mutationIntent,
      revalidateProvider: false,
    };
  }
  const initialTerminal = terminalProviderPlan(activation, candidate, inspected.state, candidate.mode === "enforce");
  if (initialTerminal !== null) {
    return {
      plan: mutationIntent === null ? initialTerminal : { ...initialTerminal, mutationIntentId: mutationIntent.id },
      selection: null,
      mutationIntent,
      revalidateProvider: true,
    };
  }
  const planned = await planFromProviderState(
    job,
    activation,
    candidate,
    inspected.state,
    startedAt,
    null,
    mutationIntent,
    ports,
  );
  return { ...planned, mutationIntent, revalidateProvider: true };
}

async function applyCandidatePlan(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  startedAt: Date,
  read: {
    plan: PlannedReplacement;
    selection: SelectionContext | null;
    mutationIntent: ReviewerMutationIntent | null;
    revalidateProvider: boolean;
  },
  ports: ReviewerAvailabilityPorts,
): Promise<{ plan: PlannedReplacement; providerEffectsApplied: boolean }> {
  if (!read.revalidateProvider) {
    return { plan: read.plan, providerEffectsApplied: false };
  }

  let intent = read.mutationIntent;
  if (
    candidate.mode === "enforce"
    && read.plan.providerIntent === "prepare"
    && read.plan.replacementActor !== null
  ) {
    const prepared = await prepareValidatedMutationIntent(
      job,
      activation,
      candidate,
      read.plan.replacementActor,
      ports,
    );
    if (prepared.failure !== null) return { plan: prepared.failure, providerEffectsApplied: false };
    intent = prepared.intent;
  }

  let inspected = await inspectProviderState(job, candidate, ports);
  if (inspected.state === null) {
    return {
      plan: permanentFailurePlan(inspected.permanentError, intent?.id ?? null),
      providerEffectsApplied: false,
    };
  }
  let planned = await planFromProviderState(
    job,
    activation,
    candidate,
    inspected.state,
    startedAt,
    read.selection,
    intent,
    ports,
  );
  if (
    candidate.mode !== "enforce"
    || planned.plan.providerIntent === "none"
    || planned.plan.replacementActor === null
  ) return { plan: planned.plan, providerEffectsApplied: false };
  if (planned.plan.providerIntent === "prepare") {
    const prepared = await prepareValidatedMutationIntent(
      job,
      activation,
      candidate,
      planned.plan.replacementActor,
      ports,
    );
    if (prepared.failure !== null) return { plan: prepared.failure, providerEffectsApplied: false };
    intent = prepared.intent;
    inspected = await inspectProviderState(job, candidate, ports);
    if (inspected.state === null) {
      return { plan: permanentFailurePlan(inspected.permanentError, intent.id), providerEffectsApplied: false };
    }
    planned = await planFromProviderState(
      job,
      activation,
      candidate,
      inspected.state,
      startedAt,
      read.selection,
      intent,
      ports,
    );
    if (planned.plan.providerIntent === "none") {
      return { plan: planned.plan, providerEffectsApplied: false };
    }
  }
  if (intent === null) throw new Error("Durable reviewer mutation intent is required before provider mutation");
  const ineligibleIntentPlan = await durableIntentIneligibilityPlan(
    job,
    candidate,
    inspected.state,
    intent,
    startedAt,
    ports,
  );
  if (ineligibleIntentPlan !== null) {
    return { plan: ineligibleIntentPlan, providerEffectsApplied: false };
  }
  const intentPlan = durableIntentPlan(activation, candidate, intent);
  try {
    await ports.provider.reconcileReviewRequest({
      ...target(job, candidate),
      unavailableActor: activation.externalActorId,
      replacementActor: intent.replacementActorId,
    });
  } catch (error) {
    const classified = ports.provider.classifyError(error);
    if (classified.kind === "retryable") throw error;
    return { plan: permanentFailurePlan(classified.message, intent.id), providerEffectsApplied: true };
  }
  return { plan: intentPlan, providerEffectsApplied: true };
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
      recovery: recovery(
        job,
        "persist_replacement",
        plan.finalizer,
        null,
        true,
        persistence,
        errorMessage(error),
        plan,
      ),
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
          plan,
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
    const classified = ports.finalizers.classifyError(error);
    return {
      recovery: recovery(
        job,
        "run_finalizer",
        plan.finalizer,
        persisted.replacement.id,
        providerEffectsApplied,
        persistence,
        classified.message,
        plan,
        classified.kind === "retryable",
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
          plan,
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
        plan,
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
    const classified = ports.finalizers.classifyError(error);
    return {
      recovery: recovery(
        job,
        "run_finalizer",
        finalizer,
        record.id,
        record.outcome === "replaced",
        null,
        classified.message,
        record,
        classified.kind === "retryable",
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
          record,
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
        record,
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

function mutationIntentKey(
  job: ReviewerAbsenceActivationJobPayload,
  candidate: ReviewerReplacementCandidateDecision,
): ReviewerMutationIntentKey {
  return {
    workspaceId: job.workspaceId,
    providerConnectionId: job.providerConnectionId,
    absenceId: job.absenceId,
    absenceRevision: job.absenceRevision,
    decisionId: candidate.decisionId,
  };
}

function mutationIntentInput(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  replacementActorId: ExternalActorId,
): PrepareReviewerMutationIntentInput {
  return {
    ...mutationIntentKey(job, candidate),
    provider: candidate.provider,
    repositoryId: candidate.repository.externalId,
    changeRequestId: candidate.changeRequestId,
    expectedHeadRevision: candidate.routedHeadRevision,
    unavailableActorId: activation.externalActorId,
    replacementActorId,
  };
}

function mutationIntentMismatch(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  intent: ReviewerMutationIntent,
): string | null {
  const expected = mutationIntentInput(job, activation, candidate, intent.replacementActorId);
  const sourceMatches = intent.id.trim().length > 0
    && intent.workspaceId === expected.workspaceId
    && intent.provider === expected.provider
    && intent.providerConnectionId === expected.providerConnectionId
    && intent.absenceId === expected.absenceId
    && intent.absenceRevision === expected.absenceRevision
    && intent.decisionId === expected.decisionId
    && intent.repositoryId === expected.repositoryId
    && intent.changeRequestId === expected.changeRequestId
    && intent.expectedHeadRevision === expected.expectedHeadRevision
    && intent.unavailableActorId === expected.unavailableActorId;
  const actorIsValid = candidate.originalEligibleActors.includes(intent.replacementActorId)
    && !candidate.selectedActors.includes(intent.replacementActorId)
    && intent.replacementActorId !== activation.externalActorId;
  return sourceMatches && actorIsValid
    ? null
    : "Durable reviewer mutation intent does not match the immutable activation source.";
}

async function prepareValidatedMutationIntent(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  replacementActorId: ExternalActorId,
  ports: ReviewerAvailabilityPorts,
): Promise<
  | { intent: ReviewerMutationIntent; failure: null }
  | { intent: ReviewerMutationIntent; failure: PlannedReplacement }
> {
  const intent = await ports.availability.prepareMutationIntent(
    mutationIntentInput(job, activation, candidate, replacementActorId),
  );
  const mismatch = mutationIntentMismatch(job, activation, candidate, intent);
  return mismatch === null
    ? { intent, failure: null }
    : { intent, failure: permanentFailurePlan(mismatch, intent.id) };
}

async function durableIntentIneligibilityPlan(
  job: ReviewerAbsenceActivationJobPayload,
  candidate: ReviewerReplacementCandidateDecision,
  current: ReviewerReplacementProviderState,
  intent: ReviewerMutationIntent,
  at: Date,
  ports: ReviewerAvailabilityPorts,
): Promise<PlannedReplacement | null> {
  if (intent.replacementActorId === current.authorActor) {
    return permanentFailurePlan(
      `Durable replacement actor ${intent.replacementActorId} is the current change-request author.`,
      intent.id,
    );
  }
  const absences = await ports.availability.findActive({
    workspaceId: job.workspaceId,
    providerConnectionId: job.providerConnectionId,
    actors: [intent.replacementActorId],
    at,
  });
  if (absences.some((absence) => absence.externalActorId === intent.replacementActorId)) {
    return permanentFailurePlan(
      `Durable replacement actor ${intent.replacementActorId} is currently unavailable.`,
      intent.id,
    );
  }
  const currentHeadApprovals = activeApprovedReviewers(
    current.reviews.filter((review) => review.commitId === current.currentHeadRevision),
  );
  if (currentHeadApprovals.includes(intent.replacementActorId)) {
    return permanentFailurePlan(
      `Durable replacement actor ${intent.replacementActorId} already approved the current head.`,
      intent.id,
    );
  }
  return null;
}

async function planFromProviderState(
  job: ReviewerAbsenceActivationJobPayload,
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  current: ReviewerReplacementProviderState,
  at: Date,
  existingSelection: SelectionContext | null,
  mutationIntent: ReviewerMutationIntent | null,
  ports: ReviewerAvailabilityPorts,
): Promise<{ plan: PlannedReplacement; selection: SelectionContext | null }> {
  const terminal = terminalProviderPlan(activation, candidate, current, candidate.mode === "enforce");
  if (terminal !== null) {
    return {
      plan: mutationIntent === null ? terminal : { ...terminal, mutationIntentId: mutationIntent.id },
      selection: existingSelection,
    };
  }
  if (mutationIntent !== null) {
    return { plan: durableIntentPlan(activation, candidate, mutationIntent), selection: existingSelection };
  }
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
    activeCohort: candidate.selectedActors,
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
      mutationIntentId: null,
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
    providerIntent: candidate.mode === "enforce" ? "prepare" : "none",
    mutationIntentId: null,
  };
}

function durableIntentPlan(
  activation: ReviewerAbsenceActivation,
  candidate: ReviewerReplacementCandidateDecision,
  intent: ReviewerMutationIntent,
): PlannedReplacement {
  return {
    outcome: "replaced",
    replacementActor: intent.replacementActorId,
    reason: `Replaced unavailable actor ${activation.externalActorId} with ${intent.replacementActorId}.`,
    replaceCohort: true,
    finalizer: finalizerFor(candidate.decisionId, "replaced"),
    providerIntent: "apply",
    mutationIntentId: intent.id,
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
    mutationIntentId: null,
  };
}

function withMutationIntent(
  plan: PlannedReplacement,
  intent: ReviewerMutationIntent | null,
): PlannedReplacement {
  return intent === null ? plan : { ...plan, mutationIntentId: intent.id };
}

function permanentFailurePlan(
  reason: string,
  mutationIntentId: ReviewerMutationIntentId | null = null,
): PlannedReplacement {
  return { ...terminalPlan("permanent_failure", reason), mutationIntentId };
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
  const value: unknown = {
    provider: candidate.provider,
    providerConnectionId: candidate.providerConnectionId,
    absenceId: activation.absenceId,
    absenceRevision: activation.revision,
    decisionId: candidate.decisionId,
    expectedHeadRevision: candidate.routedHeadRevision,
    unavailableActorId: activation.externalActorId,
    replacementActorId: plan.replacementActor,
    mutationIntentId: plan.mutationIntentId,
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
  assertPersistReviewerReplacementInput(value);
  return value;
}

function mutationIntentRecoveryPersistence(
  job: ReviewerAbsenceActivationJobPayload,
  intent: ReviewerMutationIntent,
  reason: string,
  startedAt: Date,
  completedAt: Date,
): PersistReviewerReplacementInput {
  const value: unknown = {
    provider: intent.provider,
    providerConnectionId: intent.providerConnectionId,
    absenceId: intent.absenceId,
    absenceRevision: intent.absenceRevision,
    decisionId: intent.decisionId,
    expectedHeadRevision: intent.expectedHeadRevision,
    unavailableActorId: intent.unavailableActorId,
    replacementActorId: null,
    mutationIntentId: intent.id,
    outcome: "permanent_failure",
    reason,
    state: "permanent_failure",
    lastError: reason,
    startedAt,
    completedAt,
    replaceCohort: false,
    event: {
      schemaVersion: 1,
      eventType: "reviewer_replacement",
      eventId: `reviewer-replacement:${intent.absenceId}:revision:${intent.absenceRevision}:decision:${intent.decisionId}:v1`,
      occurredAt: completedAt.toISOString(),
      workspaceId: job.workspaceId,
      provider: intent.provider,
      providerConnectionId: intent.providerConnectionId,
      absenceId: intent.absenceId,
      absenceRevision: intent.absenceRevision,
      decisionId: intent.decisionId,
      repositoryId: intent.repositoryId,
      changeRequestId: intent.changeRequestId,
      unavailableActor: intent.unavailableActorId,
      replacementActor: null,
      outcome: "permanent_failure",
    },
  };
  assertPersistReviewerReplacementInput(value);
  return value;
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
    mutationIntentId: plan.mutationIntentId,
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
  source: PlannedReplacement | ReviewerReplacementFinalizerRecord,
  retryable = true,
): ReviewerReplacementFinalizerRecovery {
  const replacementActorId = "replacementActor" in source
    ? source.replacementActor
    : source.replacementActorId;
  const provider = persistence?.provider ?? ("provider" in source ? source.provider : undefined);
  const unavailableActorId = persistence?.unavailableActorId
    ?? ("unavailableActorId" in source ? source.unavailableActorId : undefined);
  const value: unknown = {
    kind: "reviewer_replacement_finalizer",
    phase,
    job,
    provider,
    unavailableActorId,
    finalizer,
    replacementId,
    outcome: source.outcome,
    replacementActorId,
    mutationIntentId: source.mutationIntentId,
    providerEffectsApplied,
    persistence: phase === "persist_replacement" ? persistence : null,
    lastError,
    retryable,
  };
  assertReviewerReplacementFinalizerRecovery(value);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isFiniteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isProviderKind(value: unknown): value is ProviderKind {
  return value === "github" || value === "gitlab" || value === "bitbucket";
}

function isReviewerReplacementState(value: unknown): value is ReviewerReplacementState {
  return value === "finalizer_pending" || value === "completed" || value === "permanent_failure";
}

function isReviewerReplacementNonMutationOutcome(
  value: unknown,
): value is ReviewerReplacementNonMutationOutcome {
  return value === "no_replacement_available"
    || value === "skipped_approved"
    || value === "skipped_closed"
    || value === "skipped_changed_head"
    || value === "skipped_policy_satisfied"
    || value === "permanent_failure";
}
