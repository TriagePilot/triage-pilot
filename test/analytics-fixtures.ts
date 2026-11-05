import { decideRouting } from "../packages/core/src/routing.js";
import { normalizeAnalyticsDecision, type AnalyticsDecisionRow } from "../packages/db/src/analytics-records.js";
import { buildAnalyticsReport } from "../packages/application/src/analytics.js";
import type { AnalyticsDecisionFact, RequestedAnalyticsMode } from "@triagepilot/contracts";

export const analyticsRow: AnalyticsDecisionRow = {
  id: "decision", repository_id: "r", change_request_id: "pr", pull_number: 7,
  created_at: new Date("2026-10-02T00:00:00Z"), action_applied_at: new Date("2026-10-02T00:00:00Z"),
  mode: "enforce", action: "request_human_review", action_status: "succeeded", risk_score: 50,
  details: {}, changeRequest: { repositoryRecordId: "r", repository: { provider: "github", externalId: "1", owner: "acme", name: "api" }, providerConnectionId: "c", changeRequestId: "pr", changeRequestNumber: 7 },
};
export function normalizedReport(rows: AnalyticsDecisionRow[], mode: RequestedAnalyticsMode = "auto") {
  const latestDecisions = rows.map(row => normalizeAnalyticsDecision(row)).filter((fact): fact is AnalyticsDecisionFact => fact !== null);
  return buildAnalyticsReport({
    query: { periodDays: 7, mode, repositoryIds: [], averageReviewMinutes: 30 },
    start: "2026-10-01T00:00:00Z", end: "2026-10-08T00:00:00Z",
    scope: { workspaceId: "w", providerConnectionId: "c", externalConnectionId: "x", repositories: [{ recordId: "r", repository: analyticsRow.changeRequest.repository }] },
    facts: { latestDecisions, assignments: [], knownActors: [], coverage: { unidentifiedDecisions: 0, unknownOriginalAssignments: 0 } },
  });
}
export function shadowHighRow(number: number, eligibleReviewers: string[]): AnalyticsDecisionRow {
  const risk = { score: 80, tier: "high" as const };
  const routing = decideRouting({ risk, author: "@author", eligibleReviewers, highRiskReviewers: 2, load: {}, selectionKey: String(number) });
  return { ...analyticsRow, id: String(number), change_request_id: String(number), pull_number: number,
    changeRequest: { ...analyticsRow.changeRequest, changeRequestId: String(number), changeRequestNumber: number },
    mode: "shadow", action: routing.action, action_status: "not_applied", action_applied_at: null,
    risk_score: risk.score, details: { risk, routing } };
}
