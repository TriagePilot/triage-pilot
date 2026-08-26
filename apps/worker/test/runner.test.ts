import { describe, expect, it, vi } from "vitest";
import type { JobRecord, JobTransitionResult } from "@triagepilot/db";

import { PermanentJobError, StaleJobLeaseError, TransientJobError } from "../src/errors";
import { runWorkerOnce } from "../src/runner";
import { processRoutingJob, type RoutingJobServices } from "../src/processor";
import type { HumanReviewPolicyServices } from "../src/review-policy-processor";

const jobRecord: JobRecord = {
  id: "job-1",
  kind: "process_pull_request",
  status: "queued",
  payload: {
    kind: "process_pull_request",
    deliveryId: "delivery-1",
    installationId: "99",
    repositoryId: "101",
    owner: "acme",
    repo: "api",
    pullNumber: 7,
    headSha: "abc123",
    eventName: "pull_request.opened",
  },
  idempotencyKey: "routing:delivery-1",
  attemptCount: 1,
  maxAttempts: 5,
  runAt: new Date("2026-08-18T10:00:00.000Z"),
  lockedAt: new Date("2026-08-18T10:00:00.000Z"),
  lockedBy: "worker-1",
  lastError: null,
};
const jobLease = { jobId: "job-1", lockedBy: "worker-1", attemptCount: 1, maxAttempts: 5 };
const policyJobPayload = {
  kind: "evaluate_human_review_policy" as const,
  deliveryId: "review-delivery-1",
  installationId: "123",
  repositoryId: "456",
  owner: "acme",
  repo: "app",
  pullNumber: 7,
};

function buildQueueWithJob() {
  return {
    enqueue: vi.fn(),
    claimNext: vi.fn(async (): Promise<JobRecord> => ({ ...jobRecord, status: "running" })),
    markSucceeded: vi.fn(async (): Promise<JobTransitionResult> => ({ updated: true })),
    markFailed: vi.fn(async (): Promise<JobTransitionResult> => ({ updated: true })),
  };
}

