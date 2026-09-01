import { describe, expect, it, vi } from "vitest";

import {
  activateReviewerAbsence,
  assertPersistReviewerReplacementInput,
  assertReviewerReplacementFinalizerRecovery,
  assertReviewerReplacementRecoveryRecord,
  parseReviewerMutationIntentId,
  type ReviewerAbsenceActivation,
  type ReviewerAvailabilityPorts,
  type ReviewerReplacementCandidateDecision,
  type ReviewerReplacementFinalizerRecord,
  type ReviewerReplacementProviderState,
} from "../src/reviewer-availability";

const activationAt = new Date("2026-09-01T10:00:00.000Z");
const completionAt = new Date("2026-09-01T10:00:01.000Z");
const job = {
  kind: "activate_reviewer_absence" as const,
  workspaceId: "workspace-1",
  providerConnectionId: "connection-1",
  absenceId: "absence-1",
  absenceRevision: 2,
};

const candidate: ReviewerReplacementCandidateDecision = {
  decisionId: "decision-1",
  provider: "github",
  providerConnectionId: job.providerConnectionId,
  repository: {
    provider: "github",
    externalId: "repository-101",
    owner: "acme",
    name: "api",
  },
  changeRequestId: "change-request-7",
  changeRequestNumber: 7,
  routedHeadRevision: "head-1",
  mode: "enforce",
  selectedActors: ["@user-d82a5f"],
  originalPreferredActors: ["@user-c91e46"],
  originalEligibleActors: ["@user-d82a5f", "@user-c91e46", "@user-f37a82"],
  requestedReviewerCount: 1,
  policyCheckState: "in_progress",
};

const activation: ReviewerAbsenceActivation = {
  absenceId: job.absenceId,
  revision: job.absenceRevision,
  provider: "github",
  providerConnectionId: job.providerConnectionId,
  externalActorId: "@user-d82a5f",
  startAt: new Date("2026-09-01T09:00:00.000Z"),
  endAt: new Date("2026-09-01T17:00:00.000Z"),
  candidates: [candidate],
};
const replacementScope = {
  workspaceId: job.workspaceId,
  provider: "github" as const,
  providerConnectionId: job.providerConnectionId,
  absenceId: job.absenceId,
  absenceRevision: job.absenceRevision,
  unavailableActorId: activation.externalActorId,
};

const providerState: ReviewerReplacementProviderState = {
  state: "open",
  currentHeadRevision: candidate.routedHeadRevision,
  authorActor: "@user-a91f5c",
  requestedActors: [activation.externalActorId],
  reviews: [],
};

const preparedIntent = {
  id: parseReviewerMutationIntentId("reviewer-mutation-intent-1"),
  workspaceId: job.workspaceId,
  provider: candidate.provider,
  providerConnectionId: job.providerConnectionId,
  absenceId: job.absenceId,
  absenceRevision: job.absenceRevision,
  decisionId: candidate.decisionId,
  repositoryId: candidate.repository.externalId,
  changeRequestId: candidate.changeRequestId,
  expectedHeadRevision: candidate.routedHeadRevision,
  unavailableActorId: activation.externalActorId,
  replacementActorId: "@user-c91e46",
};

function buildPorts(overrides: Partial<ReviewerAvailabilityPorts> = {}): ReviewerAvailabilityPorts {
  const clockValues = [activationAt, completionAt];
  const availability = {
    listPendingFinalizers: vi.fn(async () => []),
    loadReplacement: vi.fn(async () => null),
    loadActivation: vi.fn(async () => activation),
    listUnfinalizedMutationIntents: vi.fn(async () => []),
    loadMutationIntent: vi.fn(async () => null),
    prepareMutationIntent: vi.fn(async (input) => ({ id: preparedIntent.id, ...input })),
    findActive: vi.fn(async () => []),
    persistReplacement: vi.fn(async (input) => ({
      inserted: true,
      activationCurrent: true,
      replacement: { id: "replacement-1", state: input.state },
    })),
    persistMutationIntentRecovery: vi.fn(async (input) => ({
      inserted: true,
      activationCurrent: true,
      replacement: { id: "recovery-1", state: input.state },
    })),
    updateReplacementState: vi.fn(async (input) => ({ id: input.replacementId, state: input.state })),
  };
  const provider = {
    inspectChangeRequest: vi.fn(async () => providerState),
    reconcileReviewRequest: vi.fn(async () => ({ changed: true })),
    classifyError: vi.fn((error: unknown) => ({
      kind: "retryable" as const,
      message: error instanceof Error ? error.message : String(error),
    })),
  };
  const finalizers = {
    run: vi.fn(async () => {}),
    classifyError: vi.fn((error: unknown) => ({
      kind: "retryable" as const,
      message: error instanceof Error ? error.message : String(error),
    })),
  };
  return {
    clock: overrides.clock ?? { now: vi.fn(() => clockValues.shift() ?? completionAt) },
    availability: { ...availability, ...overrides.availability },
    provider: { ...provider, ...overrides.provider },
    reviewerLoad: overrides.reviewerLoad
      ?? vi.fn(async () => ({ "@user-c91e46": 0, "@user-f37a82": 1 })),
    finalizers: { ...finalizers, ...overrides.finalizers },
  };
}

function nonMutationPersistence(outcome: "permanent_failure" | "no_replacement_available") {
  const lastError = outcome === "permanent_failure" ? "provider failed" : null;
  return {
    provider: candidate.provider,
    providerConnectionId: job.providerConnectionId,
    absenceId: job.absenceId,
    absenceRevision: job.absenceRevision,
    decisionId: candidate.decisionId,
    expectedHeadRevision: candidate.routedHeadRevision,
    unavailableActorId: activation.externalActorId,
    replacementActorId: null,
    mutationIntentId: outcome === "permanent_failure" ? preparedIntent.id : null,
    outcome,
    reason: "terminal outcome",
    state: outcome === "permanent_failure" ? "permanent_failure" : "finalizer_pending",
    lastError,
    startedAt: activationAt,
    completedAt: completionAt,
    replaceCohort: false,
    event: {
      schemaVersion: 1,
      eventType: "reviewer_replacement",
      eventId: "replacement-event-state-validation",
      occurredAt: completionAt.toISOString(),
      workspaceId: job.workspaceId,
      provider: candidate.provider,
      providerConnectionId: job.providerConnectionId,
      absenceId: job.absenceId,
      absenceRevision: job.absenceRevision,
      decisionId: candidate.decisionId,
      repositoryId: candidate.repository.externalId,
      changeRequestId: candidate.changeRequestId,
      unavailableActor: activation.externalActorId,
      replacementActor: null,
      outcome,
    },
  };
}

