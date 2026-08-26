import { describe, expect, it } from "vitest";

import { trustedBaseSha, type RoutingJobPayload } from "@triagepilot/contracts";

const payload: RoutingJobPayload = {
  kind: "process_change_request",
  deliveryId: "delivery-1",
  eventName: "change_request.opened",
  workspaceId: "ws_local",
  providerConnectionId: "99",
  changeRequest: {
    repository: { provider: "github", externalId: "101", owner: "acme", name: "api" },
    externalId: "7",
    number: 7,
    baseRevision: "trusted-base-sha",
    headRevision: "unmerged-head-sha",
  },
  isDraft: false,
  routingKey: "routing:ws_local:github:101:7:trusted-base-sha:unmerged-head-sha",
};

describe("routing job trust boundary", () => {
  it("returns only the signed webhook base SHA as the repository configuration ref", () => {
    expect(trustedBaseSha(payload)).toBe("trusted-base-sha");
  });

  it("never substitutes the unmerged head SHA for a blank trusted revision", () => {
    expect(trustedBaseSha({
      ...payload,
      changeRequest: { ...payload.changeRequest, baseRevision: "  " },
    })).toBeUndefined();
  });
});
