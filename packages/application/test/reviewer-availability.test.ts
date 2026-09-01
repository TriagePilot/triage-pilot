import { describe, expect, it, vi } from "vitest";

import {
  activateReviewerAbsence,
  type ReviewerAbsenceActivation,
  type ReviewerAvailabilityPorts,
  type ReviewerReplacementCandidateDecision,
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

const providerState: ReviewerReplacementProviderState = {
  state: "open",
  currentHeadRevision: candidate.routedHeadRevision,
  authorActor: "@user-a91f5c",
  requestedActors: [activation.externalActorId],
  reviews: [],
};

function buildPorts(overrides: Partial<ReviewerAvailabilityPorts> = {}): ReviewerAvailabilityPorts {
  const clockValues = [activationAt, completionAt];
  const availability = {
    listPendingFinalizers: vi.fn(async () => []),
    loadActivation: vi.fn(async () => activation),
    findActive: vi.fn(async () => []),
    persistReplacement: vi.fn(async (input) => ({
      inserted: true,
      activationCurrent: true,
      replacement: { id: "replacement-1", state: input.state },
    })),
    updateReplacementState: vi.fn(async (input) => ({ id: input.replacementId, state: input.state })),
  };
  const provider = {
    inspectChangeRequest: vi.fn(async () => providerState),
    reconcileReviewRequest: vi.fn(async () => ({ changed: true })),
  };
  const finalizers = { run: vi.fn(async () => {}) };
  return {
    clock: overrides.clock ?? { now: vi.fn(() => clockValues.shift() ?? completionAt) },
    availability: { ...availability, ...overrides.availability },
    provider: { ...provider, ...overrides.provider },
    reviewerLoad: overrides.reviewerLoad
      ?? vi.fn(async () => ({ "@user-c91e46": 0, "@user-f37a82": 1 })),
    finalizers: { ...finalizers, ...overrides.finalizers },
  };
}

describe("activateReviewerAbsence", () => {
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
        providerEffectsApplied: true,
        persistence: {
          decisionId: candidate.decisionId,
          outcome: "replaced",
          replacementActorId: "@user-c91e46",
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
          decisionId: candidate.decisionId,
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
        replacementActor: null,
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
