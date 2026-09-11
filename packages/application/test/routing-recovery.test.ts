import { describe, expect, it, vi } from "vitest";
import type { RoutingJobPayload } from "@triagepilot/contracts";

import {
  RoutingRecoveryClosedError,
  RoutingRecoveryTargetUnavailableError,
  RoutingRecoveryValidationError,
  queueRoutingRecovery,
  type RoutingRecoveryPorts,
} from "../src/routing-recovery";

const workspaceId = "workspace-51b9cf";
const decisionId = "c91e4600-0000-4000-8000-000000000001";
const target = {
  providerConnectionId: "connection-a91f5c",
  repository: { provider: "github" as const, externalId: "repository-71c9ab", owner: "acme", name: "api" },
  changeRequestId: "change-d82a5f",
  changeRequestNumber: 17,
};

describe("queueRoutingRecovery", () => {
  it("queues a fresh operator run from current provider state for a decision", async () => {
    const ports = buildPorts();

    await expect(queueRoutingRecovery({ workspaceId, request: { decisionId } }, ports))
      .resolves.toEqual({
        jobId: "job-4e5c21",
        routingKey: "routing:workspace-51b9cf:github:repository-71c9ab:change-d82a5f:base-current:head-current:ready:operator:run-b4e82d",
      });

    expect(ports.findTarget).toHaveBeenCalledWith({
      workspaceId,
      request: { decisionId },
    });
    expect(ports.fetchCurrentState).toHaveBeenCalledWith({ workspaceId, ...target });
    expect(ports.enqueue).toHaveBeenCalledWith({
      workspaceId,
      provider: "github",
      providerConnectionId: "connection-a91f5c",
      idempotencyKey: "routing:workspace-51b9cf:github:repository-71c9ab:change-d82a5f:base-current:head-current:ready:operator:run-b4e82d",
      payload: {
        kind: "process_change_request",
        deliveryId: "operator:run-b4e82d",
        eventName: "operator.routing_recovery",
        workspaceId,
        providerConnectionId: "connection-a91f5c",
        changeRequest: {
          repository: target.repository,
          externalId: "change-d82a5f",
          number: 17,
          baseRevision: "base-current",
          headRevision: "head-current",
        },
        isDraft: false,
        routingKey: "routing:workspace-51b9cf:github:repository-71c9ab:change-d82a5f:base-current:head-current:ready:operator:run-b4e82d",
      } satisfies RoutingJobPayload,
    });
  });

  it("propagates current draft lifecycle state into a distinct semantic key and payload", async () => {
    const ports = buildPorts({
      currentState: { state: "open", baseRevision: "base-2", headRevision: "head-2", isDraft: true },
    });

    const result = await queueRoutingRecovery({
      workspaceId,
      request: {
        changeRequest: {
          repository: target.repository,
          externalId: target.changeRequestId,
          number: target.changeRequestNumber,
        },
      },
    }, ports);

    expect(result.routingKey).toBe(
      "routing:workspace-51b9cf:github:repository-71c9ab:change-d82a5f:base-2:head-2:draft:operator:run-b4e82d",
    );
    expect(vi.mocked(ports.enqueue).mock.calls[0]?.[0].payload).toMatchObject({
      isDraft: true,
      changeRequest: { baseRevision: "base-2", headRevision: "head-2" },
    });
  });

  it("uses a unique operator identity for each requested run", async () => {
    const createRunId = vi.fn()
      .mockReturnValueOnce("run-1f83b9")
      .mockReturnValueOnce("run-2a907d");
    const ports = buildPorts({ createRunId });

    const first = await queueRoutingRecovery({ workspaceId, request: { decisionId } }, ports);
    const second = await queueRoutingRecovery({ workspaceId, request: { decisionId } }, ports);

    expect(first.routingKey).toMatch(/:operator:run-1f83b9$/);
    expect(second.routingKey).toMatch(/:operator:run-2a907d$/);
    expect(vi.mocked(ports.enqueue).mock.calls.map(([input]) => input.payload.deliveryId))
      .toEqual(["operator:run-1f83b9", "operator:run-2a907d"]);
  });

  it("does not enqueue when the scoped target is unknown or inactive", async () => {
    const ports = buildPorts({ findTarget: vi.fn(async () => null) });

    await expect(queueRoutingRecovery({ workspaceId, request: { decisionId } }, ports))
      .rejects.toBeInstanceOf(RoutingRecoveryTargetUnavailableError);
    expect(ports.fetchCurrentState).not.toHaveBeenCalled();
    expect(ports.enqueue).not.toHaveBeenCalled();
  });

  it("reports a provider connection that becomes inactive before enqueue without leaking the target", async () => {
    const ports = buildPorts({ enqueue: vi.fn(async () => null) });

    await expect(queueRoutingRecovery({ workspaceId, request: { decisionId } }, ports))
      .rejects.toMatchObject({ code: "not_found_or_inactive" });
  });

  it("does not enqueue a closed change request", async () => {
    const ports = buildPorts({
      currentState: { state: "closed", baseRevision: "base-current", headRevision: "head-current", isDraft: false },
    });

    await expect(queueRoutingRecovery({ workspaceId, request: { decisionId } }, ports))
      .rejects.toBeInstanceOf(RoutingRecoveryClosedError);
    expect(ports.enqueue).not.toHaveBeenCalled();
  });

  it("does not disclose a change request missing from current provider state", async () => {
    const ports = buildPorts({ currentState: null });

    await expect(queueRoutingRecovery({ workspaceId, request: { decisionId } }, ports))
      .rejects.toBeInstanceOf(RoutingRecoveryTargetUnavailableError);
    expect(ports.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["blank workspace", { workspaceId: " ", request: { decisionId } }],
    ["blank decision", { workspaceId, request: { decisionId: " " } }],
    ["non-UUID decision", { workspaceId, request: { decisionId: "not-a-uuid" } }],
    ["both targets", { workspaceId, request: { decisionId, changeRequest: target } }],
    ["neither target", { workspaceId, request: {} }],
    ["unknown request key", { workspaceId, request: { providerUrl: "https://example.invalid" } }],
    ["blank repository identity", {
      workspaceId,
      request: { changeRequest: { repository: { ...target.repository, externalId: " " }, externalId: "change-d82a5f", number: 17 } },
    }],
    ["unknown provider", {
      workspaceId,
      request: { changeRequest: { repository: { ...target.repository, provider: "unknown" }, externalId: "change-d82a5f", number: 17 } },
    }],
    ["invalid number", {
      workspaceId,
      request: { changeRequest: { repository: target.repository, externalId: "change-d82a5f", number: 0 } },
    }],
  ])("rejects a malformed %s target before any port call", async (_name, input) => {
    const ports = buildPorts();

    await expect(queueRoutingRecovery(input as never, ports)).rejects.toBeInstanceOf(RoutingRecoveryValidationError);
    expect(ports.findTarget).not.toHaveBeenCalled();
    expect(ports.fetchCurrentState).not.toHaveBeenCalled();
    expect(ports.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: "unexpected", baseRevision: "base-current", headRevision: "head-current", isDraft: false }],
    [{ state: "open", baseRevision: "", headRevision: "head-current", isDraft: false }],
    [{ state: "open", baseRevision: "base-current", headRevision: "", isDraft: false }],
    [{ state: "open", baseRevision: "base-current", headRevision: "head-current", isDraft: "false" }],
  ])("rejects malformed current provider state without enqueueing", async (currentState) => {
    const ports = buildPorts({ currentState: currentState as never });

    await expect(queueRoutingRecovery({ workspaceId, request: { decisionId } }, ports))
      .rejects.toBeInstanceOf(RoutingRecoveryValidationError);
    expect(ports.enqueue).not.toHaveBeenCalled();
  });
});

function buildPorts(overrides: {
  findTarget?: RoutingRecoveryPorts["findTarget"];
  currentState?: Awaited<ReturnType<RoutingRecoveryPorts["fetchCurrentState"]>>;
  enqueue?: RoutingRecoveryPorts["enqueue"];
  createRunId?: () => string;
} = {}): RoutingRecoveryPorts {
  return {
    findTarget: overrides.findTarget ?? vi.fn(async () => target),
    fetchCurrentState: vi.fn(async () => overrides.currentState === undefined ? ({
      state: "open",
      baseRevision: "base-current",
      headRevision: "head-current",
      isDraft: false,
    }) : overrides.currentState),
    enqueue: overrides.enqueue ?? vi.fn(async () => ({ jobId: "job-4e5c21" })),
    createRunId: overrides.createRunId ?? (() => "run-b4e82d"),
  };
}
