import { describe, expect, it } from "vitest";

import { decideRouting } from "../src/routing";

describe("decideRouting", () => {
  it("returns the intended policy approval for a low-risk pull request", () => {
    expect(
      decideRouting({
      risk: { score: 20, tier: "low" },
      author: "@priya",
      eligibleReviewers: ["@devon"],
      load: { "@devon": 2 },
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
      author: "@priya",
      eligibleReviewers: ["@priya", "@devon", "@jordan"],
      load: { "@devon": 3, "@jordan": 1 },
      highRiskReviewers: 2,
      selectionKey: "acme/api#7",
    });

    expect(decision).toMatchObject({
      action: "request_human_review",
      requestedReviewerCount: 1,
      selectedReviewers: ["@jordan"],
      reviewerShortfall: 0,
    });
  });

  it("selects two reviewers for high risk using a stable non-alphabetical tie break", () => {
    const input = {
      risk: { score: 95, tier: "high" as const },
      author: "@priya",
      eligibleReviewers: ["@alpha", "@bravo", "@charlie"],
      load: { "@alpha": 0, "@bravo": 0, "@charlie": 0 },
      highRiskReviewers: 2 as const,
      selectionKey: "acme/api#8",
    };

    expect(decideRouting(input)).toMatchObject({
      action: "request_human_review",
      requestedReviewerCount: 2,
      selectedReviewers: ["@bravo", "@alpha"],
      reviewerShortfall: 0,
    });
    expect(decideRouting(input).selectedReviewers).toEqual(["@bravo", "@alpha"]);
  });

  it("requests every available non-author candidate and records a high-risk shortfall", () => {
    expect(
      decideRouting({
        risk: { score: 95, tier: "high" },
        author: "@alpha",
        eligibleReviewers: ["@alpha", "@bravo"],
        load: { "@alpha": 0, "@bravo": 0 },
        highRiskReviewers: 2,
        selectionKey: "acme/api#8",
      }),
    ).toMatchObject({
      action: "request_human_review",
      requestedReviewerCount: 2,
      selectedReviewers: ["@bravo"],
      reviewerShortfall: 1,
    });
  });
});
