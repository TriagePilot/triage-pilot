import type { AnalyticsQuery } from "@triagepilot/contracts";

export class AnalyticsQueryError extends Error {}
export interface CurrentWorkloadQuery {
  repositoryIds: string[];
  averageReviewMinutes: number;
  forceRefresh: boolean;
}

function scalar(params: URLSearchParams, name: string, fallback: string): string {
  const values = params.getAll(name);
  if (values.length > 1) throw new AnalyticsQueryError("Duplicate scalar query field");
  return values[0] ?? fallback;
}
function common(params: URLSearchParams, allowed: string[]) {
  for (const key of params.keys()) if (!allowed.includes(key)) throw new AnalyticsQueryError("Unsupported query field");
  const minutes = scalar(params, "averageReviewMinutes", "30");
  if (!/^[1-9]\d*$/.test(minutes) || Number(minutes) > 480) throw new AnalyticsQueryError("Invalid review minutes");
  const repositoryIds = params.getAll("repositoryId");
  if (repositoryIds.some(id => !id || id.trim() !== id)) throw new AnalyticsQueryError("Invalid repository ID");
  return { repositoryIds: [...new Set(repositoryIds)], averageReviewMinutes: Number(minutes) };
}
export function parseAnalyticsQuery(params: URLSearchParams): AnalyticsQuery {
  const shared = common(params, ["periodDays", "mode", "repositoryId", "averageReviewMinutes"]);
  const period = scalar(params, "periodDays", "30");
  if (period !== "7" && period !== "30" && period !== "90") throw new AnalyticsQueryError("Invalid period");
  const mode = scalar(params, "mode", "auto");
  if (mode !== "auto" && mode !== "shadow" && mode !== "enforce") throw new AnalyticsQueryError("Invalid mode");
  return { ...shared, periodDays: Number(period) as AnalyticsQuery["periodDays"], mode };
}
export function parseWorkloadQuery(params: URLSearchParams): CurrentWorkloadQuery {
  const shared = common(params, ["repositoryId", "averageReviewMinutes", "forceRefresh"]);
  const refresh = scalar(params, "forceRefresh", "false");
  if (refresh !== "true" && refresh !== "false") throw new AnalyticsQueryError("Invalid refresh");
  return { ...shared, forceRefresh: refresh === "true" };
}
