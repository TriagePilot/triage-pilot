import { describe, expect, it } from "vitest";

import { matchOwnership } from "../src/ownership";

describe("matchOwnership", () => {
  it("returns matched reviewers and uncovered files", () => {
    const result = matchOwnership({
      files: ["src/billing/invoice.ts", "docs/readme.md"],
      rules: [{ paths: ["src/billing/**"], reviewers: ["@devon", "@jordan"] }],
      fallbackReviewers: ["@acme/engineers"],
    });

    expect(result.matchedRules).toEqual([
      {
        index: 0,
        paths: ["src/billing/**"],
        reviewers: ["@devon", "@jordan"],
        matchedFiles: ["src/billing/invoice.ts"],
      },
    ]);
    expect(result.eligibleReviewers).toEqual(["@devon", "@jordan"]);
    expect(result.uncoveredFiles).toEqual(["docs/readme.md"]);
  });

  it("uses fallback reviewers when no ownership rule matches", () => {
    const result = matchOwnership({
      files: ["docs/readme.md"],
      rules: [{ paths: ["src/billing/**"], reviewers: ["@devon"] }],
      fallbackReviewers: ["@acme/engineers"],
    });

    expect(result.eligibleReviewers).toEqual(["@acme/engineers"]);
    expect(result.usedFallback).toBe(true);
  });
});
