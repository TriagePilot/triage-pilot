import { describe, expect, it } from "vitest";

import {
  trustedBaseSha,
  type ReviewerAbsenceActivationJobPayload,
  type RoutingJobPayload,
  type TriagePilotJobPayload,
} from "../src/index";

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
};

describe("routing job trust boundary", () => {
  it("returns only the signed webhook base SHA as the repository configuration ref", () => {
    expect(trustedBaseSha(payload)).toBe("trusted-base-sha");
  });

  it("never substitutes the unmerged head SHA for a legacy payload", () => {
    const { baseSha: _baseSha, ...legacyPayload } = payload;

    expect(trustedBaseSha(legacyPayload)).toBeUndefined();
  });
});

describe("reviewer absence activation job", () => {
  it("preserves the literal absence identity and revision in the shared job payload", () => {
    const payload: ReviewerAbsenceActivationJobPayload = {
      kind: "activate_reviewer_absence",
      absenceId: "018f0d7a-1bfe-7c7d-9f9a-eba4e70c3ebc",
      expectedRevision: 2,
    };
    const job: TriagePilotJobPayload = payload;

    expect(job).toEqual({
      kind: "activate_reviewer_absence",
      absenceId: "018f0d7a-1bfe-7c7d-9f9a-eba4e70c3ebc",
      expectedRevision: 2,
    });
  });
});
