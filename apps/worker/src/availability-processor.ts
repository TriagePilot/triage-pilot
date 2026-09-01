import {
  activateReviewerAbsence,
  assertReviewerReplacementFinalizerRecovery,
  type ReviewerAvailabilityPorts,
  type ReviewerReplacementFinalizerRecovery,
} from "@triagepilot/application";
import type { ReviewerAbsenceActivationJobPayload } from "@triagepilot/contracts";
import type { ProviderKind } from "@triagepilot/contracts";

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
      await assertPendingFinalizerMatchesRecovery(recovery, services);
    } catch (error) {
      return { ...recovery, lastError: errorMessage(error) };
    }
  }

  if (recovery.phase === "persist_replacement") {
    try {
      const persisted = await services.availability.persistReplacement(recovery.persistence);
      if (!persisted.activationCurrent || persisted.replacement === null) {
        throw new Error("Reviewer replacement recovery persistence rejected durable provider effects");
      }
      if (recovery.finalizer === null) return null;
      recovery = {
        ...recovery,
        phase: "run_finalizer",
        replacementId: persisted.replacement.id,
        persistence: null,
      } as ReviewerReplacementFinalizerRecovery;
    } catch (error) {
      return { ...recovery, lastError: errorMessage(error) };
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
      return { ...recovery, lastError: errorMessage(error) };
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
      return { ...recovery, lastError: errorMessage(error) };
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
  if (recovery.replacementId === null) return;
  await assertPendingFinalizerMatchesRecovery(recovery, services);
  const updated = await services.availability.updateReplacementState({
    replacementId: recovery.replacementId,
    expectedState: "finalizer_pending",
    state: "permanent_failure",
    lastError: error,
  });
  if (updated === null) throw new Error("Exhausted reviewer replacement recovery was not persisted");
}

async function assertPendingFinalizerMatchesRecovery(
  recovery: ReviewerReplacementFinalizerRecovery,
  services: ReviewerAvailabilityServices,
): Promise<void> {
  if (recovery.replacementId === null) {
    throw new Error("Reviewer replacement recovery has no durable replacement identity");
  }
  const pending = await services.availability.listPendingFinalizers({
    absenceId: recovery.job.absenceId,
    absenceRevision: recovery.job.absenceRevision,
  });
  const record = pending.find((candidate) => candidate.id === recovery.replacementId);
  if (
    record === undefined
    || record.decisionId !== recovery.finalizer?.decisionId
    || record.outcome !== recovery.outcome
    || record.replacementActorId !== recovery.replacementActorId
    || record.mutationIntentId !== recovery.mutationIntentId
  ) throw new Error("Reviewer replacement recovery does not match durable pending finalizer provenance");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
