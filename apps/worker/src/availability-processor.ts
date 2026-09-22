import {
  activateReviewerAbsence,
  assertPersistReviewerReplacementInput,
  assertReviewerReplacementFinalizerRecovery,
  type ReviewerAvailabilityPorts,
  type ReviewerReplacementFinalizerRecovery,
  type ReviewerReplacementRecoveryRecord,
} from "@triagepilot/application";
import type { ReviewerAbsenceActivationJobPayload } from "@triagepilot/contracts";
import type { ProviderKind } from "@triagepilot/contracts";
import { classifyWorkerError, PermanentJobError } from "./errors.js";

export type ReviewerAvailabilityServices = ReviewerAvailabilityPorts;
export interface ReviewerAbsenceActivationJobMessage extends ReviewerAbsenceActivationJobPayload {
  provider: ProviderKind;
}

export async function processReviewerAbsenceActivationJob(
  message: ReviewerAbsenceActivationJobMessage,
  services: ReviewerAvailabilityServices,
): Promise<ReviewerReplacementFinalizerRecovery | null> {
  const outcome = await activateReviewerAbsence(message, services);
  return outcome.status === "finalizer_pending" ? outcome.recovery : null;
}

export async function recoverReviewerReplacementFinalizer(
  input: ReviewerReplacementFinalizerRecovery,
  services: ReviewerAvailabilityServices,
): Promise<ReviewerReplacementFinalizerRecovery | null> {
  assertReviewerReplacementFinalizerRecovery(input);
  let recovery = input;

  if (recovery.phase !== "persist_replacement") {
    try {
      const record = await assertReplacementMatchesRecovery(recovery, services);
      if (recovery.phase === "complete_replacement" && record.state === "completed") return null;
      if (record.state !== "finalizer_pending") {
        throw new PermanentJobError("Reviewer replacement recovery is not pending finalization");
      }
    } catch (error) {
      return classifiedRecovery(recovery, error);
    }
  }

  if (recovery.phase === "persist_replacement") {
    try {
      const persisted = recovery.outcome === "permanent_failure"
        ? await services.availability.persistMutationIntentRecovery(recovery.persistence)
        : await services.availability.persistReplacement(recovery.persistence);
      if (!persisted.activationCurrent || persisted.replacement === null) {
        const audited = await services.availability.persistMutationIntentRecovery(
          mutationIntentRecoveryAudit(recovery, "Final replacement persistence rejected stale state."),
        );
        if (audited.replacement === null) throw new Error("Reviewer mutation recovery audit was not persisted");
        return null;
      }
      if (recovery.finalizer === null) return null;
      recovery = {
        ...recovery,
        phase: "run_finalizer",
        replacementId: persisted.replacement.id,
        persistence: null,
      } as ReviewerReplacementFinalizerRecovery;
    } catch (error) {
      return classifiedRecovery(recovery, error);
    }
  }

  if (recovery.phase === "run_finalizer") {
    try {
      await services.finalizers.run({
        workspaceId: recovery.job.workspaceId,
        providerConnectionId: recovery.job.providerConnectionId,
        decisionId: recovery.finalizer.decisionId,
        action: recovery.finalizer.action,
        summary: recovery.finalizer.summary,
      });
      recovery = {
        ...recovery,
        phase: "complete_replacement",
      } as ReviewerReplacementFinalizerRecovery;
    } catch (error) {
      return classifiedRecovery(recovery, error);
    }
  }

  if (recovery.phase === "complete_replacement") {
    try {
      const completed = await services.availability.updateReplacementState({
        replacementId: recovery.replacementId,
        expectedState: "finalizer_pending",
        state: "completed",
        lastError: null,
      });
      if (completed === null) throw new Error("Reviewer replacement finalizer completion was not persisted");
      return null;
    } catch (error) {
      return classifiedRecovery(recovery, error);
    }
  }

  return recovery;
}

export async function markReviewerReplacementRecoveryExhausted(
  recovery: ReviewerReplacementFinalizerRecovery,
  services: ReviewerAvailabilityServices,
  error: string,
): Promise<void> {
  assertReviewerReplacementFinalizerRecovery(recovery);
  if (recovery.replacementId === null) {
    const persisted = await services.availability.persistMutationIntentRecovery(
      mutationIntentRecoveryAudit(recovery, error),
    );
    if (persisted.replacement === null) throw new Error("Exhausted reviewer mutation recovery audit was not persisted");
    return;
  }
  const record = await assertReplacementMatchesRecovery(recovery, services);
  if (record.state !== "finalizer_pending") {
    throw new Error("Exhausted reviewer replacement is not pending finalization");
  }
  const updated = await services.availability.updateReplacementState({
    replacementId: recovery.replacementId,
    expectedState: "finalizer_pending",
    state: "permanent_failure",
    lastError: error,
  });
  if (updated === null) throw new Error("Exhausted reviewer replacement recovery was not persisted");
}

async function assertReplacementMatchesRecovery(
  recovery: ReviewerReplacementFinalizerRecovery,
  services: ReviewerAvailabilityServices,
): Promise<ReviewerReplacementRecoveryRecord> {
  if (recovery.replacementId === null) {
    throw new Error("Reviewer replacement recovery has no durable replacement identity");
  }
  const record = await services.availability.loadReplacement(recovery.replacementId);
  if (
    record === null
    || record.workspaceId !== recovery.job.workspaceId
    || record.provider !== recovery.provider
    || record.providerConnectionId !== recovery.job.providerConnectionId
    || record.absenceId !== recovery.job.absenceId
    || record.absenceRevision !== recovery.job.absenceRevision
    || record.decisionId !== recovery.finalizer?.decisionId
    || record.unavailableActorId !== recovery.unavailableActorId
    || record.outcome !== recovery.outcome
    || record.replacementActorId !== recovery.replacementActorId
    || record.mutationIntentId !== recovery.mutationIntentId
  ) throw new PermanentJobError("Reviewer replacement recovery does not match durable replacement provenance");
  return record;
}

function mutationIntentRecoveryAudit(
  recovery: ReviewerReplacementFinalizerRecovery,
  error: string,
) {
  if (recovery.persistence === null || recovery.mutationIntentId === null) {
    throw new PermanentJobError("Reviewer mutation recovery has no durable persistence provenance");
  }
  const value: unknown = {
    ...recovery.persistence,
    replacementActorId: null,
    mutationIntentId: recovery.mutationIntentId,
    outcome: "permanent_failure",
    reason: error,
    state: "permanent_failure",
    lastError: error,
    replaceCohort: false,
    event: {
      ...recovery.persistence.event,
      replacementActor: null,
      outcome: "permanent_failure",
    },
  };
  assertPersistReviewerReplacementInput(value);
  return value;
}

function classifiedRecovery(
  recovery: ReviewerReplacementFinalizerRecovery,
  error: unknown,
): ReviewerReplacementFinalizerRecovery {
  const classified = classifyWorkerError(error);
  return {
    ...recovery,
    lastError: classified.message,
    retryable: !(classified instanceof PermanentJobError),
  };
}
