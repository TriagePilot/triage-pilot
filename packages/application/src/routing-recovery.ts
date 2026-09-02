import {
  buildRoutingKey,
  type ChangeRequestId,
  type ProviderConnectionId,
  type ProviderKind,
  type RepositoryRef,
  type RoutingJobPayload,
  type WorkspaceId,
} from "@triagepilot/contracts";

const PROVIDERS = new Set<ProviderKind>(["github", "gitlab", "bitbucket"]);
const MAX_CHANGE_REQUEST_NUMBER = 2_147_483_647;
const routingRecoveryDecisionIdBrand: unique symbol = Symbol("RoutingRecoveryDecisionId");

type RoutingRecoveryDecisionId = string & {
  readonly [routingRecoveryDecisionIdBrand]: true;
};

export type RoutingRecoveryRequest =
  | { decisionId: string }
  | {
      changeRequest: {
        repository: RepositoryRef;
        externalId: ChangeRequestId;
        number: number;
      };
    };

type ValidatedRoutingRecoveryRequest =
  | { decisionId: RoutingRecoveryDecisionId }
  | Exclude<RoutingRecoveryRequest, { decisionId: string }>;

export interface RoutingRecoveryTarget {
  providerConnectionId: ProviderConnectionId;
  repository: RepositoryRef;
  changeRequestId: ChangeRequestId;
  changeRequestNumber: number;
}

export interface RoutingRecoveryCurrentState {
  state: string;
  baseRevision: string;
  headRevision: string;
  isDraft: boolean;
}

export interface EnqueueRoutingRecoveryInput {
  workspaceId: WorkspaceId;
  provider: ProviderKind;
  providerConnectionId: ProviderConnectionId;
  payload: RoutingJobPayload;
  idempotencyKey: string;
}

export interface RoutingRecoveryPorts {
  findTarget(input: {
    workspaceId: WorkspaceId;
    request: ValidatedRoutingRecoveryRequest;
  }): Promise<RoutingRecoveryTarget | null>;
  fetchCurrentState(input: { workspaceId: WorkspaceId } & RoutingRecoveryTarget): Promise<RoutingRecoveryCurrentState | null>;
  enqueue(input: EnqueueRoutingRecoveryInput): Promise<{ jobId: string } | null>;
  createRunId(): string;
}

export class RoutingRecoveryValidationError extends Error {
  readonly code = "invalid_target" as const;
}

export class RoutingRecoveryTargetUnavailableError extends Error {
  readonly code = "not_found_or_inactive" as const;
}

export class RoutingRecoveryClosedError extends Error {
  readonly code = "change_request_closed" as const;
}

export async function queueRoutingRecovery(
  input: { workspaceId: WorkspaceId; request: RoutingRecoveryRequest },
  ports: RoutingRecoveryPorts,
): Promise<{ jobId: string; routingKey: string }> {
  const request = parseRoutingRecoveryRequest(input.workspaceId, input.request);
  const target = await ports.findTarget({ workspaceId: input.workspaceId, request });
  if (target === null) {
    throw new RoutingRecoveryTargetUnavailableError("Routing recovery target is unavailable in this workspace");
  }

  const providerState = await ports.fetchCurrentState({ workspaceId: input.workspaceId, ...target });
  if (providerState === null) {
    throw new RoutingRecoveryTargetUnavailableError("Routing recovery target is unavailable in this workspace");
  }
  const current = parseCurrentState(providerState);
  if (current.state !== "open") {
    throw new RoutingRecoveryClosedError("Only an open change request can be routed again");
  }

  const runId = parseRunId(ports.createRunId());
  const routingKey = `${buildRoutingKey({
    workspaceId: input.workspaceId,
    provider: target.repository.provider,
    repositoryId: target.repository.externalId,
    changeRequestId: target.changeRequestId,
    trustedConfigRevision: current.baseRevision,
    headRevision: current.headRevision,
    isDraft: current.isDraft,
  })}:operator:${runId}`;
  const payload: RoutingJobPayload = {
    kind: "process_change_request",
    deliveryId: `operator:${runId}`,
    eventName: "operator.routing_recovery",
    workspaceId: input.workspaceId,
    providerConnectionId: target.providerConnectionId,
    changeRequest: {
      repository: target.repository,
      externalId: target.changeRequestId,
      number: target.changeRequestNumber,
      baseRevision: current.baseRevision,
      headRevision: current.headRevision,
    },
    isDraft: current.isDraft,
    routingKey,
  };
  const queued = await ports.enqueue({
    workspaceId: input.workspaceId,
    provider: target.repository.provider,
    providerConnectionId: target.providerConnectionId,
    payload,
    idempotencyKey: routingKey,
  });
  if (queued === null) {
    throw new RoutingRecoveryTargetUnavailableError("Routing recovery target is unavailable in this workspace");
  }
  return { jobId: queued.jobId, routingKey };
}

