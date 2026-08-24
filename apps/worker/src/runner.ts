import type { JobLease, JobQueue, JobRecord, JobTransitionResult } from "@triagepilot/db";
import type { HumanReviewPolicyJobPayload } from "@triagepilot/shared";

import type { RoutingJobMessage, RoutingJobServices } from "./processor";
import type { HumanReviewPolicyServices } from "./review-policy-processor";
import { classifyWorkerError, PermanentJobError, StaleJobLeaseError } from "./errors";

const POLICY_CHECK_FINALIZATION_ATTEMPTS = 3;

interface PolicyCheckFailureRecovery {
  jobError: string;
  summary: string;
  decisionId?: string;
}

interface PolicyCheckFailureServices {
  failPolicyCheck?(summary: string, decisionId?: string): Promise<void>;
}

export interface WorkerRunnerInput {
  queue: JobQueue;
  workerId: string;
  now: Date;
  processRoutingJob(message: RoutingJobMessage, services: RoutingJobServices): Promise<void>;
  buildRoutingServices(message: RoutingJobMessage): RoutingJobServices;
  processHumanReviewPolicyJob?(
    message: HumanReviewPolicyJobPayload,
    services: HumanReviewPolicyServices,
  ): Promise<void>;
  buildHumanReviewPolicyServices?(message: HumanReviewPolicyJobPayload): HumanReviewPolicyServices;
}

export async function runWorkerOnce(input: WorkerRunnerInput): Promise<boolean> {
  const job = await input.queue.claimNext(input.workerId, input.now);
  if (!job) return false;
  const lease = toJobLease(job);
  let routingServices: RoutingJobServices | null = null;
  let humanReviewPolicyServices: HumanReviewPolicyServices | null = null;

  try {
    if (job.kind === "process_pull_request") {
      const message = parseRoutingJobPayload(job);
      routingServices = input.buildRoutingServices(message);
      const recovery = parsePolicyCheckFailureRecovery(job.payload);
      if (recovery === null) {
        await input.processRoutingJob(message, routingServices);
      } else {
        await recoverPolicyCheckFailure(input.queue, lease, routingServices, recovery);
        return true;
      }
    } else if (job.kind === "evaluate_human_review_policy") {
      const message = parseHumanReviewPolicyJobPayload(job);
      if (!input.processHumanReviewPolicyJob || !input.buildHumanReviewPolicyServices) {
        throw new PermanentJobError("human-review policy processor is not configured");
      }
      humanReviewPolicyServices = input.buildHumanReviewPolicyServices(message);
      const recovery = parsePolicyCheckFailureRecovery(job.payload);
      if (recovery === null) {
        await input.processHumanReviewPolicyJob(message, humanReviewPolicyServices);
      } else {
        await recoverPolicyCheckFailure(input.queue, lease, humanReviewPolicyServices, recovery);
        return true;
      }
    } else {
      throw new PermanentJobError(`unsupported job kind: ${String(job.kind)}`);
    }
  } catch (error) {
    const classified = classifyWorkerError(error);
    const retryable = !(classified instanceof PermanentJobError);
    const finalizationServices = routingServices ?? humanReviewPolicyServices;
    const shouldFinalize = humanReviewPolicyServices !== null
      ? !retryable || lease.attemptCount >= lease.maxAttempts
      : retryable && lease.attemptCount >= lease.maxAttempts;
    if (shouldFinalize && finalizationServices?.failPolicyCheck) {
      const recovery: PolicyCheckFailureRecovery = {
        jobError: classified.message,
        summary: humanReviewPolicyServices === null
          ? `TriagePilot routing action failed after ${lease.attemptCount} attempts: ${classified.message}`
          : retryable
            ? `TriagePilot human-review policy evaluation failed after ${lease.attemptCount} attempts: ${classified.message}`
            : `TriagePilot human-review policy evaluation failed: ${classified.message}`,
      };
      const decisionId = humanReviewPolicyServices?.policyCheckFailureDecisionId?.();
      if (decisionId) recovery.decisionId = decisionId;
      assertLeaseUpdated(
        await input.queue.markFailed(lease, classified.message, new Date(), {
          retryable: true,
          recovery: {
            payload: { ...(job.payload as object), policyCheckFailureRecovery: recovery },
            maxAttempts: lease.attemptCount + POLICY_CHECK_FINALIZATION_ATTEMPTS,
          },
        }),
        lease,
      );
      return true;
    }
    assertLeaseUpdated(
      await input.queue.markFailed(lease, classified.message, new Date(), {
        retryable,
      }),
      lease,
    );
    return true;
  }

  assertLeaseUpdated(await input.queue.markSucceeded(lease, new Date()), lease);
  return true;
}

