// @vitest-environment happy-dom
import { analyticsRow, normalizedReport, shadowHighRow } from "../../../test/analytics-fixtures.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AnalyticsReport, CurrentWorkloadReport } from "@triagepilot/contracts";
import { Analytics, type AnalyticsApiClient } from "../src/index";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const workspace = { id: "one", displayName: "Forge" };
const authorization = { canViewOperations: true, canManageConfiguration: false, canManageReviewerAvailability: false, canRunRoutingRecovery: false };
const repository = { recordId: "repo", repository: { provider: "gitlab" as const, externalId: "project", owner: "team", name: "service" } };
const report: AnalyticsReport = {
  query: { periodDays: 30, mode: "auto", repositoryIds: [], averageReviewMinutes: 30 }, mode: "enforce",
  start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z", repositories: [repository],
  counts: { assessed: 100, couldNotAssess: 2, humanRequired: 50, noHumanRequired: 50, unknownRequirements: 0, riskLow: 50, riskMedium: 30, riskHigh: 10, riskUnknown: 10 },
  shortages: { affectedPrs: 0, missingReviewers: 0, unknownPrs: 100 },
  noHumanSharePercent: 50,
  savings: { eligiblePrs: 90, excludedPrs: 12, baselineReviews: 90, requiredReviews: 40, netFewerReviews: 50, estimatedHoursSaved: 25, reductionPercent: 55.6 },
  assignments: [{ actor: "history-only", count: 4, sharePercent: 100, days: [{ day: "2026-10-01", count: 4 }] }],
  coverage: { unidentifiedDecisions: 1, unknownOriginalAssignments: 2 },
};
const current: CurrentWorkloadReport = {
  status: "complete", observedAt: "2026-10-31T00:00:00.000Z", trackedSince: "2026-08-02T00:00:00.000Z",
  scope: { workspaceId: "one", providerConnectionId: "connection", externalConnectionId: "forge.example", repositories: [repository] },
  coveredRepositoryIds: ["repo"], unavailableRepositoryIds: [], averageReviewMinutes: 30, totalPending: 3, totalEstimatedHours: 1.5,
  rows: [{ actor: "current-only", pendingCount: 3, estimatedHours: 1.5 }],
};
function api(): AnalyticsApiClient { return { readAnalytics: vi.fn().mockResolvedValue(report), readCurrentWorkload: vi.fn().mockResolvedValue(current) }; }
let root: Root;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.replaceChildren(); });
async function mount(client = api(), allowed = true) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Analytics api={client} workspace={workspace} authorization={{ ...authorization, canViewOperations: allowed }} />));
  return client;
}
const text = () => container.textContent ?? "";
async function change(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    const proto = input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function click(label: string) { await act(async () => { Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label)!.click(); }); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

it("switches analytics views with click and keyboard", async () => {
  await mount();
  const assignments = container.querySelectorAll<HTMLElement>('[role="tabpanel"]')[0]!;
  const workload = container.querySelectorAll<HTMLElement>('[role="tabpanel"]')[1]!;
  expect(assignments.hidden).toBe(false); expect(workload.hidden).toBe(true);
  await click("Reviewer workload");
  expect(assignments.hidden).toBe(true); expect(workload.hidden).toBe(false);
  const tab = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!;
  expect(tab.getAttribute("aria-selected")).toBe("true");
  await act(async () => tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(assignments.hidden).toBe(false); expect(workload.hidden).toBe(true);
  expect(document.activeElement).toBe(container.querySelectorAll('[role="tab"]')[0]);
});

it("renders estimated value, denominators, risk coverage, UTC bars and merged developer rows with provider-neutral scope", async () => {
  const client = await mount();
  expect(text()).toContain("25.0 h"); expect(text()).toContain("Estimated review effort saved"); expect(text()).toContain("Baseline: 1 reviewer/PR");
  expect(text()).toContain("30 minutes per review"); expect(text()).toContain("90 eligible PRs"); expect(text()).toContain("100 assessed PRs");
  expect(text()).toContain("50.0% of assessed PRs with known requirements");
  expect(text()).toContain("Unknown: 10 (10.0%)"); expect(text()).toContain("UTC daily assignments");
  expect(container.querySelector("svg")).not.toBeNull(); expect(text()).toContain("2026-10-01");
  expect(text()).toContain("Current counts are independent of the selected history period and mode.");
  expect(text()).toContain("Tracked PRs only"); expect(text()).toContain("history-only"); expect(text()).toContain("current-only");
  expect(text()).toContain("team/service"); expect(container.innerHTML).not.toContain("github.com");
  expect(client.readAnalytics).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe("Enforced outcomes");
});
it("filters history without refetching current, resolves auto once, validates assumptions, and refreshes current manually", async () => {
  const client = await mount();
  await change("History period", "7"); await change("History period", "90"); await change("History period", "30"); await click("Shadow projections");
  expect(client.readAnalytics).toHaveBeenLastCalledWith(workspace, expect.objectContaining({ periodDays: 30, mode: "shadow" }), expect.any(AbortSignal));
  expect(client.readCurrentWorkload).toHaveBeenCalledTimes(1);
  await change("Repository scope", "repo"); expect(client.readCurrentWorkload).toHaveBeenCalledTimes(2);
  await change("Average review minutes", "0"); expect(text()).toContain("whole number from 1 to 480"); expect(client.readCurrentWorkload).toHaveBeenCalledTimes(2);
  await change("Average review minutes", "60"); expect(client.readCurrentWorkload).toHaveBeenCalledTimes(3);
  await click("Refresh current workload"); expect(client.readCurrentWorkload).toHaveBeenLastCalledWith(workspace, expect.objectContaining({ forceRefresh: true, averageReviewMinutes: 60 }), expect.any(AbortSignal));
});
it("keeps history when current fails and never converts unknown pending counts to zero", async () => {
  const client = api(); vi.mocked(client.readCurrentWorkload).mockRejectedValue(new Error("Provider unavailable")); await mount(client);
  expect(text()).toContain("25.0 h"); expect(text()).toContain("Unavailable"); expect(text()).toContain("Provider unavailable");
});
it("renders shadow projections, negative effort, and no-assessment null shares honestly", async () => {
  const client = api(); vi.mocked(client.readAnalytics).mockResolvedValue({ ...report, mode: "shadow", counts: { ...report.counts, assessed: 0 }, noHumanSharePercent: null, savings: { ...report.savings, netFewerReviews: -2, estimatedHoursSaved: -1, reductionPercent: null } });
  vi.mocked(client.readCurrentWorkload).mockResolvedValue({ ...current, status: "partial", totalPending: null, totalEstimatedHours: null, rows: [{ actor: "current-only", pendingCount: null, estimatedHours: null }] });
  await mount(client); expect(text()).toContain("Projected review effort saved"); expect(text()).toContain("Proposed assignments"); expect(text()).toContain("2 additional reviews"); expect(text()).toContain("1.0 h additional effort"); expect(text()).toContain("No assessments"); expect(text()).toContain("Unavailable");
});
it("rejects stale history and current success/error after filters and workspace change, even when the host ignores abort", async () => {
  const oldHistory = deferred<AnalyticsReport>(), oldCurrent = deferred<CurrentWorkloadReport>();
  const client = api(); vi.mocked(client.readAnalytics).mockReturnValueOnce(oldHistory.promise); vi.mocked(client.readCurrentWorkload).mockReturnValueOnce(oldCurrent.promise);
  await mount(client); await change("History period", "7"); await click("Refresh current workload");
  await act(async () => { oldHistory.resolve({ ...report, savings: { ...report.savings, estimatedHoursSaved: 999 } }); oldCurrent.reject(Object.assign(new Error("stale unauthorized"), { status: 401 })); });
  expect(text()).not.toContain("999"); expect(text()).not.toContain("stale unauthorized");
  const prior = deferred<AnalyticsReport>(); vi.mocked(client.readAnalytics).mockReturnValueOnce(prior.promise); await change("History period", "90");
  await act(async () => root.render(<Analytics api={client} workspace={{ id: "two", displayName: "Second" }} authorization={authorization} />));
  await act(async () => prior.resolve({ ...report, savings: { ...report.savings, estimatedHoursSaved: 888 } }));
  expect(text()).not.toContain("888"); expect(text()).toContain("Second");
});
it("does not read or disclose analytics without operations access", async () => { const client = await mount(api(), false); expect(client.readAnalytics).not.toHaveBeenCalled(); expect(client.readCurrentWorkload).not.toHaveBeenCalled(); expect(text()).toContain("not authorized"); });

it("ignores out-of-order repository responses for both resources and stale unauthorized callbacks", async () => {
  const client = api(); await mount(client);
  const oldHistory = deferred<AnalyticsReport>(), oldCurrent = deferred<CurrentWorkloadReport>();
  vi.mocked(client.readAnalytics).mockReturnValueOnce(oldHistory.promise);
  vi.mocked(client.readCurrentWorkload).mockReturnValueOnce(oldCurrent.promise);
  await change("Repository scope", "repo");
  const historySignal = vi.mocked(client.readAnalytics).mock.calls.at(-1)![2];
  const currentSignal = vi.mocked(client.readCurrentWorkload).mock.calls.at(-1)![2];
  await change("Repository scope", "");
  expect(historySignal?.aborted).toBe(true); expect(currentSignal?.aborted).toBe(true);
  await act(async () => { oldHistory.reject(Object.assign(new Error("Old auth failure"), { status: 401 })); oldCurrent.resolve({ ...current, totalPending: 777, rows: [{ actor: "stale-actor", pendingCount: 777, estimatedHours: 388.5 }] }); });
  expect(text()).not.toContain("Old auth failure"); expect(text()).not.toContain("stale-actor"); expect(text()).not.toContain("777");
  expect(text()).toContain("25.0 h");
});
it("keeps workspace current results and authorization callbacks safe after an ignored abort", async () => {
  const client = api(); const pending = deferred<CurrentWorkloadReport>();
  vi.mocked(client.readCurrentWorkload).mockReturnValueOnce(pending.promise);
  await mount(client);
  const callback = vi.fn();
  await act(async () => root.render(<Analytics api={client} workspace={{ id: "second", displayName: "Second" }} authorization={authorization} onUnauthorized={callback} />));
  await act(async () => pending.reject(Object.assign(new Error("Old workspace expired"), { status: 401 })));
  expect(callback).not.toHaveBeenCalled(); expect(text()).not.toContain("Old workspace expired"); expect(text()).toContain("Second");
});
it("keeps current workload when history fails and notifies the host about current authorization errors", async () => {
  const client = api(); vi.mocked(client.readAnalytics).mockRejectedValue(new Error("Historical read failed")); await mount(client);
  expect(text()).toContain("History unavailable: Historical read failed"); expect(text()).toContain("1.5 h");
  const callback = vi.fn(); vi.mocked(client.readCurrentWorkload).mockRejectedValueOnce(Object.assign(new Error("Session expired"), { status: 401 }));
  await act(async () => root.render(<Analytics api={client} workspace={workspace} authorization={authorization} onUnauthorized={callback} />));
  await click("Refresh current workload"); expect(callback).toHaveBeenCalledExactlyOnceWith("Session expired"); expect(text()).toContain("Unavailable");
});
it("shows zero assessments without false shares and complete empty current workload as zero", async () => {
  const client = api();
  vi.mocked(client.readAnalytics).mockResolvedValue({ ...report, counts: { assessed: 0, couldNotAssess: 0, humanRequired: 0, noHumanRequired: 0, unknownRequirements: 0, riskLow: 0, riskMedium: 0, riskHigh: 0, riskUnknown: 0 }, noHumanSharePercent: null, savings: { eligiblePrs: 0, excludedPrs: 0, baselineReviews: 0, requiredReviews: 0, netFewerReviews: 0, estimatedHoursSaved: 0, reductionPercent: null }, assignments: [] });
  vi.mocked(client.readCurrentWorkload).mockResolvedValue({ ...current, totalPending: 0, totalEstimatedHours: 0, rows: [] });
  await mount(client); expect(text()).toContain("No assessments"); expect(text()).toContain("Current pending: 0"); expect(text()).toContain("0.0 h"); expect(text()).not.toContain("100%"); expect(text()).not.toContain("100.0%");
});
it("retains explicit shadow mode across date changes and rejects invalid minutes without sending them", async () => {
  const client = await mount(); await click("Shadow projections"); await change("History period", "7");
  expect(client.readAnalytics).toHaveBeenLastCalledWith(workspace, expect.objectContaining({ mode: "shadow", periodDays: 7 }), expect.any(AbortSignal));
  const before = vi.mocked(client.readAnalytics).mock.calls.length;
  for (const value of ["", "1.5", "481", "-1"]) await change("Average review minutes", value);
  expect(client.readAnalytics).toHaveBeenCalledTimes(before); expect(client.readCurrentWorkload).toHaveBeenCalledTimes(1);
  await change("Average review minutes", "480"); expect(client.readAnalytics).toHaveBeenLastCalledWith(workspace, expect.objectContaining({ averageReviewMinutes: 480 }), expect.any(AbortSignal));
});

it("shows actual shadow shortages and unknown history beside the eligible projection cohort", async () => {
  const historical = normalizedReport([
    shadowHighRow(1, []), shadowHighRow(2, ["@one"]), shadowHighRow(3, ["@one", "@two"]),
    { ...analyticsRow, mode: "shadow", action_status: "not_applied", details: { routing: { requestedReviewerCount: 2 } } },
  ]);
  const client = api(); vi.mocked(client.readAnalytics).mockResolvedValue(historical);
  await mount(client);
  const panel = container.querySelector('[aria-label="Review value"]')!.textContent;
  expect(panel).toContain("4 eligible PRs in the projection cohort; 0 excluded");
  expect(panel).toContain("Reviewer shortages among assessed PRs: 2 PRs; 3 missing reviewers; 1 PRs with unknown shortage");
  expect(panel).toContain("Shadow projections have not enacted these savings or assignments");
});


it("keeps keyboard focus within each analytics instance", async () => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<><Analytics api={api()} workspace={workspace} authorization={authorization} /><Analytics api={api()} workspace={workspace} authorization={authorization} /></>));
  const lists = container.querySelectorAll('[role="tablist"]');
  const second = lists[1]!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(async () => { second[0]!.focus(); second[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(document.activeElement).toBe(second[1]);
  const ids = [...container.querySelectorAll('[role="tab"], [role="tabpanel"]')].map(element => element.id);
  expect(new Set(ids).size).toBe(ids.length);
});

it("labels shadow effort and assignment tabs according to the loaded mode", async () => {
  const client = api(); vi.mocked(client.readAnalytics).mockResolvedValue({ ...report, mode: "shadow", savings: { ...report.savings, estimatedHoursSaved: -1 } });
  await mount(client);
  expect(container.querySelectorAll(".analytics-metric span")[1]?.textContent).toBe("Projected additional review effort");
  expect(container.querySelector('[role="tab"]')?.textContent).toBe("Proposed assignments");
  vi.mocked(client.readAnalytics).mockResolvedValue(report);
  await change("History period", "7");
  expect(container.querySelector('[role="tab"]')?.textContent).toBe("Reviewer assignments");
});

it("uses the latest unauthorized callback for a pending request", async () => {
  const pending = deferred<AnalyticsReport>(); const client = api();
  vi.mocked(client.readAnalytics).mockReturnValueOnce(pending.promise);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const previous = vi.fn(), latest = vi.fn();
  await act(async () => root.render(<Analytics api={client} workspace={workspace} authorization={authorization} onUnauthorized={previous} />));
  await act(async () => root.render(<Analytics api={client} workspace={workspace} authorization={authorization} onUnauthorized={latest} />));
  await act(async () => pending.reject(Object.assign(new Error("Session expired"), { status: 401 })));
  expect(previous).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledExactlyOnceWith("Session expired");
});

it("paginates current workload five rows at a time and resets for scope filters", async () => {
  const client = api();
  vi.mocked(client.readCurrentWorkload).mockResolvedValue({
    ...current,
    rows: Array.from({ length: 12 }, (_, i) => ({
      actor: `developer-${String(i).padStart(2, "0")}`,
      pendingCount: i,
      estimatedHours: i / 2,
    })),
  });
  await mount(client);
  await click("Reviewer workload");
  const body = () =>
    container.querySelector('[role="tabpanel"]:not([hidden]) tbody')!;
  expect(body().querySelectorAll("tr")).toHaveLength(5);
  await click("Next");
  expect(body().textContent).toContain("developer-05");
  expect(body().textContent).not.toContain("developer-00");
  await change("Repository scope", "repo");
  expect(body().textContent).toContain("developer-00");
});
it("refreshes analytics history and current workload together and retries failed history", async () => {
  const client = api();
  await mount(client);
  vi.mocked(client.readAnalytics).mockRejectedValueOnce(
    new Error("temporary history outage"),
  );
  await click("Refresh analytics");
  expect(text()).toContain("temporary history outage");
  expect(client.readCurrentWorkload).toHaveBeenCalledTimes(2);
  await click("Retry history");
  expect(text()).not.toContain("temporary history outage");
  expect(text()).toContain("25.0 h");
});
