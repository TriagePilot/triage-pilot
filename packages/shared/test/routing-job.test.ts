import { describe, expect, it } from "vitest";

import { buildRoutingKey, trustedBaseSha, type RoutingJobPayload } from "../src/index";

const payload: RoutingJobPayload = {
  kind: "process_pull_request",
  deliveryId: "delivery-1",
  installationId: "99",
  repositoryId: "101",
  owner: "acme",
  repo: "api",
  pullNumber: 7,
  baseSha: "trusted-base-sha",
  headSha: "unmerged-head-sha",
  eventName: "pull_request.opened",
  isDraft: false,
};

describe("routing job trust boundary", () => {
  it("returns only the signed webhook base SHA as the repository configuration ref", () => {
    expect(trustedBaseSha(payload)).toBe("trusted-base-sha");
  });

  it("never substitutes the unmerged head SHA for a legacy payload", () => {
    const { baseSha: _baseSha, ...legacyPayload } = payload;

    expect(trustedBaseSha(legacyPayload)).toBeUndefined();
  });

  it("distinguishes draft and ready pull-request states with the same commits", () => {
    const state = {
      repositoryId: "101",
      pullNumber: 7,
      baseSha: "trusted-base-sha",
      headSha: "unmerged-head-sha",
    };

    expect(buildRoutingKey({ ...state, isDraft: true })).toBe("routing:101:7:trusted-base-sha:unmerged-head-sha:draft");
    expect(buildRoutingKey({ ...state, isDraft: false })).toBe("routing:101:7:trusted-base-sha:unmerged-head-sha:ready");
  });
});