async function recoverPolicyCheckFailure(
  queue: JobQueue,
  lease: JobLease,
  services: PolicyCheckFailureServices,
  recovery: PolicyCheckFailureRecovery,
): Promise<void> {
  if (!services.failPolicyCheck) {
    assertLeaseUpdated(
      await queue.markFailed(lease, "policy-check failure finalizer is not configured", new Date(), {
        retryable: false,
      }),
      lease,
    );
    return;
  }

  try {
    if (recovery.decisionId === undefined) {
      await services.failPolicyCheck(recovery.summary);
    } else {
      await services.failPolicyCheck(recovery.summary, recovery.decisionId);
    }
  } catch (error) {
    const classified = classifyWorkerError(error);
    assertLeaseUpdated(
      await queue.markFailed(lease, classified.message, new Date(), {
        retryable: !(classified instanceof PermanentJobError),
      }),
      lease,
    );
    return;
  }

  assertLeaseUpdated(
    await queue.markFailed(lease, recovery.jobError, new Date(), { retryable: false }),
    lease,
  );
}

function toJobLease(job: JobRecord): JobLease {
  if (job.lockedBy === null) throw new StaleJobLeaseError(`claimed job ${job.id} has no lock owner`);
  return { jobId: job.id, lockedBy: job.lockedBy, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts };
}

function assertLeaseUpdated(result: JobTransitionResult, lease: JobLease): void {
  if (!result.updated) throw new StaleJobLeaseError(`job ${lease.jobId} lease is stale`);
}

function parseRoutingJobPayload(job: JobRecord): RoutingJobMessage {
  const payload = job.payload;
  if (!isRoutingJobMessage(payload)) {
    throw new PermanentJobError("routing job payload is malformed");
  }
  return payload;
}

function parseHumanReviewPolicyJobPayload(job: JobRecord): HumanReviewPolicyJobPayload {
  const payload = job.payload;
  if (!isHumanReviewPolicyJobPayload(payload)) {
    throw new PermanentJobError("human-review policy job payload is malformed");
  }
  return payload;
}

function parsePolicyCheckFailureRecovery(payload: unknown): PolicyCheckFailureRecovery | null {
  if (typeof payload !== "object" || payload === null || !("policyCheckFailureRecovery" in payload)) return null;
  const recovery = payload.policyCheckFailureRecovery;
  if (
    typeof recovery !== "object" ||
    recovery === null ||
    !("jobError" in recovery) ||
    !isNonEmptyString(recovery.jobError) ||
    !("summary" in recovery) ||
    !isNonEmptyString(recovery.summary)
  ) {
    throw new PermanentJobError("policy-check failure recovery payload is malformed");
  }
  const decisionId = "decisionId" in recovery ? recovery.decisionId : undefined;
  if (decisionId !== undefined && !isNonEmptyString(decisionId)) {
    throw new PermanentJobError("policy-check failure recovery payload is malformed");
  }
  return {
    jobError: recovery.jobError,
    summary: recovery.summary,
    ...(typeof decisionId === "string" ? { decisionId } : {}),
  };
}

function isRoutingJobMessage(value: unknown): value is RoutingJobMessage {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.kind === "process_pull_request" &&
    isNonEmptyString(payload.deliveryId) &&
    isDecimalId(payload.installationId) &&
    isDecimalId(payload.repositoryId) &&
    isNonEmptyString(payload.owner) &&
    isNonEmptyString(payload.repo) &&
    Number.isSafeInteger(payload.pullNumber) &&
    Number(payload.pullNumber) > 0 &&
    (payload.baseSha === undefined || isNonBlankString(payload.baseSha)) &&
    isNonEmptyString(payload.headSha) &&
    isNonEmptyString(payload.eventName) &&
    (payload.routingKey === undefined || isNonEmptyString(payload.routingKey))
  );
}

function isHumanReviewPolicyJobPayload(value: unknown): value is HumanReviewPolicyJobPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.kind === "evaluate_human_review_policy" &&
    isNonEmptyString(payload.deliveryId) &&
    isDecimalId(payload.installationId) &&
    isDecimalId(payload.repositoryId) &&
    isNonEmptyString(payload.owner) &&
    isNonEmptyString(payload.repo) &&
    Number.isSafeInteger(payload.pullNumber) &&
    Number(payload.pullNumber) > 0
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDecimalId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && String(numeric) === value;
}
