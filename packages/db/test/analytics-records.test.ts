import { analyticsRow, normalizedReport, shadowHighRow } from "../../../test/analytics-fixtures.js";
import { describe, expect, it } from "vitest";
import { normalizeAnalyticsDecision, readOriginalReviewerActors, type AnalyticsDecisionRow } from "../src/analytics-records";
const row: AnalyticsDecisionRow = { id: "d", repository_id: "r", change_request_id: "pr", pull_number: 7, created_at: new Date(), action_applied_at: null, mode: "enforce", action: "no_eligible_reviewer", action_status: "succeeded", risk_score: 80, details: { risk: { tier: "high" }, routing: { requestedReviewerCount: 2, selectedReviewers: [] } }, changeRequest: { repositoryRecordId: "r", repository: { provider: "github", externalId: "1", owner: "acme", name: "api" }, providerConnectionId: "c", changeRequestId: "pr", changeRequestNumber: 7 } };
describe("historical normalization", () => {
 it("preserves high quota despite empty selection and never guesses legacy quotas", () => {
  expect(normalizeAnalyticsDecision(row)?.requiredReviews).toBe(2);
  for (const details of [{}, { risk: { tier: "high" }, routing: { requestedReviewerCount: "2" } }]) expect(normalizeAnalyticsDecision({ ...row, details })?.requiredReviews).toBeNull();
  expect(normalizeAnalyticsDecision({ ...row, details: { risk: { tier: "medium" } } })?.requiredReviews).toBe(1);
  expect(normalizeAnalyticsDecision({ ...row, details: { risk: { tier: "medium" }, routing: { requestedReviewerCount: "bad" } } })?.requiredReviews).toBeNull();
  expect(normalizeAnalyticsDecision({ ...row, action: "configuration_failure", details: { risk: { tier: "low" } } })).toMatchObject({ riskTier: null, riskScore: null, requiredReviews: null });
  expect(normalizeAnalyticsDecision({ ...row, action: "policy_approval", details: { risk: { tier: "low" } } })?.requiredReviews).toBe(0);
 });
 it("distinguishes unknown original recipients from known empty snapshots", () => {
  expect(readOriginalReviewerActors({})).toBeNull();
  expect(readOriginalReviewerActors({ routing: { selectedReviewers: [""] } })).toBeNull();
  expect(readOriginalReviewerActors({ routing: { selectedReviewers: [] } })).toEqual([]);
  expect(readOriginalReviewerActors({ routing: { selectedReviewers: ["@original", "@original"] } })).toEqual(["@original"]);
 });
});

it.each([1, 2, undefined] as const)("retains missing-tier assessments and independently known quota %s through auto reports", (quota) => {
 const input = { ...analyticsRow, details: { routing: { requestedReviewerCount: quota } } };
 const result = normalizedReport([input]);
 expect(normalizeAnalyticsDecision(input)).toMatchObject({ riskScore: 50, riskTier: null, requiredReviews: quota ?? null });
 expect(result.mode).toBe("enforce");
 expect(result.counts).toMatchObject({ assessed: 1, couldNotAssess: 0, riskUnknown: 1, unknownRequirements: quota === undefined ? 1 : 0 });
 expect(result.savings).toMatchObject({ eligiblePrs: quota === undefined ? 0 : 1, excludedPrs: quota === undefined ? 1 : 0, requiredReviews: quota ?? 0 });
});
it("preserves explicit human quotas without inventing a no-human route or finite assessment", () => {
 expect(normalizeAnalyticsDecision({ ...analyticsRow, action: "no_eligible_reviewer", details: { routing: { requestedReviewerCount: 2 } } })).toMatchObject({ requiredReviews: 2, riskScore: 50 });
 expect(normalizedReport([{ ...analyticsRow, action: "policy_approval", details: { routing: { requestedReviewerCount: 0 } } }]).counts).toMatchObject({ assessed: 1, unknownRequirements: 1, noHumanRequired: 0 });
 for (const risk_score of [NaN, Infinity]) expect(normalizedReport([{ ...analyticsRow, risk_score }]).mode).toBe("shadow");
});
it("discloses actual zero-eligible and partial high-two shadow shortages without excluding projections", () => {
 const result = normalizedReport([shadowHighRow(1, []), shadowHighRow(2, ["@one"]), shadowHighRow(3, ["@one", "@two"])]);
 expect(result.mode).toBe("shadow");
 expect(result.shortages).toEqual({ affectedPrs: 2, missingReviewers: 3, unknownPrs: 0 });
 expect(result.savings).toMatchObject({ eligiblePrs: 3, excludedPrs: 0, requiredReviews: 6 });
 expect(result.assignments).toEqual([]);
 expect(normalizedReport([shadowHighRow(1, [])], "enforce").shortages).toEqual({ affectedPrs: 0, missingReviewers: 0, unknownPrs: 0 });
});
it.each([undefined, null, "0", -1, 0.5, 3, NaN, Infinity])("keeps legacy or malformed shortage %s unknown despite selected reviewers", (reviewerShortfall) => {
 const input = { ...analyticsRow, details: { risk: { tier: "high" }, routing: { requestedReviewerCount: 2, selectedReviewers: ["@one", "@two"], reviewerShortfall } } };
 expect(normalizeAnalyticsDecision(input)?.reviewerShortfall).toBeNull();
 expect(normalizedReport([input]).shortages).toEqual({ affectedPrs: 0, missingReviewers: 0, unknownPrs: 1 });
});
it("does not count configuration failures as assessed shortage coverage or accept shortfalls above a known quota", () => {
 expect(normalizedReport([{ ...analyticsRow, action: "configuration_failure", details: { routing: { reviewerShortfall: 2 } } }], "enforce").shortages).toEqual({ affectedPrs: 0, missingReviewers: 0, unknownPrs: 0 });
 expect(normalizeAnalyticsDecision({ ...analyticsRow, details: { routing: { requestedReviewerCount: 1, reviewerShortfall: 2 } } })?.reviewerShortfall).toBeNull();
});
