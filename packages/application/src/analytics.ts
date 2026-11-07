import type { AnalyticsDecisionFact, AnalyticsFacts, AnalyticsQuery, AnalyticsReport, AnalyticsRepositoryScope } from "@triagepilot/contracts";

function assessed(fact: AnalyticsDecisionFact): boolean {
  return fact.action !== "configuration_failure" && fact.riskScore !== null && Number.isFinite(fact.riskScore);
}
function actorKey(actor: string): string {
  const value = actor.trim().replace(/^@/, "").toLowerCase();
  return value ? `@${value}` : "";
}

/** Calculate from already selected latest decisions and the independent assignment stream. */
export function buildAnalyticsReport(input: {
  query: AnalyticsQuery;
  start: string;
  end: string;
  scope: AnalyticsRepositoryScope;
  facts: AnalyticsFacts;
}): AnalyticsReport {
  const { query, start, end, scope, facts } = input;
  const mode = query.mode === "auto"
    ? facts.latestDecisions.some(fact => fact.mode === "enforce" && assessed(fact)) ? "enforce" : "shadow"
    : query.mode;
  const counts: AnalyticsReport["counts"] = { assessed: 0, couldNotAssess: 0, humanRequired: 0, noHumanRequired: 0, unknownRequirements: 0, riskLow: 0, riskMedium: 0, riskHigh: 0, riskUnknown: 0 };
  const savings: AnalyticsReport["savings"] = { eligiblePrs: 0, excludedPrs: 0, baselineReviews: 0, requiredReviews: 0, netFewerReviews: 0, estimatedHoursSaved: 0, reductionPercent: null };
  const shortages: AnalyticsReport["shortages"] = { affectedPrs: 0, missingReviewers: 0, unknownPrs: 0 };
  let knownRequirements = 0;
  for (const fact of facts.latestDecisions) {
    if (fact.mode !== mode) continue;
    const valid = assessed(fact);
    if (!valid) counts.couldNotAssess++;
    else {
      counts.assessed++;
      const shortfall = fact.reviewerShortfall;
      if (typeof shortfall !== "number" || !Number.isSafeInteger(shortfall)
        || shortfall < 0 || shortfall > (fact.requiredReviews ?? 2)) {
        shortages.unknownPrs++;
      } else if (shortfall > 0) {
        shortages.affectedPrs++;
        shortages.missingReviewers += shortfall;
      }
      if (fact.requiredReviews !== null) knownRequirements++;
      if (fact.requiredReviews === null) {
        counts.unknownRequirements++;
        // The human requirement is known even when its exact quota is missing.
        if (fact.action === "no_eligible_reviewer") counts.humanRequired++;
      }
      else if (fact.requiredReviews === 0) counts.noHumanRequired++;
      else counts.humanRequired++;
      if (fact.riskTier === "low") counts.riskLow++;
      else if (fact.riskTier === "medium") counts.riskMedium++;
      else if (fact.riskTier === "high") counts.riskHigh++;
      else counts.riskUnknown++;
    }
    if (!valid || fact.requiredReviews === null || (mode === "enforce" && fact.actionStatus !== "succeeded")) {
      savings.excludedPrs++;
    } else {
      savings.eligiblePrs++;
      savings.requiredReviews += fact.requiredReviews;
    }
  }
  savings.baselineReviews = savings.eligiblePrs;
  savings.netFewerReviews = savings.baselineReviews - savings.requiredReviews;
  savings.estimatedHoursSaved = savings.netFewerReviews * query.averageReviewMinutes / 60;
  savings.reductionPercent = savings.baselineReviews ? savings.netFewerReviews / savings.baselineReviews * 100 : null;

  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  const days: string[] = [];
  for (let time = Math.floor(startTime / 86_400_000) * 86_400_000; time < endTime; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  const rows = new Map<string, { count: number; days: Map<string, number> }>();
  for (const actor of facts.knownActors) {
    const key = actorKey(actor);
    if (key) rows.set(key, { count: 0, days: new Map() });
  }
  const firstPairs = new Map<string, { actor: string; time: number }>();
  for (const assignment of facts.assignments) {
    const time = Date.parse(assignment.occurredAt);
    const actor = actorKey(assignment.actor);
    if (assignment.mode !== mode || !actor || !(time >= startTime && time < endTime)) continue;
    const pr = assignment.changeRequest;
    const key = JSON.stringify([pr.providerConnectionId, pr.repositoryRecordId, pr.changeRequestId, actor]);
    const previous = firstPairs.get(key);
    if (!previous || time < previous.time) firstPairs.set(key, { actor, time });
  }
  for (const { actor, time } of firstPairs.values()) {
    const row = rows.get(actor) ?? { count: 0, days: new Map<string, number>() };
    const day = new Date(time).toISOString().slice(0, 10);
    row.count++;
    row.days.set(day, (row.days.get(day) ?? 0) + 1);
    rows.set(actor, row);
  }
  return {
    query, mode, start, end, repositories: scope.repositories, counts, shortages,
    noHumanSharePercent: knownRequirements ? counts.noHumanRequired / knownRequirements * 100 : null,
    savings,
    assignments: [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([actor, row]) => ({
      actor, count: row.count, sharePercent: firstPairs.size ? row.count / firstPairs.size * 100 : 0,
      days: days.map(day => ({ day, count: row.days.get(day) ?? 0 })),
    })),
    coverage: { ...facts.coverage },
  };
}
