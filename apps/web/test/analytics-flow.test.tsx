// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AnalyticsReport, CurrentWorkloadReport } from "@triagepilot/contracts";
import { App, Dashboard } from "../src/admin/App";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const repository = { recordId: "repo", repository: { provider: "gitlab" as const, externalId: "project", owner: "team", name: "service" } };
const report: AnalyticsReport = {
  query: { periodDays: 30, mode: "auto", repositoryIds: [], averageReviewMinutes: 30 }, mode: "enforce",
  start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z", repositories: [repository],
  counts: { assessed: 100, couldNotAssess: 2, humanRequired: 50, noHumanRequired: 50, unknownRequirements: 0, riskLow: 50, riskMedium: 30, riskHigh: 10, riskUnknown: 10 },
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

it("loads the full report via HTTP at direct analytics entry and preserves history when current refresh fails", async () => {
  const previousHash = window.location.hash;
  window.location.hash = "#analytics";
  let currentRequests = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/operations/analytics/workload?")) {
      currentRequests++;
      return currentRequests === 1 ? Response.json(current) : Response.json({ error: "analytics_unavailable" }, { status: 503 });
    }
    if (String(input).startsWith("/api/operations/analytics?")) return Response.json(report);
    throw new Error(`Unexpected request: ${input}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Dashboard username="admin" overview={{ statuses: [], repositories: [], decisions: [], failures: { jobs: [], actions: [] }, worker: { available: true, workerId: "worker", lastHeartbeatAt: null } }} onLogout={async () => {}} />));
    expect(container.querySelector('.nav-link--active')?.textContent).toBe("Analytics");
    expect(container.querySelector('.app-topbar strong')?.textContent).toBe("Analytics");
    expect(container.textContent).toContain("100 assessed PRs");
    expect(container.textContent).toContain("25.0 h");
    expect(container.textContent).toContain("Current pending: 3");
    expect(container.textContent).toContain("team/service");
    await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Refresh current workload")!.click(); });
    expect(container.textContent).toContain("Could not load the current reviewer workload.");
    expect(container.textContent).toContain("25.0 h");
    expect(container.textContent).toContain("history-only");
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith("/api/operations/analytics?"))).toHaveLength(1);
    await act(async () => { container.querySelector<HTMLAnchorElement>('a[href="#overview"]')!.click(); window.location.hash = "#overview"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(container.textContent).toContain("Operations ledger");
    expect(container.textContent).toContain("Run missing change request");
    expect(container.querySelector('.worker-summary strong')?.textContent).toBe("Worker healthy");
    const url = container.querySelector<HTMLInputElement>('#routing-recovery-url')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(url, "https://github.com/team/service/pull/7");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { url.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(container.textContent).toContain("Routing run queued.");
  } finally {
    await act(async () => root.unmount()); container.remove(); window.location.hash = previousHash; vi.unstubAllGlobals();
  }
});

it("signs out the mounted host when an analytics request expires", async () => {
  const previousHash = window.location.hash;
  window.location.hash = "#analytics";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/auth/session") return Response.json({ authenticated: true, username: "admin", workspaceId: "one" });
    if (path === "/api/operations/overview") return Response.json({ statuses: [], repositories: [], decisions: [], failures: { jobs: [], actions: [] }, worker: { available: true, workerId: "worker", lastHeartbeatAt: null } });
    if (path.startsWith("/api/operations/analytics")) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (path.endsWith("/timezone")) return Response.json({ timezone: "UTC", updatedAt: "2026-10-31T00:00:00.000Z" });
    return Response.json([]);
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    expect(container.textContent).toContain("Sign in to TriagePilot");
    expect(container.textContent).toContain("The administrator session has expired.");
    expect(container.querySelector(".app-sidebar")).toBeNull();
  } finally {
    await act(async () => root.unmount()); container.remove(); window.location.hash = previousHash; vi.unstubAllGlobals();
  }
});
