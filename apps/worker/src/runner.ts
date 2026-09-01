import type { JobClaimer, JobLease, JobRecord, JobTransitionResult, WorkspaceJobQueue } from "@triagepilot/db";
import type { WorkspaceId } from "@triagepilot/contracts";
import type { HumanReviewPolicyJobPayload } from "@triagepilot/contracts";
import {
  assertReviewerReplacementFinalizerRecovery,
  parseReviewerMutationIntentId,
  type ReviewerReplacementFinalizerRecovery,
} from "@triagepilot/application";

import type { RoutingJobMessage, RoutingJobServices } from "./processor";
import type { HumanReviewPolicyServices } from "./review-policy-processor";
import { classifyWorkerError, PermanentJobError, StaleJobLeaseError } from "./errors";
import type {
  ReviewerAbsenceActivationJobMessage,
  ReviewerAvailabilityServices,
} from "./availability-processor";

const POLICY_CHECK_FINALIZATION_ATTEMPTS = 3;
const REVIEWER_REPLACEMENT_RECOVERY_ATTEMPTS = 3;

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
  processReviewerAbsenceActivationJob?(
    message: ReviewerAbsenceActivationJobMessage,
    services: ReviewerAvailabilityServices,
  ): Promise<ReviewerReplacementFinalizerRecovery | null>;
  recoverReviewerReplacementFinalizer?(
    recovery: ReviewerReplacementFinalizerRecovery,
    services: ReviewerAvailabilityServices,
  ): Promise<ReviewerReplacementFinalizerRecovery | null>;
  markReviewerReplacementRecoveryExhausted?(
    recovery: ReviewerReplacementFinalizerRecovery,
    services: ReviewerAvailabilityServices,
    error: string,
  ): Promise<void>;
  buildReviewerAvailabilityServices?(message: ReviewerAbsenceActivationJobMessage): ReviewerAvailabilityServices;
}