describe("runWorkerOnce", () => {
  it("claims a queued PR job, processes it, and marks it succeeded", async () => {
    const processRoutingJob = vi.fn(async () => {});
    const queue = {
      enqueue: vi.fn(),
      claimNext: vi.fn(async (): Promise<JobRecord> => ({
        id: "job-1",
        kind: "process_pull_request",
        status: "running",
        payload: {
          kind: "process_pull_request",
          deliveryId: "delivery-1",
          installationId: "123",
          repositoryId: "456",
          owner: "acme",
          repo: "app",
          pullNumber: 7,
          baseSha: "trusted-base",
          headSha: "abc",
          eventName: "pull_request.opened",
        },
        idempotencyKey: "routing:delivery-1",
        attemptCount: 1,
        maxAttempts: 5,
        runAt: new Date("2026-07-07T12:00:00.000Z"),
        lockedAt: new Date("2026-07-07T12:00:00.000Z"),
        lockedBy: "worker-1",
        lastError: null,
      })),
      markSucceeded: vi.fn(async (): Promise<JobTransitionResult> => ({ updated: true })),
      markFailed: vi.fn(async (): Promise<JobTransitionResult> => ({ updated: true })),
    };

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-07-07T12:00:00.000Z"),
      processRoutingJob,
      buildRoutingServices: vi.fn(() => ({}) as never),
    });

    expect(processRoutingJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "process_pull_request",
        deliveryId: "delivery-1",
        baseSha: "trusted-base",
        headSha: "abc",
      }),
      {},
    );
    expect(queue.markSucceeded).toHaveBeenCalledWith(
      { jobId: "job-1", lockedBy: "worker-1", attemptCount: 1, maxAttempts: 5 },
      expect.any(Date),
    );
    expect(queue.markFailed).not.toHaveBeenCalled();
  });

  it("dispatches a valid human-review policy job and marks it succeeded", async () => {
    const queue = buildQueueWithJob();
    queue.claimNext.mockResolvedValue({
      ...jobRecord,
      kind: "evaluate_human_review_policy",
      status: "running",
      payload: policyJobPayload,
    });
    const policyServices = {} as HumanReviewPolicyServices;
    const processHumanReviewPolicyJob = vi.fn(async () => {});
    const buildHumanReviewPolicyServices = vi.fn(() => policyServices);
    const processRoutingJob = vi.fn(async () => {});

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob,
      buildRoutingServices: vi.fn(() => ({}) as never),
      processHumanReviewPolicyJob,
      buildHumanReviewPolicyServices,
    });

    expect(processHumanReviewPolicyJob).toHaveBeenCalledWith(
      {
        kind: "evaluate_human_review_policy",
        deliveryId: "review-delivery-1",
        installationId: "123",
        repositoryId: "456",
        owner: "acme",
        repo: "app",
        pullNumber: 7,
      },
      policyServices,
    );
    expect(buildHumanReviewPolicyServices).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "evaluate_human_review_policy", repositoryId: "456", pullNumber: 7 }),
    );
    expect(processRoutingJob).not.toHaveBeenCalled();
    expect(queue.markSucceeded).toHaveBeenCalledWith(jobLease, expect.any(Date));
    expect(queue.markFailed).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "permanent",
      error: new PermanentJobError("GitHub permission denied"),
      attemptCount: 1,
      maxAttempts: 5,
      summary: "TriagePilot human-review policy evaluation failed: GitHub permission denied",
    },
    {
      name: "exhausted transient",
      error: new TransientJobError("GitHub unavailable"),
      attemptCount: 5,
      maxAttempts: 5,
      summary: "TriagePilot human-review policy evaluation failed after 5 attempts: GitHub unavailable",
    },
  ])("finalizes an existing policy check after a $name evaluation failure", async (failure) => {
    const queue = buildQueueWithJob();
    const recovery = { jobError: failure.error.message, summary: failure.summary, decisionId: "decision-1" };
    queue.claimNext
      .mockResolvedValueOnce({
        ...jobRecord,
        kind: "evaluate_human_review_policy",
        status: "running",
        payload: policyJobPayload,
        attemptCount: failure.attemptCount,
        maxAttempts: failure.maxAttempts,
      })
      .mockResolvedValueOnce({
        ...jobRecord,
        kind: "evaluate_human_review_policy",
        status: "running",
        payload: { ...policyJobPayload, policyCheckFailureRecovery: recovery },
        attemptCount: failure.attemptCount + 1,
        maxAttempts: failure.attemptCount + 3,
      });
    const failPolicyCheck = vi.fn(async () => {});
    const policyServices = {
      failPolicyCheck,
      policyCheckFailureDecisionId: () => "decision-1",
    } as unknown as HumanReviewPolicyServices;
    const processHumanReviewPolicyJob = vi.fn(async () => {
      throw failure.error;
    });
    const processRoutingJob = vi.fn(async () => {});
    const input = {
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob,
      buildRoutingServices: vi.fn(() => ({}) as never),
      processHumanReviewPolicyJob,
      buildHumanReviewPolicyServices: vi.fn(() => policyServices),
    };

    await runWorkerOnce(input);

    expect(queue.markFailed).toHaveBeenNthCalledWith(
      1,
      {
        jobId: "job-1",
        lockedBy: "worker-1",
        attemptCount: failure.attemptCount,
        maxAttempts: failure.maxAttempts,
      },
      failure.error.message,
      expect.any(Date),
      {
        retryable: true,
        recovery: {
          payload: { ...policyJobPayload, policyCheckFailureRecovery: recovery },
          maxAttempts: failure.attemptCount + 3,
        },
      },
    );

    await runWorkerOnce(input);

    expect(failPolicyCheck).toHaveBeenCalledWith(failure.summary, "decision-1");
    expect(processHumanReviewPolicyJob).toHaveBeenCalledOnce();
    expect(processRoutingJob).not.toHaveBeenCalled();
    expect(queue.markFailed).toHaveBeenNthCalledWith(
      2,
      {
        jobId: "job-1",
        lockedBy: "worker-1",
        attemptCount: failure.attemptCount + 1,
        maxAttempts: failure.attemptCount + 3,
      },
      failure.error.message,
      expect.any(Date),
      { retryable: false },
    );
  });

  it("marks permission failures permanent without another retry", async () => {
    const queue = buildQueueWithJob();

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob: vi.fn(async () => {
        throw new PermanentJobError("GitHub permission denied");
      }),
      buildRoutingServices: vi.fn(() => ({}) as never),
    });

    expect(queue.markFailed).toHaveBeenCalledWith(
      jobLease,
      "GitHub permission denied",
      expect.any(Date),
      { retryable: false },
    );
  });

  it("records a delayed enforce head mismatch and does not retry the job", async () => {
    const queue = buildQueueWithJob();
    const services: RoutingJobServices = {
      fetchConfig: vi.fn(async () => "version: 1\nmode: enforce\n"),
      fetchChangedFiles: vi.fn(async () => []),
      fetchCommitMessages: vi.fn(async () => []),
      fetchPullRequestMetadata: vi.fn(async () => ({
        authorLogin: "user-c91e46",
        authorHandle: "@user-c91e46",
        branchName: "feature",
        targetBranchName: "develop",
      })),
      fetchCurrentHeadApprovedReviewers: vi.fn(async () => []),
      enqueueHumanReviewPolicyEvaluation: vi.fn(async () => {}),
      getReviewerLoad: vi.fn(async () => ({})),
      updateRepositoryConfigState: vi.fn(async () => {}),
      persistDecision: vi.fn(async () => ({
        decisionId: "decision-1",
        actionStatus: "pending" as const,
        actionError: null,
        actionAppliedAt: null,
      })),
      applyDecisionActions: vi.fn(async (input) => {
        if (input.expectedHeadSha === "abc123") {
          throw new PermanentJobError("pull request head changed before enforce actions");
        }
      }),
      markActionSucceeded: vi.fn(async () => {}),
      markActionFailed: vi.fn(async () => {}),
    };

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob,
      buildRoutingServices: vi.fn(() => services),
    });

    expect(services.markActionFailed).toHaveBeenCalledWith(
      "decision-1",
      "pull request head changed before enforce actions",
      expect.any(Date),
    );
    expect(queue.markFailed).toHaveBeenCalledWith(
      jobLease,
      "pull request head changed before enforce actions",
      expect.any(Date),
      { retryable: false },
    );
    expect(queue.markSucceeded).not.toHaveBeenCalled();
  });

  it.each([401, 403, 422])("classifies GitHub status %i as permanent", async (status) => {
    const queue = buildQueueWithJob();

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob: vi.fn(async () => {
        throw Object.assign(new Error("GitHub rejected the request"), { status });
      }),
      buildRoutingServices: vi.fn(() => ({}) as never),
    });

    expect(queue.markFailed).toHaveBeenCalledWith(
      jobLease,
      "GitHub rejected the request",
      expect.any(Date),
      { retryable: false },
    );
  });

  it.each([
    ["explicit transient error", new TransientJobError("temporary failure")],
    ["GitHub rate limit", Object.assign(new Error("rate limited"), { status: 429 })],
    ["GitHub server failure", Object.assign(new Error("GitHub unavailable"), { status: 503 })],
    ["network failure", Object.assign(new Error("connection reset"), { code: "ECONNRESET" })],
    ["database failure", Object.assign(new Error("database unavailable"), { code: "57P01", severity: "FATAL" })],
  ])("requeues %s", async (_caseName, processError) => {
    const queue = buildQueueWithJob();

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob: vi.fn(async () => {
        throw processError;
      }),
      buildRoutingServices: vi.fn(() => ({}) as never),
    });

    expect(queue.markFailed).toHaveBeenCalledWith(
      jobLease,
      processError.message,
      expect.any(Date),
      { retryable: true },
    );
  });

  it("durably retries a rejected policy finalizer after routing attempts are exhausted", async () => {
    const queue = buildQueueWithJob();
    const recovery = {
      jobError: "GitHub unavailable",
      summary: "TriagePilot routing action failed after 5 attempts: GitHub unavailable",
    };
    queue.claimNext
      .mockResolvedValueOnce({
        ...jobRecord,
        status: "running",
        attemptCount: 5,
        maxAttempts: 5,
      })
      .mockResolvedValueOnce({
        ...jobRecord,
        status: "running",
        payload: { ...jobRecord.payload as object, policyCheckFailureRecovery: recovery },
        attemptCount: 6,
        maxAttempts: 8,
      })
      .mockResolvedValueOnce({
        ...jobRecord,
        status: "running",
        payload: { ...jobRecord.payload as object, policyCheckFailureRecovery: recovery },
        attemptCount: 7,
        maxAttempts: 8,
      });
    const failPolicyCheck = vi.fn()
      .mockRejectedValueOnce(new TransientJobError("GitHub still unavailable"))
      .mockResolvedValueOnce(undefined);
    const services = { failPolicyCheck } as unknown as RoutingJobServices;
    const processRoutingJob = vi.fn(async () => {
      throw new TransientJobError("GitHub unavailable");
    });
    const input = {
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob,
      buildRoutingServices: vi.fn(() => services),
    };

    await runWorkerOnce(input);

    expect(failPolicyCheck).not.toHaveBeenCalled();
    expect(queue.markFailed).toHaveBeenNthCalledWith(
      1,
      { jobId: "job-1", lockedBy: "worker-1", attemptCount: 5, maxAttempts: 5 },
      "GitHub unavailable",
      expect.any(Date),
      {
        retryable: true,
        recovery: {
          payload: { ...jobRecord.payload as object, policyCheckFailureRecovery: recovery },
          maxAttempts: 8,
        },
      },
    );

    await runWorkerOnce(input);

    expect(failPolicyCheck).toHaveBeenNthCalledWith(1, recovery.summary);
    expect(processRoutingJob).toHaveBeenCalledOnce();
    expect(queue.markFailed).toHaveBeenNthCalledWith(
      2,
      { jobId: "job-1", lockedBy: "worker-1", attemptCount: 6, maxAttempts: 8 },
      "GitHub still unavailable",
      expect.any(Date),
      { retryable: true },
    );

    await runWorkerOnce(input);

    expect(failPolicyCheck).toHaveBeenNthCalledWith(2, recovery.summary);
    expect(processRoutingJob).toHaveBeenCalledOnce();
    expect(queue.markFailed).toHaveBeenNthCalledWith(
      3,
      { jobId: "job-1", lockedBy: "worker-1", attemptCount: 7, maxAttempts: 8 },
      "GitHub unavailable",
      expect.any(Date),
      { retryable: false },
    );
  });

  it("leaves the policy check unchanged while transient routing retries remain", async () => {
    const queue = buildQueueWithJob();
    const failPolicyCheck = vi.fn(async () => {});

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob: vi.fn(async () => {
        throw new TransientJobError("GitHub unavailable");
      }),
      buildRoutingServices: vi.fn(() => ({ failPolicyCheck }) as unknown as RoutingJobServices),
    });

    expect(failPolicyCheck).not.toHaveBeenCalled();
    expect(queue.markFailed).toHaveBeenCalledWith(
      jobLease,
      "GitHub unavailable",
      expect.any(Date),
      { retryable: true },
    );
  });

  it("rejects malformed routing payloads permanently", async () => {
    const queue = buildQueueWithJob();
    queue.claimNext.mockResolvedValue({
      ...jobRecord,
      status: "running",
      payload: { ...(jobRecord.payload as object), installationId: 99 },
    });
    const processRoutingJob = vi.fn(async () => {});

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob,
      buildRoutingServices: vi.fn(() => ({}) as never),
    });

    expect(processRoutingJob).not.toHaveBeenCalled();
    expect(queue.markFailed).toHaveBeenCalledWith(
      jobLease,
      "routing job payload is malformed",
      expect.any(Date),
      { retryable: false },
    );
  });

  it("rejects malformed human-review policy payloads permanently", async () => {
    const queue = buildQueueWithJob();
    queue.claimNext.mockResolvedValue({
      ...jobRecord,
      kind: "evaluate_human_review_policy",
      status: "running",
      payload: {
        kind: "evaluate_human_review_policy",
        deliveryId: "review-delivery-1",
        installationId: "123",
        repositoryId: "456",
        owner: "",
        repo: "app",
        pullNumber: 7,
      },
    });
    const processHumanReviewPolicyJob = vi.fn(async () => {});

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob: vi.fn(async () => {}),
      buildRoutingServices: vi.fn(() => ({}) as never),
      processHumanReviewPolicyJob,
      buildHumanReviewPolicyServices: vi.fn(() => ({}) as never),
    });

    expect(processHumanReviewPolicyJob).not.toHaveBeenCalled();
    expect(queue.markFailed).toHaveBeenCalledWith(
      jobLease,
      "human-review policy job payload is malformed",
      expect.any(Date),
      { retryable: false },
    );
  });

  it.each([
    ["installation ID", { installationId: "9007199254740992" }],
    ["repository ID", { repositoryId: "9007199254740992" }],
    ["pull number", { pullNumber: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects an unsafe %s permanently", async (_field, unsafeValue) => {
    const queue = buildQueueWithJob();
    queue.claimNext.mockResolvedValue({
      ...jobRecord,
      status: "running",
      payload: { ...(jobRecord.payload as object), ...unsafeValue },
    });
    const processRoutingJob = vi.fn(async () => {});

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob,
      buildRoutingServices: vi.fn(() => ({}) as never),
    });

    expect(processRoutingJob).not.toHaveBeenCalled();
    expect(queue.markFailed).toHaveBeenCalledWith(
      jobLease,
      "routing job payload is malformed",
      expect.any(Date),
      { retryable: false },
    );
  });

  it("rejects unsupported job kinds permanently", async () => {
    const queue = buildQueueWithJob();
    queue.claimNext.mockResolvedValue({
      ...jobRecord,
      kind: "run_sla_checks",
      status: "running",
    } as unknown as JobRecord);

    await runWorkerOnce({
      queue,
      workerId: "worker-1",
      now: new Date("2026-08-18T10:00:00.000Z"),
      processRoutingJob: vi.fn(async () => {}),
      buildRoutingServices: vi.fn(() => ({}) as never),
    });

    expect(queue.markFailed).toHaveBeenCalledWith(
      jobLease,
      "unsupported job kind: run_sla_checks",
      expect.any(Date),
      { retryable: false },
    );
  });

  it("surfaces a stale completion lease without trying to regress the job", async () => {
    const queue = buildQueueWithJob();
    queue.markSucceeded.mockResolvedValue({ updated: false, reason: "stale_lease" });

    await expect(
      runWorkerOnce({
        queue,
        workerId: "worker-1",
        now: new Date("2026-08-18T10:00:00.000Z"),
        processRoutingJob: vi.fn(async () => {}),
        buildRoutingServices: vi.fn(() => ({}) as never),
      }),
    ).rejects.toThrow(StaleJobLeaseError);
    expect(queue.markFailed).not.toHaveBeenCalled();
  });
});
