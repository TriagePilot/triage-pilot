import type { AnalyticsDecisionFact, AnalyticsFacts, AnalyticsQuery, AnalyticsRepositoryScope, ReviewerAssignmentFact } from "@triagepilot/contracts";
import { describe, expect, it } from "vitest";
import { buildAnalyticsReport } from "../src/analytics.js";

const start = "2026-10-01T12:00:00.000Z";
const end = "2026-10-08T12:00:00.000Z";
const scope: AnalyticsRepositoryScope = { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "x", repositories: [{ recordId: "r", repository: { provider: "github", externalId: "1", owner: "o", name: "n" } }] };
const query: AnalyticsQuery = { mode: "auto", periodDays: 7, repositoryIds: [], averageReviewMinutes: 30 };
function decision(id: number, overrides: Partial<AnalyticsDecisionFact> = {}): AnalyticsDecisionFact {
  return { decisionId: String(id), changeRequest: { repositoryRecordId: "r", repository: scope.repositories[0]!.repository, providerConnectionId: "c", changeRequestId: String(id), changeRequestNumber: id }, createdAt: start, actionAppliedAt: start, mode: "enforce", action: "policy_approval", actionStatus: "succeeded", riskScore: 10, riskTier: "low", requiredReviews: 0, ...overrides };
}
function report(latestDecisions: AnalyticsDecisionFact[], assignments: ReviewerAssignmentFact[] = [], options: Partial<AnalyticsQuery> = {}) {
  const facts: AnalyticsFacts = { latestDecisions, assignments, knownActors: ["@Zero"], coverage: { unidentifiedDecisions: 2, unknownOriginalAssignments: 3 } };
  return buildAnalyticsReport({ query: { ...query, ...options }, start, end, scope, facts });
}
describe("buildAnalyticsReport", () => {
  it("calculates the exact 100 PR comparison, independently from no-human share", () => {
    const facts = Array.from({ length: 100 }, (_, i) => decision(i + 1, i < 60 ? {} : { action: "request_human_review", riskTier: i < 90 ? "medium" : "high", requiredReviews: i < 90 ? 1 : 2 }));
    const result = report(facts);
    expect(result.savings).toMatchObject({ eligiblePrs: 100, baselineReviews: 100, requiredReviews: 50, netFewerReviews: 50, reductionPercent: 50, estimatedHoursSaved: 25 });
    expect(result.counts.noHumanRequired).toBe(60);
    expect(result.noHumanSharePercent).toBe(60);
    const doubled = report(facts, [], { averageReviewMinutes: 60 });
    expect(doubled.savings.estimatedHoursSaved).toBe(50);
    expect(doubled.counts).toEqual(result.counts);
    expect(report([decision(1, { action: "request_human_review", requiredReviews: 2, riskTier: "high" })]).savings.estimatedHoursSaved).toBe(-0.5);
    expect(report([]).savings.reductionPercent).toBeNull();
    expect(report([]).noHumanSharePercent).toBeNull();
  });
  it("separates assessment, risk, known requirements, and successful savings cohorts", () => {
    const result = report([
      decision(1, { actionStatus: "pending" }), decision(2, { actionStatus: "failed" }),
      decision(3, { action: "no_eligible_reviewer", requiredReviews: 2, riskTier: "high" }),
      decision(4, { requiredReviews: null, riskTier: null }),
      decision(5, { action: "configuration_failure", requiredReviews: null, riskTier: null }),
    ]);
    expect(result.counts).toEqual({ assessed: 4, couldNotAssess: 1, humanRequired: 1, noHumanRequired: 2, unknownRequirements: 1, riskLow: 2, riskMedium: 0, riskHigh: 1, riskUnknown: 1 });
    expect(result.savings).toMatchObject({ eligiblePrs: 1, excludedPrs: 4, requiredReviews: 2, netFewerReviews: -1 });
    expect(result.noHumanSharePercent).toBeCloseTo(200 / 3);
    expect(result.coverage).toEqual({ unidentifiedDecisions: 2, unknownOriginalAssignments: 3 });
  });
  it("retains a human requirement for no eligible reviewer with unknown quota", () => {
    const result = report([decision(1), decision(2, { action: "no_eligible_reviewer", requiredReviews: null })]);
    expect(result.counts.humanRequired).toBe(1);
    expect(result.counts.unknownRequirements).toBe(1);
    expect(result.noHumanSharePercent).toBe(100);
    expect(result.savings.eligiblePrs).toBe(1);
    expect(result.savings.excludedPrs).toBe(1);
  });
  it("excludes missing and non-finite risk scores from assessment and auto detection", () => {
    for (const riskScore of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = report([decision(1, { riskScore })], [], { mode: "enforce" });
      expect(result.counts.couldNotAssess).toBe(1);
      expect(result.counts.assessed).toBe(0);
      expect(result.savings.eligiblePrs).toBe(0);
      expect(report([decision(1, { riskScore })]).mode).toBe("shadow");
    }
  });
  it("resolves auto from selected assessments and never falls back for explicit modes", () => {
    const shadow = decision(1, { mode: "shadow", actionStatus: "not_applied" });
    expect(report([shadow]).mode).toBe("shadow");
    expect(report([shadow, decision(2, { action: "configuration_failure" })]).mode).toBe("shadow");
    expect(report([shadow, decision(3, { actionStatus: "failed" })]).mode).toBe("enforce");
    expect(report([shadow], [], { mode: "enforce" }).counts.assessed).toBe(0);
    expect(report([shadow], [], { mode: "shadow" }).savings.eligiblePrs).toBe(1);
  });
  it("deduplicates normalized PR/actor pairs at their first in-interval occurrence and buckets UTC days", () => {
    const pr = decision(1).changeRequest;
    const assignment = (actor: string, occurredAt: string, overrides: Partial<ReviewerAssignmentFact> = {}): ReviewerAssignmentFact => ({ changeRequest: pr, actor, occurredAt, mode: "enforce", source: "routing", ...overrides });
    const result = report([decision(1)], [
      assignment(" Alice ", "2026-10-03T00:01:00Z"), assignment("@ALICE", start, { source: "replacement" }),
      assignment("alice", "2026-10-01T11:59:59Z"), assignment("@Bob", "2026-10-02T00:30:00+02:00"),
      assignment("@Bob", end), assignment("@Alice", "2026-10-04T00:00:00Z", { changeRequest: decision(2).changeRequest }),
      assignment("@Other", start, { mode: "shadow" }),
    ]);
    const alice = result.assignments.find(row => row.actor === "@alice")!;
    expect(alice.count).toBe(2);
    expect(alice.days.find(day => day.day === "2026-10-01")?.count).toBe(1);
    expect(alice.days.find(day => day.day === "2026-10-04")?.count).toBe(1);
    expect(result.assignments.find(row => row.actor === "@bob")?.days.find(day => day.day === "2026-10-01")?.count).toBe(1);
    expect(result.assignments.find(row => row.actor === "@zero")?.count).toBe(0);
    expect(result.assignments[0]!.days.reduce((n, d) => n + d.count, 0)).toBe(result.assignments[0]!.count);
    expect(result.assignments.reduce((n, row) => n + row.sharePercent, 0)).toBeCloseTo(100);
  });
});
