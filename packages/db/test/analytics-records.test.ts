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
