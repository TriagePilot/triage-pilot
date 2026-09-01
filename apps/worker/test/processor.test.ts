import type { RoutingApplicationPorts } from "@triagepilot/application";
import type { RoutingJobPayload } from "@triagepilot/contracts";
import { describe, expect, it, vi } from "vitest";

import { processRoutingJob } from "../src/processor";

const message: RoutingJobPayload = {
  kind: "process_change_request",
  deliveryId: "delivery-1",
  eventName: "change_request.opened",
  workspaceId: "ws-a",
  providerConnectionId: "connection-a",
  changeRequest: {
    repository: { provider: "github", externalId: "101", owner: "acme", name: "api" },
    externalId: "7",
    number: 7,
    baseRevision: "base-sha",
    headRevision: "head-sha",
  },
  isDraft: false,
  routingKey: "routing:ws-a:github:101:7:base-sha:head-sha",
};

describe("processRoutingJob", () => {
  it("delegates worker jobs to the provider-neutral application service", async () => {
    const persistWithEvent = vi.fn(async (_input, event) => {
      const persisted = {
        decisionId: "decision-1",
        actionStatus: "not_applied" as const,
        actionError: null,
        actionAppliedAt: null,
      };
      event({ ...persisted, occurredAt: new Date("2026-08-27T09:59:00.000Z") });
      return persisted;
    });
    const ports: RoutingApplicationPorts = {
      resolveConfiguration: vi.fn<RoutingApplicationPorts["resolveConfiguration"]>(async () => ({
        ok: true as const,
        config: {
          version: 1 as const,
          mode: "shadow" as const,
          routing: {
            highRiskReviewers: 2 as const,
            excludeTargetBranches: [],
            excludeSourceBranchPatterns: [],
            includeDraftPullRequests: false,
          },
          risk: {
            size: { highChangedFiles: 100, highChangedLines: 5000 },
            thresholds: { low: 25, high: 70 },
            paths: [],
            suppressors: [],
            aiAuthorship: { enabled: false, modifier: 0 },
          },
          ownership: { rules: [], fallbackReviewers: [] },
        },
        diagnostics: [],
        provenance: {
          organizationVersion: null,
          repositoryPath: null,
          repositoryRevision: null,
          inheritanceMode: "defaults" as const,
          effectiveHash: "effective-hash",
          sources: {},
        },
      })),
      provider: {
        fetchChangeRequestMetadata: vi.fn(async () => ({
          author: "@user-c91e46",
          sourceBranch: "feature/change",
          targetBranch: "main",
          currentHeadRevision: "head-sha",
        })),
        fetchChangedFiles: vi.fn(async () => []),
        fetchCommitMessages: vi.fn(async () => []),
        fetchCurrentRevisionApprovals: vi.fn(async () => []),
        applyActions: vi.fn(async () => {}),
      },
      reviewerLoad: vi.fn(async () => ({})),
      decisions: {
        persistWithEvent,
        markActionSucceeded: vi.fn(async () => {}),
        markActionFailed: vi.fn(async () => {}),
      },
      enqueueReviewPolicy: vi.fn(async () => {}),
      clock: { now: () => new Date("2026-08-27T10:00:00.000Z") },
    };

    await processRoutingJob(message, ports);

    expect(persistWithEvent).toHaveBeenCalledOnce();
  });
});
