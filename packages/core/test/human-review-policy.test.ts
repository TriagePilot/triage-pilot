import { describe, expect, it } from "vitest";
import { evaluateHumanReviewPolicy } from "../src/review-policy";

describe("recoverable assignment shortages", () => {
  it.each(["human_review", "no_eligible_reviewer"] as const)("enforces the full quota for %s independently of selected reviewers", (route) => {
    const input = { route, selectedReviewers: [], requiredApprovalCount: 2, reviews: [] };
    expect(evaluateHumanReviewPolicy(input)).toMatchObject({ state: "in_progress", summary: "Waiting for 2 more human approvals." });
    const approval = { actor: "manual-one", actorType: "human", state: "approved", submittedAt: "2026-11-13T10:00:00Z" };
    expect(evaluateHumanReviewPolicy({ ...input, reviews: [approval] })).toMatchObject({ state: "in_progress", summary: "Waiting for 1 more human approval." });
    expect(evaluateHumanReviewPolicy({ ...input, reviews: [approval, { ...approval, actor: "manual-two" }] })).toMatchObject({ state: "success" });
    expect(evaluateHumanReviewPolicy({ ...input, reviews: [approval, { ...approval, actor: "bot", actorType: "bot" }] })).toMatchObject({ state: "in_progress" });
    expect(evaluateHumanReviewPolicy({ ...input, requiredApprovalCount: 1, reviews: [approval] })).toMatchObject({ state: "success" });
    expect(evaluateHumanReviewPolicy({ ...input, requiredApprovalCount: 1, reviews: [approval, { ...approval, state: "dismissed", submittedAt: "2026-11-13T11:00:00Z" }] })).toMatchObject({ state: "in_progress" });
  });

  it.each([undefined, null, 0, 3, 1.5, "2", NaN])("fails closed for invalid quota evidence %s", (count) => {
    expect(evaluateHumanReviewPolicy({ route: "human_review", selectedReviewers: ["one"], requiredApprovalCount: count as number, reviews: [] })).toMatchObject({ state: "failure", summary: expect.stringContaining("routing recovery") });
  });
});
