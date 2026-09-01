import { describe, expect, it } from "vitest";

import { decideRouting } from "../src/routing";

describe("decideRouting", () => {
  it("returns the intended policy approval for a low-risk pull request", () => {
    expect(
      decideRouting({
      risk: { score: 20, tier: "low" },
      author: "@user-c91e46",
      eligibleReviewers: ["@user-b4e82d"],
      load: { "@user-b4e82d": 2 },
      highRiskReviewers: 2,
      selectionKey: "acme/api#7",
      }),
    ).toMatchObject({
      action: "policy_approval",
      requestedReviewerCount: 0,
      selectedReviewers: [],
      reviewerShortfall: 0,
    });
  });

  it("selects one lowest-load non-author reviewer for medium risk", () => {
    const decision = decideRouting({
      risk: { score: 45, tier: "medium" },
      author: "@user-c91e46",
      eligibleReviewers: ["@user-c91e46", "@user-b4e82d", "@user-5c9f21"],
      load: { "@user-b4e82d": 3, "@user-5c9f21": 1 },
      highRiskReviewers: 2,
      selectionKey: "acme/api#7",
    });

    expect(decision).toMatchObject({
      action: "request_human_review",
      requestedReviewerCount: 1,
      selectedReviewers: ["@user-5c9f21"],
      reviewerShortfall: 0,
    });
  });

  it("preserves matching owners ahead of lower-load fallback reviewers", () => {
    expect(
      decideRouting({
        risk: { score: 45, tier: "medium" },
        author: "@user-c91e46",
        preferredReviewers: ["@user-b4e82d"],
        eligibleReviewers: ["@user-b4e82d", "@user-5c9f21"],
        load: { "@user-b4e82d": 9, "@user-5c9f21": 0 },
        highRiskReviewers: 2,
        selectionKey: "acme/api#10",
      }),
    ).toMatchObject({
      selectedReviewers: ["@user-b4e82d"],
      reviewersToRequest: ["@user-b4e82d"],
      reviewerShortfall: 0,
    });
  });

  it("uses fallbacks only to fill ownership slots that remain unfilled", () => {
    expect(
      decideRouting({
        risk: { score: 95, tier: "high" },
        author: "@user-c91e46",
        preferredReviewers: ["@user-b4e82d"],
        eligibleReviewers: ["@user-b4e82d", "@user-5c9f21", "@user-f37a82"],
        load: { "@user-b4e82d": 9, "@user-5c9f21": 4, "@user-f37a82": 0 },
        highRiskReviewers: 2,
        selectionKey: "acme/api#11",
      }),
    ).toMatchObject({
      selectedReviewers: ["@user-b4e82d", "@user-f37a82"],
      reviewersToRequest: ["@user-b4e82d", "@user-f37a82"],
      reviewerShortfall: 0,
    });
  });

  it("selects two reviewers for high risk using a stable non-alphabetical tie break", () => {
    const input = {
      risk: { score: 95, tier: "high" as const },
      author: "@user-c91e46",
      eligibleReviewers: ["@user-a91f5c", "@user-2e7d4b", "@user-c63a18"],
      load: { "@user-a91f5c": 0, "@user-2e7d4b": 0, "@user-c63a18": 0 },
      highRiskReviewers: 2 as const,
      selectionKey: "acme/api#8",
    };

    expect(decideRouting(input)).toMatchObject({
      action: "request_human_review",
      requestedReviewerCount: 2,
      selectedReviewers: ["@user-c63a18", "@user-a91f5c"],
      reviewerShortfall: 0,
    });
    expect(decideRouting(input).selectedReviewers).toEqual(["@user-c63a18", "@user-a91f5c"]);
  });

  it("requests every available non-author candidate and records a high-risk shortfall", () => {
    expect(
      decideRouting({
        risk: { score: 95, tier: "high" },
        author: "@user-a91f5c",
        eligibleReviewers: ["@user-a91f5c", "@user-2e7d4b"],
        load: { "@user-a91f5c": 0, "@user-2e7d4b": 0 },
        highRiskReviewers: 2,
        selectionKey: "acme/api#8",
      }),
    ).toMatchObject({
      action: "request_human_review",
      requestedReviewerCount: 2,
      selectedReviewers: ["@user-2e7d4b"],
      reviewerShortfall: 1,
    });
  });

  it("does not let the author or current-head approvers consume reviewer quota", () => {
    expect(
      decideRouting({
        risk: { score: 95, tier: "high" },
        author: "@user-c91e46",
        eligibleReviewers: ["@user-c91e46", "@user-4d8a2e", "@user-7c1f9b", "@user-a91f5c"],
        existingApprovedReviewers: ["@user-4d8a2e"],
        load: { "@user-7c1f9b": 0, "@user-a91f5c": 1 },
        highRiskReviewers: 2,
        selectionKey: "acme/api#9",
      }),
    ).toMatchObject({
      action: "request_human_review",
      requestedReviewerCount: 2,
      selectedReviewers: ["@user-7c1f9b", "@user-a91f5c"],
      reviewersToRequest: ["@user-7c1f9b", "@user-a91f5c"],
      reviewerShortfall: 0,
    });
  });
});