export async function runWorkerOnce(input: WorkerRunnerInput): Promise<boolean> {
  const job = await input.jobClaimer.claimNext(input.workerId, input.now);
  if (!job) return false;
  let queue: WorkspaceJobQueue | null = null;
  const claimedQueue = () => queue ??= input.workspaceQueue(job.workspaceId);
  const lease = toJobLease(job);
  let routingServices: RoutingJobServices | null = null;
  let humanReviewPolicyServices: HumanReviewPolicyServices | null = null;
  let reviewerAvailabilityServices: ReviewerAvailabilityServices | null = null;
  let reviewerReplacementRecovery: ReviewerReplacementFinalizerRecovery | null = null;

  try {
    if (job.kind === "process_pull_request") {
      const message = parseRoutingJobPayload(job);
      routingServices = input.buildRoutingServices(message);
      const recovery = parsePolicyCheckFailureRecovery(job.payload);
      if (recovery === null) {
        await input.processRoutingJob(message, routingServices);
      } else {
        await recoverPolicyCheckFailure(claimedQueue(), lease, routingServices, recovery);
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
        await recoverPolicyCheckFailure(claimedQueue(), lease, humanReviewPolicyServices, recovery);
        return true;
      }
    } else if (job.kind === "activate_reviewer_absence") {
      const message = parseReviewerAbsenceActivationJobPayload(job);
      reviewerReplacementRecovery = parseReviewerReplacementFinalizerRecovery(job.payload, message);
      const boundedRecoveryClaim = reviewerReplacementRecovery !== null;
      if (!input.processReviewerAbsenceActivationJob || !input.buildReviewerAvailabilityServices) {
        throw new PermanentJobError("reviewer absence activation processor is not configured");
      }
      reviewerAvailabilityServices = input.buildReviewerAvailabilityServices(message);
      let nextRecovery: ReviewerReplacementFinalizerRecovery | null;
      if (reviewerReplacementRecovery === null) {
        nextRecovery = await input.processReviewerAbsenceActivationJob(message, reviewerAvailabilityServices);
      } else {
        if (!input.recoverReviewerReplacementFinalizer) {
          throw new PermanentJobError("reviewer replacement finalizer recovery is not configured");
        }
        nextRecovery = await input.recoverReviewerReplacementFinalizer(
          reviewerReplacementRecovery,
          reviewerAvailabilityServices,
        );
        if (nextRecovery === null) {
          reviewerReplacementRecovery = null;
          nextRecovery = await input.processReviewerAbsenceActivationJob(message, reviewerAvailabilityServices);
        }
      }
      if (nextRecovery !== null) {
        const exhausted = !nextRecovery.retryable
          || (boundedRecoveryClaim && lease.attemptCount >= lease.maxAttempts);
        if (exhausted) {
          assertLeaseUpdated(
            await claimedQueue().exhaustReviewerAbsenceActivation(lease, nextRecovery.lastError, new Date()),
            lease,
          );
          return true;
        }
        const maxAttempts = boundedRecoveryClaim
          ? lease.maxAttempts
          : lease.attemptCount + REVIEWER_REPLACEMENT_RECOVERY_ATTEMPTS;
        assertLeaseUpdated(
          await claimedQueue().markFailed(lease, nextRecovery.lastError, new Date(), {
            retryable: true,
            recovery: {
              payload: reviewerReplacementRecoveryPayload(job.payload, message, nextRecovery),
              maxAttempts,
            },
          }),
          lease,
        );
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
        await claimedQueue().markFailed(lease, classified.message, new Date(), {
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
    if (job.kind === "activate_reviewer_absence" && (!retryable || lease.attemptCount >= lease.maxAttempts)) {
      assertLeaseUpdated(
        await claimedQueue().exhaustReviewerAbsenceActivation(lease, classified.message, new Date()),
        lease,
      );
      return true;
    }
    assertLeaseUpdated(
      await claimedQueue().markFailed(lease, classified.message, new Date(), {
        retryable,
      }),
      lease,
    );
    return true;
  }

  assertLeaseUpdated(await claimedQueue().markSucceeded(lease, new Date()), lease);
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

function parseReviewerAbsenceActivationJobPayload(job: JobRecord): ReviewerAbsenceActivationJobMessage {
  const payload = withClaimedScope(job);
  if (
    !isRecord(payload)
    || payload.kind !== "activate_reviewer_absence"
    || !isNonBlankString(payload.workspaceId)
    || !isNonBlankString(payload.providerConnectionId)
    || !isNonBlankString(payload.absenceId)
    || !isPositiveInteger(payload.absenceRevision)
    || "policyCheckFailureRecovery" in payload
  ) throw new PermanentJobError("reviewer absence activation job payload is malformed");
  return {
    kind: "activate_reviewer_absence",
    workspaceId: payload.workspaceId,
    provider: job.provider,
    providerConnectionId: payload.providerConnectionId,
    absenceId: payload.absenceId,
    absenceRevision: payload.absenceRevision,
  };
}

function parseReviewerReplacementFinalizerRecovery(
  payload: unknown,
  message: ReviewerAbsenceActivationJobMessage,
): ReviewerReplacementFinalizerRecovery | null {
  if (!isRecord(payload) || !("reviewerReplacementFinalizerRecovery" in payload)) return null;
  try {
    const raw = payload.reviewerReplacementFinalizerRecovery;
    if (!isRecord(raw)) throw new Error("recovery is not an object");
    const persistence = raw.persistence === null
      ? null
      : rehydrateReplacementPersistence(raw.persistence);
    const mutationIntentId = raw.mutationIntentId === null
      ? null
      : parseReviewerMutationIntentId(raw.mutationIntentId);
    const value: unknown = {
      ...raw,
      mutationIntentId,
      persistence: persistence === null
        ? null
        : {
            ...persistence,
            mutationIntentId: persistence.mutationIntentId === null
              ? null
              : parseReviewerMutationIntentId(persistence.mutationIntentId),
          },
    };
    assertReviewerReplacementFinalizerRecovery(value);
    if (
      value.job.workspaceId !== message.workspaceId
      || value.provider !== message.provider
      || value.job.providerConnectionId !== message.providerConnectionId
      || value.job.absenceId !== message.absenceId
      || value.job.absenceRevision !== message.absenceRevision
      || (value.persistence !== null && (
        value.persistence.provider !== message.provider
        || value.persistence.providerConnectionId !== message.providerConnectionId
        || value.persistence.absenceId !== message.absenceId
        || value.persistence.absenceRevision !== message.absenceRevision
        || value.persistence.event.workspaceId !== message.workspaceId
        || (value.finalizer !== null && value.finalizer.decisionId !== value.persistence.decisionId)
      ))
    ) throw new Error("recovery scope does not match the claimed job");
    return value;
  } catch {
    throw new PermanentJobError("reviewer replacement finalizer recovery payload is malformed");
  }
}

function rehydrateReplacementPersistence(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("recovery persistence is not an object");
  return {
    ...value,
    startedAt: parseRecoveryDate(value.startedAt),
    completedAt: parseRecoveryDate(value.completedAt),
  };
}

function parseRecoveryDate(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string") throw new Error("recovery timestamp is malformed");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("recovery timestamp is malformed");
  }
  return parsed;
}

function reviewerReplacementRecoveryPayload(
  payload: unknown,
  message: ReviewerAbsenceActivationJobMessage,
  recovery: ReviewerReplacementFinalizerRecovery,
): Record<string, unknown> {
  return {
    ...(isRecord(payload) ? payload : {}),
    kind: message.kind,
    workspaceId: message.workspaceId,
    providerConnectionId: message.providerConnectionId,
    absenceId: message.absenceId,
    absenceRevision: message.absenceRevision,
    reviewerReplacementFinalizerRecovery: recovery,
  };
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