describe("activateReviewerAbsence", () => {
  it("rejects a replaced pending finalizer without mutation provenance before replay", async () => {
    const ports = buildPorts({
      availability: {
        listPendingFinalizers: vi.fn(async () => [{
          id: "replacement-malformed",
          ...replacementScope,
          decisionId: candidate.decisionId,
          replacementActorId: null,
          mutationIntentId: null,
          outcome: "replaced",
          state: "finalizer_pending",
        }] as ReviewerReplacementFinalizerRecord[]),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).rejects.toThrow(
      "Replaced reviewer outcome requires durable mutation provenance",
    );

    expect(ports.finalizers.run).not.toHaveBeenCalled();
    expect(ports.availability.updateReplacementState).not.toHaveBeenCalled();
    expect(ports.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
  });

  it("rejects malformed replaced persistence and recovery at runtime validation boundaries", async () => {
    let validPersistence: unknown;
    const ports = buildPorts({
      availability: {
        persistReplacement: vi.fn(async (input) => {
          validPersistence = input;
          throw new Error("database unavailable");
        }),
      } as never,
    });
    const outcome = await activateReviewerAbsence(job, ports);
    expect(outcome.status).toBe("finalizer_pending");
    if (outcome.status !== "finalizer_pending") throw new Error("Expected replacement recovery");

    expect(() => assertPersistReviewerReplacementInput({
      ...(validPersistence as object),
      mutationIntentId: "   ",
    })).toThrow("Replaced reviewer outcome requires durable mutation provenance");
    expect(() => assertReviewerReplacementFinalizerRecovery({
      ...outcome.recovery,
      mutationIntentId: null,
    })).toThrow("Provider-effect recovery requires durable mutation provenance");
    expect(() => assertReviewerReplacementFinalizerRecovery({
      ...outcome.recovery,
      phase: "run_finalizer",
      replacementId: "replacement-1",
    })).toThrow("Reviewer replacement finalizer recovery is malformed");
  });

  it.each([
    ["permanent_failure", "completed", "provider failed"],
    ["permanent_failure", "finalizer_pending", "provider failed"],
    ["skipped_closed", "finalizer_pending", null],
  ] as const)("rejects malformed recovery record state %s/%s", (outcome, state, lastError) => {
    expect(() => assertReviewerReplacementRecoveryRecord({
      id: "replacement-1",
      ...replacementScope,
      decisionId: "decision-1",
      state,
      outcome,
      replacementActorId: null,
      mutationIntentId: outcome === "permanent_failure" ? "intent-1" : null,
      lastError,
    })).toThrow("Reviewer replacement recovery state is malformed");
  });

  it("accepts a completed exact replacement for post-commit recovery", () => {
    expect(() => assertReviewerReplacementRecoveryRecord({
      id: "replacement-1",
      ...replacementScope,
      decisionId: "decision-1",
      state: "completed",
      outcome: "replaced",
      replacementActorId: "@user-c91e46",
      mutationIntentId: "intent-1",
      lastError: null,
    })).not.toThrow();
  });

  it("treats a stale or cancelled absence revision as a successful job-level no-op", async () => {
    const ports = buildPorts({
      availability: { loadActivation: vi.fn(async () => null) } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toEqual({
      status: "skipped",
      reason: "stale_activation",
      results: [],
    });

    expect(ports.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).not.toHaveBeenCalled();
  });

  it("audits an unfinalized durable intent before treating a stale activation as complete", async () => {
    const persistMutationIntentRecovery = vi.fn(async (input) => ({
      inserted: true,
      activationCurrent: true,
      replacement: { id: "audit-1", state: input.state },
    }));
    const ports = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => null),
        listUnfinalizedMutationIntents: vi.fn(async () => [preparedIntent]),
        persistMutationIntentRecovery,
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{
        decisionId: preparedIntent.decisionId,
        outcome: "permanent_failure",
        mutationIntentId: preparedIntent.id,
      }],
    });

    expect(persistMutationIntentRecovery).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "permanent_failure",
      state: "permanent_failure",
      mutationIntentId: preparedIntent.id,
      replaceCohort: false,
    }));
    expect(ports.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["permanent_failure", "completed", "provider failed"],
    ["permanent_failure", "finalizer_pending", "provider failed"],
    ["no_replacement_available", "completed", null],
  ])("rejects invalid persistence outcome/state %s/%s", (outcome, state, lastError) => {
    const valid = nonMutationPersistence(outcome === "permanent_failure" ? "permanent_failure" : "no_replacement_available");
    expect(() => assertPersistReviewerReplacementInput({
      ...valid,
      outcome,
      state,
      lastError,
      event: { ...valid.event, outcome },
    })).toThrow("state");
  });

  it("does not process an absence outside its half-open activation window", async () => {
    const ports = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => ({
          ...activation,
          startAt: new Date("2026-09-01T10:00:00.001Z"),
        })),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toEqual({
      status: "skipped",
      reason: "inactive_activation",
      results: [],
    });

    expect(ports.provider.inspectChangeRequest).not.toHaveBeenCalled();
  });

  it("records a closed change request without provider mutations", async () => {
    const ports = buildPorts({
      provider: {
        inspectChangeRequest: vi.fn(async () => ({ ...providerState, state: "closed" })),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ decisionId: candidate.decisionId, outcome: "skipped_closed", replacementActor: null }],
    });

    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "skipped_closed",
      replacementActorId: null,
      replaceCohort: false,
      state: "completed",
    }));
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.finalizers.run).not.toHaveBeenCalled();
  });

  it("re-reads the current head immediately before writes and records a changed-head no-op", async () => {
    const inspectChangeRequest = vi
      .fn()
      .mockResolvedValueOnce(providerState)
      .mockResolvedValueOnce({ ...providerState, currentHeadRevision: "head-2" });
    const ports = buildPorts({ provider: { inspectChangeRequest } as never });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "skipped_changed_head", replacementActor: null }],
    });

    expect(inspectChangeRequest).toHaveBeenCalledTimes(2);
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "skipped_changed_head",
      replaceCohort: false,
    }));
  });

  it("re-reads current state immediately before persistence and records a newly closed request", async () => {
    const inspectChangeRequest = vi
      .fn()
      .mockResolvedValueOnce(providerState)
      .mockResolvedValueOnce({ ...providerState, state: "closed" });
    const ports = buildPorts({ provider: { inspectChangeRequest } as never });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "skipped_closed", replacementActor: null }],
    });

    expect(inspectChangeRequest).toHaveBeenCalledTimes(2);
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "skipped_closed",
      state: "completed",
    }));
  });

  it("leaves the cohort unchanged when the unavailable actor already approved", async () => {
    const approvedCandidate = { ...candidate, requestedReviewerCount: 2 as const };
    const ports = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => ({ ...activation, candidates: [approvedCandidate] })),
      } as never,
      provider: {
        inspectChangeRequest: vi.fn(async () => ({
          ...providerState,
          reviews: [{
            actor: activation.externalActorId,
            actorType: "human",
            state: "approved",
            submittedAt: "2026-08-31T09:00:00.000Z",
          }],
        })),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      results: [{ outcome: "skipped_approved", replacementActor: null }],
    });

    expect(ports.availability.findActive).not.toHaveBeenCalled();
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.finalizers.run).not.toHaveBeenCalled();
  });

  it("honors approvals arriving before the enforce write without over-requesting", async () => {
    const satisfiedState = {
      ...providerState,
      reviews: [{
        actor: "@user-5c9f21",
        actorType: "human",
        state: "approved",
        submittedAt: "2026-09-01T10:00:00.500Z",
      }],
    };
    const inspectChangeRequest = vi.fn().mockResolvedValueOnce(providerState).mockResolvedValueOnce(satisfiedState);
    const ports = buildPorts({ provider: { inspectChangeRequest } as never });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      results: [{ outcome: "skipped_policy_satisfied", replacementActor: null }],
    });

    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "skipped_policy_satisfied",
      state: "finalizer_pending",
    }));
    expect(ports.finalizers.run).toHaveBeenCalledWith({
      workspaceId: job.workspaceId,
      providerConnectionId: job.providerConnectionId,
      decisionId: candidate.decisionId,
      action: "reevaluate_policy",
      summary: null,
    });
  });

  it("records an already-terminal failed policy without provider reads or writes", async () => {
    const terminalCandidate = { ...candidate, policyCheckState: "failure" as const };
    const ports = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => ({ ...activation, candidates: [terminalCandidate] })),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "permanent_failure", replacementActor: null }],
    });

    expect(ports.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.finalizers.run).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "permanent_failure",
      state: "permanent_failure",
      lastError: "Human-review policy is already in a terminal failure state.",
      replaceCohort: false,
    }));
  });

  it.each([
    ["success", "skipped_policy_satisfied"],
    ["failure", "permanent_failure"],
  ] as const)(
    "loads and retains an existing durable intent before a %s policy shortcut",
    async (policyCheckState, outcome) => {
      const terminalCandidate = { ...candidate, policyCheckState };
      const loadMutationIntent = vi.fn(async () => preparedIntent);
      const ports = buildPorts({
        availability: {
          loadActivation: vi.fn(async () => ({ ...activation, candidates: [terminalCandidate] })),
          loadMutationIntent,
        } as never,
      });

      await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
        status: "completed",
        results: [{ outcome, mutationIntentId: preparedIntent.id }],
      });

      expect(loadMutationIntent).toHaveBeenCalledOnce();
      expect(ports.provider.inspectChangeRequest).not.toHaveBeenCalled();
      expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
      expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
        outcome,
        mutationIntentId: preparedIntent.id,
      }));
    },
  );

  it.each([
    ["wrong source", { ...preparedIntent, repositoryId: "repository-elsewhere" }],
    ["invalid actor", { ...preparedIntent, replacementActorId: "@user-unknown" }],
  ])("validates a loaded intent before a provider policy shortcut can change between reads: %s", async (_name, intent) => {
    const inspectChangeRequest = vi.fn()
      .mockResolvedValueOnce({
        ...providerState,
        reviews: [{
          actor: "@user-5c9f21",
          actorType: "human",
          state: "approved",
          commitId: candidate.routedHeadRevision,
          submittedAt: "2026-09-01T10:00:00.500Z",
        }],
      })
      .mockResolvedValueOnce(providerState);
    const ports = buildPorts({
      availability: {
        loadMutationIntent: vi.fn(async () => intent),
      } as never,
      provider: { inspectChangeRequest } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "permanent_failure", mutationIntentId: intent.id }],
    });

    expect(ports.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "permanent_failure",
      mutationIntentId: intent.id,
      lastError: "Durable reviewer mutation intent does not match the immutable activation source.",
    }));
  });

  it("rejects an existing durable intent that targets the current change-request author", async () => {
    const ports = buildPorts({
      availability: {
        loadMutationIntent: vi.fn(async () => preparedIntent),
      } as never,
      provider: {
        inspectChangeRequest: vi.fn(async () => ({
          ...providerState,
          authorActor: preparedIntent.replacementActorId,
        })),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{
        outcome: "permanent_failure",
        replacementActor: null,
        mutationIntentId: preparedIntent.id,
      }],
    });

    expect(ports.provider.inspectChangeRequest).toHaveBeenCalledTimes(2);
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "permanent_failure",
      replacementActorId: null,
      mutationIntentId: preparedIntent.id,
      lastError: `Durable replacement actor ${preparedIntent.replacementActorId} is the current change-request author.`,
    }));
  });

  it("revalidates author drift after prepare and process death while retaining intent linkage on persistence retry", async () => {
    let durableIntent: typeof preparedIntent | null = null;
    const loadMutationIntent = vi.fn(async () => durableIntent);
    const prepareMutationIntent = vi.fn(async (input: Omit<typeof preparedIntent, "id">) => {
      durableIntent ??= { id: preparedIntent.id, ...input };
      return durableIntent;
    });
    const reconcileReviewRequest = vi.fn(async () => ({ changed: true }));
    const firstInspect = vi.fn()
      .mockResolvedValueOnce(providerState)
      .mockRejectedValueOnce(new Error("process terminated after intent prepare"));
    const firstPorts = buildPorts({
      availability: { loadMutationIntent, prepareMutationIntent } as never,
      provider: { inspectChangeRequest: firstInspect, reconcileReviewRequest } as never,
    });

    await expect(activateReviewerAbsence(job, firstPorts)).rejects.toThrow(
      "process terminated after intent prepare",
    );
    expect(durableIntent).toMatchObject({
      id: preparedIntent.id,
      replacementActorId: preparedIntent.replacementActorId,
    });
    expect(reconcileReviewRequest).not.toHaveBeenCalled();
    expect(firstPorts.availability.persistReplacement).not.toHaveBeenCalled();

    const authorChangedState = {
      ...providerState,
      authorActor: preparedIntent.replacementActorId,
    };
    const persistReplacement = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementationOnce(async (input) => ({
        inserted: true,
        activationCurrent: true,
        replacement: { id: "replacement-1", state: input.state },
      }));
    const retryPorts = buildPorts({
      availability: { loadMutationIntent, prepareMutationIntent, persistReplacement } as never,
      provider: {
        inspectChangeRequest: vi.fn(async () => authorChangedState),
        reconcileReviewRequest,
      } as never,
    });

    await expect(activateReviewerAbsence(job, retryPorts)).rejects.toThrow("database unavailable");
    expect(reconcileReviewRequest).not.toHaveBeenCalled();
    expect(persistReplacement).toHaveBeenNthCalledWith(1, expect.objectContaining({
      outcome: "permanent_failure",
      replacementActorId: null,
      mutationIntentId: preparedIntent.id,
    }));

    const finalRetryPorts = buildPorts({
      availability: { loadMutationIntent, prepareMutationIntent, persistReplacement } as never,
      provider: {
        inspectChangeRequest: vi.fn(async () => authorChangedState),
        reconcileReviewRequest,
      } as never,
    });
    await expect(activateReviewerAbsence(job, finalRetryPorts)).resolves.toMatchObject({
      status: "completed",
      results: [{
        outcome: "permanent_failure",
        replacementActor: null,
        mutationIntentId: preparedIntent.id,
      }],
    });

    expect(prepareMutationIntent).toHaveBeenCalledOnce();
    expect(reconcileReviewRequest).not.toHaveBeenCalled();
    expect(persistReplacement).toHaveBeenNthCalledWith(2, expect.objectContaining({
      outcome: "permanent_failure",
      replacementActorId: null,
      mutationIntentId: preparedIntent.id,
      lastError: `Durable replacement actor ${preparedIntent.replacementActorId} is the current change-request author.`,
    }));
  });

  it("never expands replacement eligibility beyond the immutable original pool", async () => {
    const immutableCandidate = {
      ...candidate,
      originalPreferredActors: ["@user-5c9f21"],
      originalEligibleActors: [activation.externalActorId, "@user-f37a82"],
    };
    const ports = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => ({ ...activation, candidates: [immutableCandidate] })),
      } as never,
      reviewerLoad: vi.fn(async () => ({ "@user-5c9f21": 0, "@user-f37a82": 9 })),
    });

    await activateReviewerAbsence(job, ports);

    expect(ports.reviewerLoad).toHaveBeenCalledWith({
      workspaceId: job.workspaceId,
      actors: [activation.externalActorId, "@user-f37a82"],
    });
    expect(ports.provider.reconcileReviewRequest).toHaveBeenCalledWith(expect.objectContaining({
      replacementActor: "@user-f37a82",
    }));
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalledWith(expect.objectContaining({
      replacementActor: "@user-5c9f21",
    }));
  });

  it("stages the exact replacement event from one captured activation instant and one completion instant", async () => {
    const ports = buildPorts();

    await activateReviewerAbsence(job, ports);

    expect(ports.clock.now).toHaveBeenCalledTimes(2);
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith({
      provider: "github",
      providerConnectionId: job.providerConnectionId,
      absenceId: job.absenceId,
      absenceRevision: job.absenceRevision,
      decisionId: candidate.decisionId,
      expectedHeadRevision: candidate.routedHeadRevision,
      unavailableActorId: activation.externalActorId,
      replacementActorId: "@user-c91e46",
      mutationIntentId: preparedIntent.id,
      outcome: "replaced",
      reason: `Replaced unavailable actor ${activation.externalActorId} with @user-c91e46.`,
      state: "finalizer_pending",
      lastError: null,
      startedAt: activationAt,
      completedAt: completionAt,
      replaceCohort: true,
      event: {
        schemaVersion: 1,
        eventType: "reviewer_replacement",
        eventId: `reviewer-replacement:${job.absenceId}:revision:${job.absenceRevision}:decision:${candidate.decisionId}:v1`,
        occurredAt: completionAt.toISOString(),
        workspaceId: job.workspaceId,
        provider: "github",
        providerConnectionId: job.providerConnectionId,
        absenceId: job.absenceId,
        absenceRevision: job.absenceRevision,
        decisionId: candidate.decisionId,
        repositoryId: candidate.repository.externalId,
        changeRequestId: candidate.changeRequestId,
        unavailableActor: activation.externalActorId,
        replacementActor: "@user-c91e46",
        outcome: "replaced",
      },
    });
  });

  it.each([
    {
      name: "preferred actor before a lower-load fallback",
      preferred: ["@user-c91e46"],
      absences: [],
      load: { "@user-c91e46": 9, "@user-f37a82": 0 },
      expected: "@user-c91e46",
    },
    {
      name: "fallback actor when the preferred actor is unavailable",
      preferred: ["@user-c91e46"],
      absences: [{
        externalActorId: "@user-c91e46",
        startAt: activation.startAt,
        endAt: activation.endAt,
      }],
      load: { "@user-c91e46": 0, "@user-f37a82": 4 },
      expected: "@user-f37a82",
    },
  ])("selects a $name", async ({ preferred, absences, load, expected }) => {
    const tieredCandidate = { ...candidate, originalPreferredActors: preferred };
    const ports = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => ({ ...activation, candidates: [tieredCandidate] })),
        findActive: vi.fn(async () => absences),
      } as never,
      reviewerLoad: vi.fn(async () => load),
    });

    await activateReviewerAbsence(job, ports);

    expect(ports.provider.reconcileReviewRequest).toHaveBeenCalledWith(expect.objectContaining({
      replacementActor: expected,
    }));
  });

  it("keeps a manually requested preferred actor eligible because provider requests are advisory", async () => {
    const inspectChangeRequest = vi.fn(async () => ({
      ...providerState,
      requestedActors: [activation.externalActorId, "@user-c91e46"],
    }));
    const ports = buildPorts({
      provider: { inspectChangeRequest } as never,
      reviewerLoad: vi.fn(async () => ({ "@user-c91e46": 9, "@user-f37a82": 0 })),
    });

    await activateReviewerAbsence(job, ports);

    expect(ports.availability.prepareMutationIntent).toHaveBeenCalledWith(expect.objectContaining({
      replacementActorId: "@user-c91e46",
    }));
    expect(ports.provider.reconcileReviewRequest).toHaveBeenCalledWith(expect.objectContaining({
      replacementActor: "@user-c91e46",
    }));
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalledWith(expect.objectContaining({
      replacementActor: "@user-f37a82",
    }));
  });

  it("records no replacement without lowering the approval requirement", async () => {
    const noReplacementCandidate = {
      ...candidate,
      originalPreferredActors: [activation.externalActorId],
      originalEligibleActors: [activation.externalActorId],
      requestedReviewerCount: 2 as const,
    };
    const ports = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => ({ ...activation, candidates: [noReplacementCandidate] })),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      results: [{ outcome: "no_replacement_available", replacementActor: null }],
    });

    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "no_replacement_available",
      replaceCohort: false,
    }));
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.finalizers.run).toHaveBeenCalledWith(expect.objectContaining({
      action: "fail_policy",
      summary: "No replacement is available for an absent required reviewer.",
    }));
    expect(ports.provider.inspectChangeRequest).toHaveBeenCalledTimes(2);
  });

  it("re-reads no-replacement state and honors an approval arriving before policy failure", async () => {
    const noReplacementCandidate = {
      ...candidate,
      originalPreferredActors: [activation.externalActorId],
      originalEligibleActors: [activation.externalActorId],
    };
    const inspectChangeRequest = vi
      .fn()
      .mockResolvedValueOnce(providerState)
      .mockResolvedValueOnce({
        ...providerState,
        reviews: [{
          actor: "@user-5c9f21",
          actorType: "human",
          state: "approved",
          submittedAt: "2026-09-01T10:00:00.500Z",
        }],
      });
    const ports = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => ({ ...activation, candidates: [noReplacementCandidate] })),
      } as never,
      provider: { inspectChangeRequest } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "skipped_policy_satisfied", replacementActor: null }],
    });

    expect(inspectChangeRequest).toHaveBeenCalledTimes(2);
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "skipped_policy_satisfied",
      state: "finalizer_pending",
    }));
    expect(ports.finalizers.run).toHaveBeenCalledWith(expect.objectContaining({
      action: "reevaluate_policy",
    }));
    expect(ports.finalizers.run).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "fail_policy",
    }));
  });

  it("retries a partial provider mutation without repeating the successful removal", async () => {
    const requestedActors = new Set(providerState.requestedActors);
    const effects: string[] = [];
    let firstAttempt = true;
    const provider = {
      inspectChangeRequest: vi.fn(async () => ({ ...providerState, requestedActors: [...requestedActors] })),
      reconcileReviewRequest: vi.fn(async (input: { unavailableActor: string; replacementActor: string }) => {
        if (requestedActors.delete(input.unavailableActor)) effects.push(`remove:${input.unavailableActor}`);
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error("replacement request unavailable");
        }
        if (!requestedActors.has(input.replacementActor)) {
          requestedActors.add(input.replacementActor);
          effects.push(`request:${input.replacementActor}`);
        }
        return { changed: true };
      }),
    };
    const persistReplacement = vi.fn(async (input) => ({
      inserted: true,
      activationCurrent: true,
      replacement: { id: "replacement-1", state: input.state },
    }));
    const firstPorts = buildPorts({ provider, availability: { persistReplacement } as never });

    await expect(activateReviewerAbsence(job, firstPorts)).rejects.toThrow("replacement request unavailable");
    expect(persistReplacement).not.toHaveBeenCalled();

    const retryPorts = buildPorts({ provider, availability: { persistReplacement } as never });
    await expect(activateReviewerAbsence(job, retryPorts)).resolves.toMatchObject({ status: "completed" });

    expect(effects).toEqual([
      `remove:${activation.externalActorId}`,
      "request:@user-c91e46",
    ]);
    expect(persistReplacement).toHaveBeenCalledTimes(1);
  });

  it("performs no provider mutation when durable intent preparation fails", async () => {
    const ports = buildPorts({
      availability: {
        prepareMutationIntent: vi.fn(async () => {
          throw new Error("intent store unavailable");
        }),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).rejects.toThrow("intent store unavailable");

    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).not.toHaveBeenCalled();
  });

  it("uses the policy-satisfied path when the durable replacement actor approved the current head", async () => {
    const inspectChangeRequest = vi
      .fn()
      .mockResolvedValueOnce(providerState)
      .mockResolvedValueOnce({
        ...providerState,
        reviews: [{
          actor: preparedIntent.replacementActorId,
          actorType: "human",
          state: "approved",
          commitId: candidate.routedHeadRevision,
          submittedAt: "2026-09-01T10:00:00.500Z",
        }],
      });
    const ports = buildPorts({
      availability: {
        loadMutationIntent: vi.fn(async () => preparedIntent),
      } as never,
      provider: { inspectChangeRequest } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "skipped_policy_satisfied", mutationIntentId: preparedIntent.id }],
    });

    expect(ports.availability.findActive).not.toHaveBeenCalled();
    expect(ports.reviewerLoad).not.toHaveBeenCalled();
    expect(ports.availability.prepareMutationIntent).not.toHaveBeenCalled();
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      mutationIntentId: preparedIntent.id,
      outcome: "skipped_policy_satisfied",
    }));
  });

  it("fails closed without provider writes when a durable replacement actor becomes absent", async () => {
    const replacementAbsence = {
      externalActorId: preparedIntent.replacementActorId,
      startAt: activation.startAt,
      endAt: activation.endAt,
    };
    const findActive = vi.fn(async () => [replacementAbsence]);
    const ports = buildPorts({
      availability: {
        loadMutationIntent: vi.fn(async () => preparedIntent),
        findActive,
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{
        outcome: "permanent_failure",
        replacementActor: null,
        mutationIntentId: preparedIntent.id,
      }],
    });

    expect(findActive).toHaveBeenCalledWith({
      workspaceId: job.workspaceId,
      providerConnectionId: job.providerConnectionId,
      actors: [preparedIntent.replacementActorId],
      at: activationAt,
    });
    expect(ports.reviewerLoad).not.toHaveBeenCalled();
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "permanent_failure",
      replacementActorId: null,
      mutationIntentId: preparedIntent.id,
      lastError: `Durable replacement actor ${preparedIntent.replacementActorId} is currently unavailable.`,
      state: "permanent_failure",
    }));
  });

  it("does not manufacture provider-effect recovery when an ineligible durable intent cannot persist", async () => {
    const ports = buildPorts({
      availability: {
        loadMutationIntent: vi.fn(async () => preparedIntent),
        findActive: vi.fn(async () => [{
          externalActorId: preparedIntent.replacementActorId,
          startAt: activation.startAt,
          endAt: activation.endAt,
        }]),
        persistReplacement: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).rejects.toThrow("database unavailable");
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
  });

  it("fails closed when the durable replacement actor approved the current head but policy remains unsatisfied", async () => {
    const twoApprovalCandidate = { ...candidate, requestedReviewerCount: 2 as const };
    const inspectChangeRequest = vi.fn(async () => ({
      ...providerState,
      reviews: [{
        actor: preparedIntent.replacementActorId,
        actorType: "human" as const,
        state: "approved",
        commitId: candidate.routedHeadRevision,
        submittedAt: "2026-09-01T10:00:00.500Z",
      }],
    }));
    const ports = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => ({ ...activation, candidates: [twoApprovalCandidate] })),
        loadMutationIntent: vi.fn(async () => preparedIntent),
      } as never,
      provider: { inspectChangeRequest } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "permanent_failure", mutationIntentId: preparedIntent.id }],
    });

    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "permanent_failure",
      mutationIntentId: preparedIntent.id,
      lastError: `Durable replacement actor ${preparedIntent.replacementActorId} already approved the current head.`,
    }));
  });

  it("loads and serializes durable intent when a fresh retry finds the request already closed", async () => {
    const loadMutationIntent = vi.fn(async () => preparedIntent);
    const ports = buildPorts({
      availability: { loadMutationIntent } as never,
      provider: {
        inspectChangeRequest: vi.fn(async () => ({ ...providerState, state: "closed" })),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "skipped_closed", mutationIntentId: preparedIntent.id }],
    });

    expect(loadMutationIntent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: job.workspaceId,
      absenceId: job.absenceId,
      absenceRevision: job.absenceRevision,
      decisionId: candidate.decisionId,
    }));
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      mutationIntentId: preparedIntent.id,
      outcome: "skipped_closed",
    }));
  });

  it("uses durable intent after prepare, DELETE, POST, and process death without selecting a second actor", async () => {
    const crashCandidate = {
      ...candidate,
      selectedActors: [activation.externalActorId, "@user-7c1f9b"],
      originalPreferredActors: ["@user-c91e46", "@user-f37a82"],
      originalEligibleActors: [
        activation.externalActorId,
        "@user-7c1f9b",
        "@user-c91e46",
        "@user-f37a82",
      ],
      requestedReviewerCount: 2 as const,
    };
    const requestedActors = new Set([activation.externalActorId, "@user-7c1f9b"]);
    const effects: string[] = [];
    const ordering: string[] = [];
    let durableIntent: typeof preparedIntent | null = null;
    const loadMutationIntent = vi.fn(async () => durableIntent);
    const prepareMutationIntent = vi.fn(async (input: Omit<typeof preparedIntent, "id">) => {
      ordering.push("prepare");
      durableIntent ??= { id: preparedIntent.id, ...input };
      return durableIntent;
    });
    const provider = {
      inspectChangeRequest: vi.fn(async () => {
        ordering.push("inspect");
        return { ...providerState, requestedActors: [...requestedActors] };
      }),
      reconcileReviewRequest: vi.fn(async (input: { unavailableActor: string; replacementActor: string }) => {
        ordering.push(`reconcile:${input.replacementActor}`);
        if (requestedActors.delete(input.unavailableActor)) effects.push(`remove:${input.unavailableActor}`);
        if (!requestedActors.has(input.replacementActor)) {
          requestedActors.add(input.replacementActor);
          effects.push(`request:${input.replacementActor}`);
        }
        return { changed: true };
      }),
      classifyError: vi.fn(() => ({ kind: "retryable" as const, message: "process terminated" })),
    };
    const firstPorts = buildPorts({
      clock: {
        now: vi.fn()
          .mockReturnValueOnce(activationAt)
          .mockImplementationOnce(() => {
            throw new Error("process terminated after provider response");
          }),
      },
      availability: {
        loadActivation: vi.fn(async () => ({ ...activation, candidates: [crashCandidate] })),
        loadMutationIntent,
        prepareMutationIntent,
        findActive: vi.fn(async () => []),
      } as never,
      provider,
      reviewerLoad: vi.fn(async () => ({ "@user-c91e46": 0, "@user-f37a82": 9 })),
    });

    await expect(activateReviewerAbsence(job, firstPorts)).rejects.toThrow(
      "process terminated after provider response",
    );
    expect(firstPorts.availability.persistReplacement).not.toHaveBeenCalled();
    expect(effects).toEqual([
      `remove:${activation.externalActorId}`,
      "request:@user-c91e46",
    ]);
    expect(ordering).toEqual(["inspect", "prepare", "inspect", "reconcile:@user-c91e46"]);
    expect(durableIntent).toMatchObject({
      id: preparedIntent.id,
      replacementActorId: "@user-c91e46",
    });

    const retryFindActive = vi.fn(async () => [{
      externalActorId: "@user-f37a82",
      startAt: activation.startAt,
      endAt: activation.endAt,
    }]);
    const retryLoad = vi.fn(async () => ({ "@user-c91e46": 99, "@user-f37a82": 0 }));
    const retryPorts = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => ({ ...activation, candidates: [crashCandidate] })),
        loadMutationIntent,
        prepareMutationIntent,
        findActive: retryFindActive,
      } as never,
      provider,
      reviewerLoad: retryLoad,
    });

    await expect(activateReviewerAbsence(job, retryPorts)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "replaced", replacementActor: "@user-c91e46" }],
    });

    expect(effects).toEqual([
      `remove:${activation.externalActorId}`,
      "request:@user-c91e46",
    ]);
    expect(retryPorts.provider.reconcileReviewRequest).toHaveBeenCalledTimes(2);
    expect(retryPorts.provider.reconcileReviewRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      replacementActor: "@user-c91e46",
    }));
    expect(prepareMutationIntent).toHaveBeenCalledOnce();
    expect(retryFindActive).toHaveBeenCalledWith({
      workspaceId: job.workspaceId,
      providerConnectionId: job.providerConnectionId,
      actors: [preparedIntent.replacementActorId],
      at: activationAt,
    });
    expect(retryLoad).not.toHaveBeenCalled();
    expect(retryPorts.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      replacementActorId: "@user-c91e46",
      mutationIntentId: preparedIntent.id,
      outcome: "replaced",
      replaceCohort: true,
    }));
    expect(retryPorts.finalizers.run).toHaveBeenCalledWith(expect.objectContaining({
      action: "reevaluate_policy",
    }));
  });

  it("never attributes a manual eligible request to prior application work without durable intent", async () => {
    const ports = buildPorts({
      provider: {
        inspectChangeRequest: vi.fn(async () => ({
          ...providerState,
          requestedActors: ["@user-c91e46"],
        })),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "replaced", replacementActor: "@user-c91e46" }],
    });

    expect(ports.reviewerLoad).toHaveBeenCalledOnce();
    expect(ports.availability.prepareMutationIntent).toHaveBeenCalledOnce();
    expect(ports.provider.reconcileReviewRequest).toHaveBeenCalledOnce();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "replaced",
      mutationIntentId: preparedIntent.id,
    }));
  });

  it.each(["inspection", "mutation"] as const)(
    "persists a permanent provider %s failure and continues later candidates",
    async (failurePoint) => {
      const laterCandidate = { ...candidate, decisionId: "decision-2", changeRequestNumber: 8 };
      let firstInspections = 0;
      const permanent = Object.assign(new Error(`${failurePoint} denied`), { status: 422 });
      const inspectChangeRequest = vi.fn(async (input: { changeRequestNumber: number }) => {
        if (input.changeRequestNumber === candidate.changeRequestNumber && failurePoint === "inspection") {
          throw permanent;
        }
        if (input.changeRequestNumber === laterCandidate.changeRequestNumber) {
          return { ...providerState, state: "closed" };
        }
        firstInspections += 1;
        return providerState;
      });
      const reconcileReviewRequest = vi.fn(async (input: { changeRequestNumber: number }) => {
        if (input.changeRequestNumber === candidate.changeRequestNumber && failurePoint === "mutation") {
          throw permanent;
        }
        return { changed: true };
      });
      const persistReplacement = vi.fn(async (input) => ({
        inserted: true,
        activationCurrent: true,
        replacement: { id: `replacement-${input.decisionId}`, state: input.state },
      }));
      const ports = buildPorts({
        availability: {
          loadActivation: vi.fn(async () => ({
            ...activation,
            candidates: [candidate, laterCandidate],
          })),
          persistReplacement,
        } as never,
        provider: {
          inspectChangeRequest,
          reconcileReviewRequest,
          classifyError: vi.fn(() => ({ kind: "permanent", message: `${failurePoint} denied` })),
        },
      });

      await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
        status: "completed",
        results: [
          { decisionId: candidate.decisionId, outcome: "permanent_failure" },
          { decisionId: laterCandidate.decisionId, outcome: "skipped_closed" },
        ],
      });

      expect(firstInspections).toBe(failurePoint === "mutation" ? 2 : 0);
      expect(persistReplacement).toHaveBeenNthCalledWith(1, expect.objectContaining({
        decisionId: candidate.decisionId,
        outcome: "permanent_failure",
        state: "permanent_failure",
        lastError: `${failurePoint} denied`,
        event: expect.objectContaining({ outcome: "permanent_failure" }),
      }));
      expect(persistReplacement).toHaveBeenNthCalledWith(2, expect.objectContaining({
        decisionId: laterCandidate.decisionId,
        outcome: "skipped_closed",
      }));
    },
  );

  it("maps permanent partial mutation plus persistence failure to recovery with no policy finalizer", async () => {
    const permanent = Object.assign(new Error("mutation denied"), { status: 422 });
    const ports = buildPorts({
      availability: {
        persistReplacement: vi.fn(async () => { throw new Error("database unavailable"); }),
      } as never,
      provider: {
        reconcileReviewRequest: vi.fn(async () => { throw permanent; }),
        classifyError: vi.fn(() => ({ kind: "permanent", message: "mutation denied" })),
      },
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "finalizer_pending",
      recovery: {
        kind: "reviewer_replacement_finalizer",
        phase: "persist_replacement",
        finalizer: null,
        providerEffectsApplied: true,
        persistence: {
          outcome: "permanent_failure",
          state: "permanent_failure",
          lastError: "mutation denied",
        },
        lastError: "database unavailable",
      },
    });
  });

  it.each(["inspection", "mutation"] as const)(
    "surfaces a retryable provider %s failure without terminal history",
    async (failurePoint) => {
      const transient = Object.assign(new Error(`${failurePoint} unavailable`), { status: 503 });
      const ports = buildPorts({
        provider: {
          inspectChangeRequest: failurePoint === "inspection"
            ? vi.fn(async () => { throw transient; })
            : vi.fn(async () => providerState),
          reconcileReviewRequest: failurePoint === "mutation"
            ? vi.fn(async () => { throw transient; })
            : vi.fn(async () => ({ changed: true })),
          classifyError: vi.fn(() => ({ kind: "retryable", message: `${failurePoint} unavailable` })),
        },
      });

      await expect(activateReviewerAbsence(job, ports)).rejects.toThrow(`${failurePoint} unavailable`);

      expect(ports.availability.persistReplacement).not.toHaveBeenCalled();
    },
  );

  it("keeps shadow mode free of reviewer and policy writes", async () => {
    const shadowCandidate = { ...candidate, mode: "shadow" as const, policyCheckState: "not_started" as const };
    const ports = buildPorts({
      availability: {
        loadActivation: vi.fn(async () => ({ ...activation, candidates: [shadowCandidate] })),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "completed",
      results: [{ outcome: "simulated_replacement", replacementActor: "@user-c91e46" }],
    });

    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
    expect(ports.finalizers.run).not.toHaveBeenCalled();
    expect(ports.availability.persistReplacement).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "simulated_replacement",
      state: "completed",
      replaceCohort: true,
    }));
  });

  it("returns exact mapped recovery when final locked persistence rejects after provider effects", async () => {
    const ports = buildPorts({
      availability: {
        persistReplacement: vi.fn(async () => ({
          inserted: false,
          activationCurrent: false,
          replacement: null,
        })),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "finalizer_pending",
      results: [],
      recovery: {
        kind: "reviewer_replacement_finalizer",
        phase: "persist_replacement",
        job,
        finalizer: {
          action: "reevaluate_policy",
          decisionId: candidate.decisionId,
          summary: null,
        },
        replacementId: null,
        mutationIntentId: preparedIntent.id,
        providerEffectsApplied: true,
        persistence: {
          decisionId: candidate.decisionId,
          outcome: "replaced",
          replacementActorId: "@user-c91e46",
          mutationIntentId: preparedIntent.id,
          state: "finalizer_pending",
        },
      },
    });

    expect(ports.provider.reconcileReviewRequest).toHaveBeenCalledOnce();
    expect(ports.finalizers.run).not.toHaveBeenCalled();
    expect(ports.availability.updateReplacementState).not.toHaveBeenCalled();
  });

  it("maps a thrown final persistence failure without repeating provider effects", async () => {
    const ports = buildPorts({
      availability: {
        persistReplacement: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toMatchObject({
      status: "finalizer_pending",
      recovery: {
        phase: "persist_replacement",
        providerEffectsApplied: true,
        lastError: "database unavailable",
      },
    });

    expect(ports.provider.reconcileReviewRequest).toHaveBeenCalledOnce();
    expect(ports.finalizers.run).not.toHaveBeenCalled();
  });

  it("replays a durable pending finalizer without reading or mutating reviewer requests", async () => {
    const ports = buildPorts({
      availability: {
        listPendingFinalizers: vi.fn(async () => [{
          id: "replacement-pending",
          ...replacementScope,
          decisionId: candidate.decisionId,
          replacementActorId: preparedIntent.replacementActorId,
          mutationIntentId: preparedIntent.id,
          outcome: "replaced",
          state: "finalizer_pending",
        }]),
        loadActivation: vi.fn(async () => null),
      } as never,
    });

    await expect(activateReviewerAbsence(job, ports)).resolves.toEqual({
      status: "skipped",
      reason: "stale_activation",
      results: [{
        decisionId: candidate.decisionId,
        outcome: "replaced",
        replacementActor: preparedIntent.replacementActorId,
        mutationIntentId: preparedIntent.id,
        finalized: true,
      }],
    });

    expect(ports.finalizers.run).toHaveBeenCalledWith({
      workspaceId: job.workspaceId,
      providerConnectionId: job.providerConnectionId,
      decisionId: candidate.decisionId,
      action: "reevaluate_policy",
      summary: null,
    });
    expect(ports.availability.updateReplacementState).toHaveBeenCalledWith({
      replacementId: "replacement-pending",
      expectedState: "finalizer_pending",
      state: "completed",
      lastError: null,
    });
    expect(ports.provider.inspectChangeRequest).not.toHaveBeenCalled();
    expect(ports.provider.reconcileReviewRequest).not.toHaveBeenCalled();
  });
});
