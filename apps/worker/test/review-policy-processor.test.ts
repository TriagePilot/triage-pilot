import type { ReviewPolicyApplicationPorts } from "@triagepilot/application";
import type { HumanReviewPolicyJobPayload } from "@triagepilot/contracts";
import { describe, expect, it, vi } from "vitest";

import { processHumanReviewPolicyJob } from "../src/review-policy-processor";

const message: HumanReviewPolicyJobPayload = {
  kind: "evaluate_human_review_policy",
  deliveryId: "review-delivery-1",
  workspaceId: "ws-a",
  providerConnectionId: "connection-a",
  changeRequest: {
    repository: { provider: "github", externalId: "101", owner: "acme", name: "api" },
    externalId: "7",
    number: 7,
  },
};

describe("processHumanReviewPolicyJob", () => {
  it("delegates worker jobs to the provider-neutral review-policy service", async () => {
    const findLatest = vi.fn(async () => null);
    const ports: ReviewPolicyApplicationPorts = {
      decisions: {
        findLatest,
        persistState: vi.fn(async () => {}),
      },
      provider: {
        fetchChangeRequestState: vi.fn(async () => ({ state: "open", currentHeadRevision: "head-sha" })),
        fetchReviews: vi.fn(async () => []),
        updatePolicyCheck: vi.fn(async () => {}),
      },
    };

    await processHumanReviewPolicyJob(message, ports);

    expect(findLatest).toHaveBeenCalledWith({
      workspaceId: "ws-a",
      repository: message.changeRequest.repository,
      changeRequestId: "7",
      changeRequestNumber: 7,
    });
  });
});
