import { describe, expect, it } from "vitest";
import { parseAnalyticsQuery, parseWorkloadQuery } from "../src/analytics-input";

describe("analytics query", () => {
  it("defaults and deduplicates repository IDs", () => {
    expect(parseAnalyticsQuery(new URLSearchParams())).toEqual({ periodDays: 30, mode: "auto", repositoryIds: [], averageReviewMinutes: 30 });
    expect(parseAnalyticsQuery(new URLSearchParams("periodDays=7&mode=enforce&repositoryId=a&repositoryId=a&repositoryId=b&averageReviewMinutes=480"))).toEqual({ periodDays: 7, mode: "enforce", repositoryIds: ["a", "b"], averageReviewMinutes: 480 });
  });
  it.each(["NaN", "Infinity", "1.5", "", "0", "481", "-1", "1e2", " 30", "30 "])("rejects invalid minutes %s", value => {
    expect(() => parseAnalyticsQuery(new URLSearchParams({ averageReviewMinutes: value }))).toThrow();
    expect(() => parseWorkloadQuery(new URLSearchParams({ averageReviewMinutes: value }))).toThrow();
  });
  it.each(["periodDays=8", "periodDays=", "mode=other", "mode=", "periodDays=7&periodDays=7", "mode=auto&mode=auto", "averageReviewMinutes=30&averageReviewMinutes=30", "repositoryId=", "unexpected=true"])("rejects malformed history %s", query => {
    expect(() => parseAnalyticsQuery(new URLSearchParams(query))).toThrow();
  });
  it.each(["periodDays=30", "mode=auto", "forceRefresh=", "forceRefresh=1", "forceRefresh=true&forceRefresh=true"])("rejects unsupported workload fields %s", query => {
    expect(() => parseWorkloadQuery(new URLSearchParams(query))).toThrow();
  });
  it("accepts only boolean refresh", () => {
    expect(parseWorkloadQuery(new URLSearchParams())).toEqual({ repositoryIds: [], averageReviewMinutes: 30, forceRefresh: false });
    expect(parseWorkloadQuery(new URLSearchParams("forceRefresh=true"))).toMatchObject({ forceRefresh: true });
    expect(parseWorkloadQuery(new URLSearchParams("forceRefresh=false"))).toMatchObject({ forceRefresh: false });
  });
});
