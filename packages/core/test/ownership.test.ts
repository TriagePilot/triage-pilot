import { describe, expect, it } from "vitest";

import { matchOwnership } from "../src/ownership";

describe("matchOwnership", () => {
  it("returns matched reviewers and uncovered files", () => {
    const result = matchOwnership({
      files: ["src/billing/invoice.ts", "docs/readme.md"],
      rules: [{ paths: ["src/billing/**"], reviewers: ["@user-b4e82d", "@user-5c9f21"] }],
      fallbackReviewers: ["@team-a7f19c/engineers"],
    });

    expect(result.matchedRules).toEqual([
      {
        index: 0,
        paths: ["src/billing/**"],
        reviewers: ["@user-b4e82d", "@user-5c9f21"],
        matchedFiles: ["src/billing/invoice.ts"],
      },
    ]);
    expect(result.preferredReviewers).toEqual(["@user-b4e82d", "@user-5c9f21"]);
    expect(result.eligibleReviewers).toEqual([
      "@user-b4e82d",
      "@user-5c9f21",
      "@team-a7f19c/engineers",
    ]);
    expect(result.uncoveredFiles).toEqual(["docs/readme.md"]);
  });

  it("uses fallback reviewers when no ownership rule matches", () => {
    const result = matchOwnership({
      files: ["docs/readme.md"],
      rules: [{ paths: ["src/billing/**"], reviewers: ["@user-b4e82d"] }],
      fallbackReviewers: ["@team-a7f19c/engineers"],
    });

    expect(result.eligibleReviewers).toEqual(["@team-a7f19c/engineers"]);
    expect(result.preferredReviewers).toEqual(["@team-a7f19c/engineers"]);
    expect(result.usedFallback).toBe(true);
  });
});
