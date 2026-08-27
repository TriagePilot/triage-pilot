import type { JobClaimer, JobLease, JobRecord, JobTransitionResult, WorkspaceJobQueue } from "@triagepilot/db";
import type { WorkspaceId } from "@triagepilot/contracts";
import type { HumanReviewPolicyJobPayload } from "@triagepilot/contracts";

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
  jobClaimer: JobClaimer;
  workspaceQueue(workspaceId: WorkspaceId): WorkspaceJobQueue;
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
  const job = await input.jobClaimer.claimNext(input.workerId, input.now);
  if (!job) return false;
  const queue = input.workspaceQueue(job.workspaceId);
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
        await recoverPolicyCheckFailure(queue, lease, routingServices, recovery);
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
        await recoverPolicyCheckFailure(queue, lease, humanReviewPolicyServices, recovery);
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
        await queue.markFailed(lease, classified.message, new Date(), {
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
      await queue.markFailed(lease, classified.message, new Date(), {
        retryable,
      }),
      lease,
    );
    return true;
  }

  assertLeaseUpdated(await queue.markSucceeded(lease, new Date()), lease);
  return true;
}

async function recoverPolicyCheckFailure(
  queue: WorkspaceJobQueue,
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
  return {
    jobId: job.id,
    workspaceId: job.workspaceId,
    provider: job.provider,
    providerConnectionId: job.providerConnectionId,
    lockedBy: job.lockedBy,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
  };
}

function assertLeaseUpdated(result: JobTransitionResult, lease: JobLease): void {
  if (!result.updated) throw new StaleJobLeaseError(`job ${lease.jobId} lease is stale`);
}

function parseRoutingJobPayload(job: JobRecord): RoutingJobMessage {
  const payload = withClaimedScope(job);
  if (!isRoutingJobMessage(payload)) {
    throw new PermanentJobError("routing job payload is malformed");
  }
  return payload;
}

function parseHumanReviewPolicyJobPayload(job: JobRecord): HumanReviewPolicyJobPayload {
  const payload = withClaimedScope(job);
  if (!isHumanReviewPolicyJobPayload(payload)) {
    throw new PermanentJobError("human-review policy job payload is malformed");
  }
  return payload;
}

function withClaimedScope(job: JobRecord): unknown {
  if (!isRecord(job.payload)) return job.payload;
  const changeRequest = job.payload.changeRequest;
  if (!isRecord(changeRequest)) {
    return {
      ...job.payload,
      workspaceId: job.workspaceId,
      providerConnectionId: job.providerConnectionId,
    };
  }
  const repository = changeRequest.repository;
  return {
    ...job.payload,
    workspaceId: job.workspaceId,
    providerConnectionId: job.providerConnectionId,
    changeRequest: {
      ...changeRequest,
      ...(isRecord(repository) ? { repository: { ...repository, provider: job.provider } } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    payload.kind === "process_change_request" &&
    isNonEmptyString(payload.deliveryId) &&
    isNonEmptyString(payload.eventName) &&
    isNonEmptyString(payload.workspaceId) &&
    isNonEmptyString(payload.providerConnectionId) &&
    isChangeRequest(payload.changeRequest, true) &&
    typeof payload.isDraft === "boolean" &&
    isNonEmptyString(payload.routingKey)
  );
}

function isHumanReviewPolicyJobPayload(value: unknown): value is HumanReviewPolicyJobPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.kind === "evaluate_human_review_policy" &&
    isNonEmptyString(payload.deliveryId) &&
    isNonEmptyString(payload.workspaceId) &&
    isNonEmptyString(payload.providerConnectionId) &&
    isChangeRequest(payload.changeRequest, false)
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isChangeRequest(value: unknown, includeRevisions: boolean): boolean {
  if (typeof value !== "object" || value === null) return false;
  const changeRequest = value as Record<string, unknown>;
  if (
    !isNonEmptyString(changeRequest.externalId) ||
    !Number.isSafeInteger(changeRequest.number) ||
    Number(changeRequest.number) <= 0 ||
    !isRepository(changeRequest.repository)
  ) return false;
  return !includeRevisions || (isNonBlankString(changeRequest.baseRevision) && isNonBlankString(changeRequest.headRevision));
}

function isRepository(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const repository = value as Record<string, unknown>;
  return (
    (repository.provider === "github" || repository.provider === "gitlab" || repository.provider === "bitbucket") &&
    isNonEmptyString(repository.externalId) &&
    isNonEmptyString(repository.owner) &&
    isNonEmptyString(repository.name)
  );
}