function parseRoutingRecoveryRequest(
  workspaceId: WorkspaceId,
  request: unknown,
): ValidatedRoutingRecoveryRequest {
  if (!isNonEmptyString(workspaceId) || !isRecord(request)) {
    throw new RoutingRecoveryValidationError("Routing recovery target is invalid");
  }
  const keys = Object.keys(request);
  if (keys.length !== 1) throw new RoutingRecoveryValidationError("Exactly one routing recovery target is required");
  if (keys[0] === "decisionId") {
    return { decisionId: parseDecisionId(request.decisionId) };
  }
  if (keys[0] !== "changeRequest" || !isRecord(request.changeRequest)) {
    throw new RoutingRecoveryValidationError("Routing recovery target is invalid");
  }
  const changeRequest = request.changeRequest;
  if (!hasExactKeys(changeRequest, ["repository", "externalId", "number"])
    || !isRecord(changeRequest.repository)
    || !hasExactKeys(changeRequest.repository, ["provider", "externalId", "owner", "name"])
    || !PROVIDERS.has(changeRequest.repository.provider as ProviderKind)
    || !isNonEmptyString(changeRequest.repository.externalId)
    || !isNonEmptyString(changeRequest.repository.owner)
    || !isNonEmptyString(changeRequest.repository.name)
    || !isNonEmptyString(changeRequest.externalId)
    || typeof changeRequest.number !== "number"
    || !Number.isSafeInteger(changeRequest.number)
    || changeRequest.number < 1
    || changeRequest.number > MAX_CHANGE_REQUEST_NUMBER) {
    throw new RoutingRecoveryValidationError("Routing recovery change-request reference is invalid");
  }
  return {
    changeRequest: {
      repository: {
        provider: changeRequest.repository.provider as ProviderKind,
        externalId: changeRequest.repository.externalId.trim(),
        owner: changeRequest.repository.owner.trim(),
        name: changeRequest.repository.name.trim(),
      },
      externalId: changeRequest.externalId.trim(),
      number: changeRequest.number,
    },
  };
}

function parseCurrentState(state: RoutingRecoveryCurrentState): RoutingRecoveryCurrentState {
  if (!isRecord(state)
    || !hasExactKeys(state, ["state", "baseRevision", "headRevision", "isDraft"])
    || !isNonEmptyString(state.state)
    || !isNonEmptyString(state.baseRevision)
    || !isNonEmptyString(state.headRevision)
    || typeof state.isDraft !== "boolean") {
    throw new RoutingRecoveryValidationError("Current provider change-request state is invalid");
  }
  const normalizedState = state.state.trim().toLowerCase();
  if (normalizedState !== "open" && normalizedState !== "closed") {
    throw new RoutingRecoveryValidationError("Current provider change-request state is invalid");
  }
  return {
    state: normalizedState,
    baseRevision: state.baseRevision.trim(),
    headRevision: state.headRevision.trim(),
    isDraft: state.isDraft,
  };
}

function parseDecisionId(value: unknown): RoutingRecoveryDecisionId {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)) {
    throw new RoutingRecoveryValidationError("Routing recovery decision ID is invalid");
  }
  return normalized as RoutingRecoveryDecisionId;
}

function parseRunId(value: string): string {
  if (!isNonEmptyString(value) || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new RoutingRecoveryValidationError("Routing recovery run identity is invalid");
  }
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
