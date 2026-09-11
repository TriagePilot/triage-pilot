import type { HumanReviewPolicyJobPayload } from "@triagepilot/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  evaluateReviewPolicy,
  type ReviewPolicyApplicationPorts,
  type ReviewPolicyDecision,
} from "../src/review-policy";

const job: HumanReviewPolicyJobPayload = {
  kind: "evaluate_human_review_policy",
  deliveryId: "review-delivery-1",
  workspaceId: "ws-a",
  providerConnectionId: "connection-a",
  changeRequest: {
    repository: { provider: "gitlab", externalId: "200", owner: "acme", name: "api" },
    externalId: "7",
    number: 7,
  },
};

const decision: ReviewPolicyDecision = {
  decisionId: "decision-1",
  workspaceId: "ws-a",
  repository: job.changeRequest.repository,
  changeRequestId: "7",
  changeRequestNumber: 7,
  headRevision: "head-sha",
  mode: "enforce",
  action: "request_human_review",
  selectedActors: ["@user-d82a5f", "@user-e64b19"],
  requiredApprovalCount: 2,
  policyCheckRunId: "71",
  policyCheckState: "in_progress",
};

function buildPorts(): ReviewPolicyApplicationPorts {
  return {
    decisions: {
      findLatest: vi.fn(async () => decision),
      persistState: vi.fn(async () => {}),
    },
    provider: {
      fetchChangeRequestState: vi.fn(async () => ({ state: "open", currentHeadRevision: "head-sha" })),
      fetchReviews: vi.fn(async () => []),
      updatePolicyCheck: vi.fn(async () => {}),
    },
  };
}

describe("evaluateReviewPolicy", () => {
  it("skips without provider writes when no enforce decision exists", async () => {
    const ports = buildPorts();
    vi.mocked(ports.decisions.findLatest).mockResolvedValueOnce(null);

    const outcome = await evaluateReviewPolicy(job, ports);

    expect(outcome).toEqual({ status: "skipped", reason: "no_decision" });
    expect(ports.provider.fetchChangeRequestState).not.toHaveBeenCalled();
    expect(ports.provider.updatePolicyCheck).not.toHaveBeenCalled();
  });

  it("counts active human approvals regardless of whether they predate routing", async () => {
    const ports = buildPorts();
    vi.mocked(ports.provider.fetchReviews).mockResolvedValueOnce([
      { actor: "@user-d82a5f", actorType: "human", state: "approved", submittedAt: "2026-08-20T10:00:00Z" },
      { actor: "@user-e64b19", actorType: "human", state: "approved", submittedAt: "2026-08-20T11:00:00Z" },
    ]);

    const outcome = await evaluateReviewPolicy(job, ports);

    expect(ports.provider.updatePolicyCheck).toHaveBeenCalledWith({
      decision,
      state: "success",
      summary: "Required human approval count met.",
    });
    expect(ports.decisions.persistState).toHaveBeenCalledWith({ workspaceId: "ws-a", decisionId: "decision-1", state: "success" });
    expect(outcome).toEqual({ status: "evaluated", decisionId: "decision-1", state: "success" });
  });

  it("uses only the latest active review per human and ignores bots", async () => {
    const ports = buildPorts();
    vi.mocked(ports.provider.fetchReviews).mockResolvedValueOnce([
      { actor: "@user-d82a5f", actorType: "human", state: "approved", submittedAt: "2026-08-20T10:00:00Z" },
      { actor: "@bot-a192ef", actorType: "bot", state: "approved", submittedAt: "2026-08-20T11:00:00Z" },
      { actor: "@user-d82a5f", actorType: "human", state: "changes_requested", submittedAt: "2026-08-20T12:00:00Z" },
      { actor: "@user-e64b19", actorType: "human", state: "approved", submittedAt: "2026-08-20T13:00:00Z" },
    ]);

    const outcome = await evaluateReviewPolicy(job, ports);

    expect(ports.provider.updatePolicyCheck).toHaveBeenCalledWith(expect.objectContaining({
      state: "in_progress",
      summary: "Waiting for 1 more human approval.",
    }));
    expect(outcome).toEqual({ status: "evaluated", decisionId: "decision-1", state: "in_progress" });
  });

  it("rechecks the head before publishing success and skips a stale revision", async () => {
    const ports = buildPorts();
    vi.mocked(ports.provider.fetchReviews).mockResolvedValueOnce([
      { actor: "@user-d82a5f", actorType: "human", state: "approved", submittedAt: "2026-08-20T10:00:00Z" },
      { actor: "@user-e64b19", actorType: "human", state: "approved", submittedAt: "2026-08-20T11:00:00Z" },
    ]);
    vi.mocked(ports.provider.fetchChangeRequestState)
      .mockResolvedValueOnce({ state: "open", currentHeadRevision: "head-sha" })
      .mockResolvedValueOnce({ state: "open", currentHeadRevision: "new-head" });

    const outcome = await evaluateReviewPolicy(job, ports);

    expect(outcome).toEqual({ status: "skipped", reason: "stale_revision" });
    expect(ports.provider.updatePolicyCheck).not.toHaveBeenCalled();
    expect(ports.decisions.persistState).not.toHaveBeenCalled();
  });

  it("does not mutate a terminal failure", async () => {
    const ports = buildPorts();
    vi.mocked(ports.decisions.findLatest).mockResolvedValueOnce({ ...decision, policyCheckState: "failure" });

    const outcome = await evaluateReviewPolicy(job, ports);

    expect(outcome).toEqual({ status: "skipped", reason: "terminal_failure" });
    expect(ports.provider.fetchChangeRequestState).not.toHaveBeenCalled();
    expect(ports.provider.updatePolicyCheck).not.toHaveBeenCalled();
  });
});
