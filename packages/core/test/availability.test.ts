import { describe, expect, it } from "vitest";

import { availableReviewerHandlesAt, selectAvailabilityReplacement } from "../src/availability";
import { selectLowestLoadReviewers } from "../src/routing";

describe("reviewer availability", () => {
  const windows = [{
    reviewerHandle: "@user-d82a5f",
    startAt: new Date("2026-10-01T08:00:00.000Z"),
    endAt: new Date("2026-10-08T08:00:00.000Z"),
  }];

  it("excludes a reviewer at the inclusive absence start", () => {
    expect(availableReviewerHandlesAt({
      reviewers: ["@user-d82a5f", "@user-b4e82d"],
      absences: windows,
      now: new Date("2026-10-01T08:00:00.000Z"),
    })).toEqual(["@user-b4e82d"]);
  });

  it("includes a reviewer at the exclusive absence end", () => {
    expect(availableReviewerHandlesAt({
      reviewers: ["@user-d82a5f", "@user-b4e82d"],
      absences: windows,
      now: new Date("2026-10-08T08:00:00.000Z"),
    })).toEqual(["@user-d82a5f", "@user-b4e82d"]);
  });

  it("selects a replacement only from the original available eligible pool", () => {
    const input = {
      originalEligibleReviewers: [
        "@user-a91f5c",
        "@user-2e7d4b",
        "@user-c63a18",
        "@user-author",
        "@user-approved",
        "@user-current",
        "@user-unavailable",
        "@user-absent",
        "@user-c63a18",
      ],
      unavailableReviewer: "@USER-UNAVAILABLE",
      author: "@user-author",
      approvedReviewers: ["@user-approved"],
      currentReviewers: ["@user-current"],
      absences: [{
        reviewerHandle: "@user-absent",
        startAt: new Date("2026-10-01T08:00:00.000Z"),
        endAt: new Date("2026-10-08T08:00:00.000Z"),
      }],
      now: new Date("2026-10-01T08:00:00.000Z"),
      load: {
        "@user-a91f5c": 0,
        "@user-2e7d4b": 0,
        "@user-c63a18": 0,
      },
      selectionKey: "acme/api#8",
    };

    expect(selectAvailabilityReplacement(input)).toEqual({
      candidates: ["@user-2e7d4b", "@user-a91f5c", "@user-c63a18"],
      replacementReviewer: "@user-c63a18",
    });
    expect(selectAvailabilityReplacement(input).replacementReviewer).toBe(
      selectLowestLoadReviewers(input.originalEligibleReviewers.slice(0, 3), input.load, input.selectionKey, 1)[0],
    );
  });

  it("prefers another matched owner over a lower-load fallback replacement", () => {
    expect(selectAvailabilityReplacement({
      originalEligibleReviewers: ["@user-unavailable", "@user-owner", "@user-fallback"],
      originalPreferredReviewers: ["@user-unavailable", "@user-owner"],
      unavailableReviewer: "@user-unavailable",
      author: "@user-author",
      approvedReviewers: [],
      currentReviewers: ["@user-unavailable"],
      absences: [],
      now: new Date("2026-10-01T08:00:00.000Z"),
      load: { "@user-owner": 5, "@user-fallback": 0 },
      selectionKey: "acme/api#2674",
    })).toMatchObject({
      candidates: ["@user-fallback", "@user-owner"],
      replacementReviewer: "@user-owner",
    });
  });
});
