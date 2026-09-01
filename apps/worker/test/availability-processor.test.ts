import { describe, expect, it, vi } from "vitest";
import {
  parseReviewerMutationIntentId,
  type PersistReviewerReplacementInput,
  type ReviewerAvailabilityPorts,
  type ReviewerReplacementFinalizerRecovery,
} from "@triagepilot/application";

import {
  markReviewerReplacementRecoveryExhausted,
  processReviewerAbsenceActivationJob,
  recoverReviewerReplacementFinalizer,
} from "../src/availability-processor";

const job = {
  kind: "activate_reviewer_absence" as const,
  workspaceId: "workspace-1",
  provider: "github" as const,
  providerConnectionId: "connection-1",
  absenceId: "absence-1",
  absenceRevision: 2,
};
const mutationIntentId = parseReviewerMutationIntentId("intent-1");

describe("reviewer absence availability processor", () => {
  it("calls the Task 8 activation use case and returns no recovery after a stale activation", async () => {
    const services = buildServices();

    await expect(processReviewerAbsenceActivationJob(job, services)).resolves.toBeNull();

    expect(services.availability.listPendingFinalizers).toHaveBeenCalledWith({
      absenceId: "absence-1",
      absenceRevision: 2,
    });
    expect(services.availability.loadActivation).toHaveBeenCalledWith("absence-1", 2);
    expect(services.provider.inspectChangeRequest).not.toHaveBeenCalled();
  });

  it("persists provider-effect recovery and runs only its mapped finalizer", async () => {
    const services = buildServices();
    const recovery = replacedRecovery("persist_replacement");
    services.availability.persistReplacement = vi.fn(async () => ({
      inserted: true,
      activationCurrent: true,
      replacement: { id: "replacement-1", state: "finalizer_pending" as const },
    }));

    await expect(recoverReviewerReplacementFinalizer(recovery, services)).resolves.toBeNull();

    expect(services.availability.persistReplacement).toHaveBeenCalledWith(recovery.persistence);
    expect(services.finalizers.run).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      providerConnectionId: "connection-1",
      decisionId: "decision-1",
      action: "reevaluate_policy",
      summary: null,
    });
    expect(services.availability.updateReplacementState).toHaveBeenCalledWith({
      replacementId: "replacement-1",
      expectedState: "finalizer_pending",
      state: "completed",
      lastError: null,
    });
    expect(services.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(services.provider.reconcileReviewRequest).not.toHaveBeenCalled();
  });

  it("replays a pending finalizer without repeating persistence or provider effects", async () => {
    const services = buildServices();
    const recovery = replacedRecovery("run_finalizer");
    expectPendingRecovery(services, recovery);

    await expect(recoverReviewerReplacementFinalizer(recovery, services)).resolves.toBeNull();

    expect(services.availability.persistReplacement).not.toHaveBeenCalled();
    expect(services.finalizers.run).toHaveBeenCalledOnce();
    expect(services.availability.updateReplacementState).toHaveBeenCalledOnce();
    expect(services.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(services.provider.reconcileReviewRequest).not.toHaveBeenCalled();
  });

  it("completes a replacement after process death without rerunning its finalizer", async () => {
    const services = buildServices();
    const recovery = replacedRecovery("complete_replacement");
    expectPendingRecovery(services, recovery);

    await expect(recoverReviewerReplacementFinalizer(recovery, services)).resolves.toBeNull();

    expect(services.availability.persistReplacement).not.toHaveBeenCalled();
    expect(services.finalizers.run).not.toHaveBeenCalled();
    expect(services.availability.updateReplacementState).toHaveBeenCalledOnce();
    expect(services.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(services.provider.reconcileReviewRequest).not.toHaveBeenCalled();
  });

  it("persists null-finalizer permanent partial mutation recovery without provider or policy writes", async () => {
    const services = buildServices();
    const recovery = permanentFailureRecovery();
    services.availability.persistReplacement = vi.fn(async () => ({
      inserted: true,
      activationCurrent: true,
      replacement: { id: "replacement-1", state: "permanent_failure" as const },
    }));

    await expect(recoverReviewerReplacementFinalizer(recovery, services)).resolves.toBeNull();

    expect(services.availability.persistReplacement).toHaveBeenCalledWith(recovery.persistence);
    expect(services.finalizers.run).not.toHaveBeenCalled();
    expect(services.availability.updateReplacementState).not.toHaveBeenCalled();
    expect(services.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(services.provider.reconcileReviewRequest).not.toHaveBeenCalled();
  });

  it("validates complete recovery provenance before any replay side effect", async () => {
    const services = buildServices();
    const malformed = {
      ...replacedRecovery("run_finalizer"),
      mutationIntentId: " ",
    };

    await expect(recoverReviewerReplacementFinalizer(malformed as never, services))
      .rejects.toThrow("durable mutation provenance");

    expect(services.availability.persistReplacement).not.toHaveBeenCalled();
    expect(services.finalizers.run).not.toHaveBeenCalled();
    expect(services.availability.updateReplacementState).not.toHaveBeenCalled();
  });

  it("records exhausted mapped recovery in replacement history without replaying writes", async () => {
    const services = buildServices();
    const recovery = replacedRecovery("run_finalizer");
    expectPendingRecovery(services, recovery);

    await markReviewerReplacementRecoveryExhausted(recovery, services, "policy finalizer exhausted");

    expect(services.availability.updateReplacementState).toHaveBeenCalledWith({
      replacementId: "replacement-1",
      expectedState: "finalizer_pending",
      state: "permanent_failure",
      lastError: "policy finalizer exhausted",
    });
    expect(services.finalizers.run).not.toHaveBeenCalled();
    expect(services.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(services.provider.reconcileReviewRequest).not.toHaveBeenCalled();
  });

  it("fails closed before a finalizer when recovery does not match durable pending history", async () => {
    const services = buildServices();
    const recovery = replacedRecovery("run_finalizer");
    services.availability.listPendingFinalizers = vi.fn(async () => [{
      id: "replacement-1",
      decisionId: "different-decision",
      state: "finalizer_pending" as const,
      outcome: "replaced" as const,
      replacementActorId: "@user-b71d93",
      mutationIntentId,
    }]);

    await expect(recoverReviewerReplacementFinalizer(recovery, services)).resolves.toMatchObject({
      phase: "run_finalizer",
      lastError: "Reviewer replacement recovery does not match durable pending finalizer provenance",
    });

    expect(services.finalizers.run).not.toHaveBeenCalled();
    expect(services.availability.updateReplacementState).not.toHaveBeenCalled();
  });
});

function buildServices(): ReviewerAvailabilityPorts {
  return {
    clock: { now: () => new Date("2026-09-01T12:00:00.000Z") },
    availability: {
      listPendingFinalizers: vi.fn(async () => []),
      loadActivation: vi.fn(async () => null),
      loadMutationIntent: vi.fn(async () => null),
      prepareMutationIntent: vi.fn(async () => { throw new Error("not expected"); }),
      findActive: vi.fn(async () => []),
      persistReplacement: vi.fn(async () => { throw new Error("not expected"); }),
      updateReplacementState: vi.fn(async (input) => ({ id: input.replacementId, state: input.state })),
    },
    provider: {
      inspectChangeRequest: vi.fn(async () => { throw new Error("not expected"); }),
      reconcileReviewRequest: vi.fn(async () => { throw new Error("not expected"); }),
      classifyError: vi.fn(() => ({ kind: "retryable" as const, message: "retry" })),
    },
    reviewerLoad: vi.fn(async () => ({})),
    finalizers: { run: vi.fn(async () => {}) },
  };
}

function persistence(outcome: "replaced" | "permanent_failure"): PersistReviewerReplacementInput {
  const completedAt = new Date("2026-09-01T12:00:00.000Z");
  const replacementActorId = outcome === "replaced" ? "@user-b71d93" : null;
  return {
    provider: "github",
    providerConnectionId: "connection-1",
    absenceId: "absence-1",
    absenceRevision: 2,
    decisionId: "decision-1",
    expectedHeadRevision: "head-1",
    unavailableActorId: "@user-a62c84",
    replacementActorId,
    mutationIntentId,
    outcome,
    reason: outcome === "replaced" ? "replacement applied" : "provider rejected after a partial mutation",
    state: outcome === "replaced" ? "finalizer_pending" : "permanent_failure",
    lastError: outcome === "replaced" ? null : "provider rejected after a partial mutation",
    startedAt: completedAt,
    completedAt,
    replaceCohort: outcome === "replaced",
    event: {
      schemaVersion: 1,
      eventType: "reviewer_replacement",
      eventId: "replacement-event-1",
      occurredAt: completedAt.toISOString(),
      workspaceId: "workspace-1",
      provider: "github",
      providerConnectionId: "connection-1",
      absenceId: "absence-1",
      absenceRevision: 2,
      decisionId: "decision-1",
      repositoryId: "repository-1",
      changeRequestId: "change-request-1",
      unavailableActor: "@user-a62c84",
      replacementActor: replacementActorId,
      outcome,
    },
  } as PersistReviewerReplacementInput;
}

function replacedRecovery(
  phase: "persist_replacement" | "run_finalizer" | "complete_replacement",
): ReviewerReplacementFinalizerRecovery {
  return {
    kind: "reviewer_replacement_finalizer",
    phase,
    job,
    finalizer: { action: "reevaluate_policy", decisionId: "decision-1", summary: null },
    replacementId: phase === "persist_replacement" ? null : "replacement-1",
    outcome: "replaced",
    replacementActorId: "@user-b71d93",
    mutationIntentId,
    providerEffectsApplied: true,
    persistence: phase === "persist_replacement" ? persistence("replaced") : null,
    lastError: "database unavailable",
  } as ReviewerReplacementFinalizerRecovery;
}

function permanentFailureRecovery(): ReviewerReplacementFinalizerRecovery {
  return {
    kind: "reviewer_replacement_finalizer",
    phase: "persist_replacement",
    job,
    finalizer: null,
    replacementId: null,
    outcome: "permanent_failure",
    replacementActorId: null,
    mutationIntentId,
    providerEffectsApplied: true,
    persistence: persistence("permanent_failure") as never,
    lastError: "database unavailable",
  };
}

function expectPendingRecovery(
  services: ReviewerAvailabilityPorts,
  recovery: ReviewerReplacementFinalizerRecovery,
): void {
  services.availability.listPendingFinalizers = vi.fn(async () => [{
    id: recovery.replacementId!,
    decisionId: recovery.finalizer!.decisionId,
    state: "finalizer_pending" as const,
    outcome: recovery.outcome as "replaced",
    replacementActorId: recovery.replacementActorId,
    mutationIntentId: recovery.mutationIntentId,
  }] as never);
}
