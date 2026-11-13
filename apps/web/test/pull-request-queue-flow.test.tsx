// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { QueueItem } from "@triagepilot/contracts";
import { queuePull, queueReviewState, queueSnapshot } from "../../../test/pull-request-queue-fixtures.js";
import { App, Dashboard } from "../src/admin/App";
import { createSelfHostedPullRequestQueueApi } from "../src/admin/api";
import { createPullRequestQueueService } from "../../../packages/application/src/pull-request-queue";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.location.hash = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const workspace = { id: "1", displayName: "Fictional workspace" };
const overview = { statuses: [], repositories: [], decisions: [], failures: { jobs: [], actions: [] }, worker: { available: true, workerId: "1", lastHeartbeatAt: null } };
const alice = { id: "1", login: "alice", type: "human" as const };
const item: QueueItem = {
  pullRequest: queuePull({ title: "Authored and requested", requestedUsers: [alice] }),
  reviewState: queueReviewState(), assessment: null,
  attention: { group: "reviewers", badge: "reviewers_move", reason: "Review requested", actorIds: ["1"], teamIds: [], secondaryReasons: [], approvedCount: null, requiredCount: null, assessmentStatus: "absent", checkUpdatePending: false },
  links: { provider: "https://github.com/acme/api/pull/1", decision: null },
};
const draft: QueueItem = {
  ...item,
  pullRequest: queuePull({ title: "Draft in another repository", number: 2, repository: { provider: "github", externalId: "2", owner: "acme", name: "web" }, author: { id: "2", login: "bob", type: "human" }, requestedUsers: [], isDraft: true }),
  attention: { ...item.attention, group: "other", badge: "draft", actorIds: [] },
};
const snapshot = queueSnapshot({ items: [item, draft], totalOpen: 2, repositories: [item, draft].map(({ pullRequest }) => ({ recordId: null, repository: pullRequest.repository })) });
function mount() { const container = document.createElement("div"); document.body.append(container); root = createRoot(container); return container; }
function button(container: HTMLElement, text: string) { return [...container.querySelectorAll("button")].find((node) => node.textContent === text)!; }

it("loads everyone across repos, filters both roles, opens exact links and refreshes away closed rows", async () => {
  window.location.hash = "#pull-requests";
  const container = mount();
  const api = { readPullRequestQueue: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(queueSnapshot({ items: [draft], totalOpen: 1 })) };
  const analyticsApi = { readAnalytics: vi.fn().mockRejectedValue(new Error("History unavailable")), readCurrentWorkload: vi.fn().mockRejectedValue(new Error("Workload unavailable")) };
  await act(async () => root!.render(<Dashboard username="alice" workspace={workspace} overview={overview} pullRequestQueueApi={api} analyticsApi={analyticsApi} onLogout={async () => {}} />));
  expect(container.querySelectorAll(".queue-row")).toHaveLength(1);
  expect(container.textContent).not.toContain("Draft in another repository");
  expect(container.textContent).toContain("Risk: Unknown");
  expect(analyticsApi.readAnalytics).not.toHaveBeenCalled();
  expect(container.querySelector('a[href="#pull-requests"]')?.getAttribute("aria-current")).toBe("location");
  const person = [...container.querySelectorAll("select")].find((node) => node.parentElement?.textContent?.startsWith("Person"))!;
  expect(person.value).toBe("");
  await act(async () => { person.value = "1"; person.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.querySelectorAll(".queue-row")).toHaveLength(1);
  expect([...container.querySelectorAll(".queue-role")].map((node) => node.textContent)).toEqual(["author", "reviewer"]);
  expect(api.readPullRequestQueue).toHaveBeenCalledTimes(1);
  const trigger = button(container, "Authored and requested");
  await act(async () => trigger.click());
  expect(container.querySelector('[role="dialog"] a')?.getAttribute("href")).toBe(item.links.provider);
  await act(async () => container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.activeElement).toBe(trigger);
  await act(async () => button(container, "Refresh").click());
  expect(api.readPullRequestQueue).toHaveBeenLastCalledWith(workspace, { forceRefresh: true, phase: "initial" }, expect.any(AbortSignal));
  expect(container.textContent).not.toContain("Authored and requested");
  await act(async () => { window.location.hash = "#analytics"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  expect(container.querySelector(".queue")).toBeNull();
  expect(analyticsApi.readAnalytics).toHaveBeenCalledTimes(1);
  expect(container.querySelector(".app-topbar strong")?.textContent).toBe("Analytics");
  expect(api.readPullRequestQueue).toHaveBeenCalledTimes(2);
});

it("discards an old workspace response in the integrated shell", async () => {
  window.location.hash = "#pull-requests";
  const container = mount();
  let resolve!: (value: typeof snapshot) => void;
  const api = { readPullRequestQueue: vi.fn().mockReturnValueOnce(new Promise((yes) => { resolve = yes; })).mockResolvedValueOnce(queueSnapshot({ workspaceId: "2" })) };
  await act(async () => root!.render(<Dashboard username="admin" workspace={workspace} overview={overview} pullRequestQueueApi={api} onLogout={async () => {}} />));
  await act(async () => root!.render(<Dashboard username="admin" workspace={{ id: "2", displayName: "Second" }} overview={overview} pullRequestQueueApi={api} onLogout={async () => {}} />));
  await act(async () => resolve(snapshot));
  expect(container.textContent).not.toContain("Authored and requested");
  expect(container.textContent).toContain("No open pull requests.");
});

it.each(["logout", "expiry"])("clears protected rows on %s and ignores delayed responses", async (mode) => {
  window.location.hash = "#pull-requests";
  let resolve!: (response: Response) => void;
  let reads = 0;
  vi.stubGlobal("fetch", async (input: string) => {
    if (input === "/api/auth/session") return Response.json({ authenticated: true, username: "admin", workspaceId: "1" });
    if (input === "/api/operations/overview") return Response.json(overview);
    if (input === "/api/auth/logout") return new Response(null, { status: 204 });
    if (input.startsWith("/api/operations/pull-requests")) {
      reads++;
      if (reads === 1 && mode === "expiry") return Response.json(snapshot);
      if (mode === "expiry") return Response.json({}, { status: 401 });
      return new Promise<Response>((yes) => { resolve = yes; });
    }
    if (input.includes("timezone")) return Response.json({ timezone: "UTC", updatedAt: "" });
    return Response.json([]);
  });
  const container = mount();
  await act(async () => root!.render(<App />));
  if (mode === "expiry") {
    expect(container.textContent).toContain("Authored and requested");
    await act(async () => button(container, "Refresh").click());
  } else {
    await act(async () => button(container, "Sign out").click());
    await act(async () => resolve(Response.json(snapshot)));
  }
  expect(container.textContent).toContain("Sign in to TriagePilot");
  expect(container.querySelector(".queue-row")).toBeNull();
  expect(container.textContent).not.toContain("Authored and requested");
});

it("polls real client through bootstrap to completion and coalesces refresh clicks", async () => {
  vi.useFakeTimers();
  window.location.hash = "#pull-requests";
  const syncing = queueSnapshot({ items: [item], totalOpen: null, status: "partial", syncState: "syncing", membershipComplete: false, classificationComplete: false, stale: true, observedAt: null, lastVerifiedAt: null, syncProgress: { runId: "r", phase: "running", updatedAt: new Date().toISOString(), completedRepositories: 0, totalRepositories: 1, retryAt: null } });
  const done = queueSnapshot({ items: [item], totalOpen: 1 });
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(syncing)).mockResolvedValue(Response.json(done));
  vi.stubGlobal("fetch", fetcher);
  const container = mount();
  await act(async () => root!.render(<Dashboard username="admin" workspace={workspace} overview={overview} pullRequestQueueApi={createSelfHostedPullRequestQueueApi()} onLogout={async () => {}} />));
  expect(container.textContent).toContain("Syncing pull requests");
  expect(container.textContent).toContain("Total unavailable");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(container.textContent).not.toContain("Syncing pull requests");
  expect(container.textContent).toContain("1 open");
  expect(fetcher.mock.calls[1]?.[0]).not.toContain("refresh=true");
  await act(async () => button(container, "Refresh").click());
  await act(async () => button(container, "Refresh").click());
  expect(fetcher.mock.calls.filter(call => String(call[0]).includes("refresh=true"))).toHaveLength(1);
});

it("preserves unavailable provider details without an active spinner", async () => {
  window.location.hash = "#pull-requests";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(queueSnapshot({ status: "unavailable", syncState: "unavailable", workerAvailable: false, stale: true, lastVerifiedAt: null, observedAt: null, membershipComplete: false, classificationComplete: false, totalOpen: null, refreshError: "Provider unavailable", syncProgress: { runId: "r", phase: "failed", updatedAt: null, completedRepositories: 0, totalRepositories: null, retryAt: null } }))));
  const container = mount();
  await act(async () => root!.render(<Dashboard username="admin" workspace={workspace} overview={overview} pullRequestQueueApi={createSelfHostedPullRequestQueueApi()} onLogout={async () => {}} />));
  expect(container.textContent).toContain("Provider unavailable");
  expect(container.textContent).toContain("Worker unavailable");
  expect(container.textContent).not.toContain("Syncing pull requests");
  expect(container.textContent).not.toContain("No open pull requests.");
});

it("bounds active polling and suspends it while hidden or unmounted", async () => {
  vi.useFakeTimers();
  window.location.hash = "#pull-requests";
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const syncing = queueSnapshot({ status: "partial", syncState: "syncing", membershipComplete: false, totalOpen: null, syncProgress: { runId: "r", phase: "running", updatedAt: new Date().toISOString(), completedRepositories: 1, totalRepositories: 2, retryAt: null } });
  const fetcher = vi.fn().mockImplementation(async () => Response.json(syncing));
  vi.stubGlobal("fetch", fetcher);
  const container = mount();
  await act(async () => root!.render(<Dashboard username="admin" workspace={workspace} overview={overview} pullRequestQueueApi={createSelfHostedPullRequestQueueApi()} onLogout={async () => {}} />));
  hidden = true;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetcher).toHaveBeenCalledTimes(1);
  hidden = false;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(container.textContent).toContain("Background sync continues");
  expect(container.textContent).not.toContain("Syncing pull requests");
  await act(async () => button(container, "Refresh").click());
  expect(container.textContent).toContain("Background sync continues");
  expect(container.textContent).not.toContain("Syncing pull requests");
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain("refresh=true");
  const count = fetcher.mock.calls.length;
  await act(async () => root!.unmount()); root = undefined;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetcher).toHaveBeenCalledTimes(count);
  vi.restoreAllMocks();
});

// Exercise the real client against snapshots derived by the application service at the
// boundary; the fetch stub only replaces HTTP transport, not freshness calculation.
it.each(["stale", "heartbeat", "progress"] as const)("shows %s boundary from stored state", async (boundary) => {
  vi.useFakeTimers();
  const start = Date.parse("2026-01-01T00:00:00Z");
  vi.setSystemTime(start);
  window.location.hash = "#pull-requests";
  const scope = { workspaceId: "1", providerConnectionId: "c", externalConnectionId: "99", githubOrganization: "acme", knownRepositories: [{ recordId: "r", repository: item.pullRequest.repository }] };
  const verified = new Date(start - (boundary === "stale" ? 1_770_000 : 0));
  const run = boundary === "progress" || boundary === "heartbeat" ? { runId: "r", status: "running" as const, updatedAt: new Date(start), membershipComplete: true, classificationComplete: true, completedRepositories: 1, totalRepositories: 1, coveredRepositoryIds: ["1"], retryAt: null } : null;
  const service = createPullRequestQueueService({
    now: () => new Date(), createSnapshotId: () => "s", resolveScope: async () => scope, assertActive: async () => {}, requestRefresh: async () => {},
    workerAvailable: async () => boundary !== "heartbeat" || Date.now() - start < 60_000,
    readAssessments: async () => new Map(), linksFor: () => item.links,
    readProjection: async () => ({ lastVerifiedAt: verified, syncRun: run, snapshots: [{ snapshot: { pull: item.pullRequest, reviewState: item.reviewState, isOpen: true }, desiredGeneration: 1, appliedGeneration: 1 }] }),
  });
  const fetcher = vi.fn().mockImplementation(async (url: string) => Response.json(await service.read({ workspaceId: "1", forceRefresh: url.includes("refresh=true") })));
  vi.stubGlobal("fetch", fetcher);
  const container = mount();
  await act(async () => root!.render(<Dashboard username="admin" workspace={workspace} overview={overview} pullRequestQueueApi={createSelfHostedPullRequestQueueApi()} onLogout={async () => {}} />));
  expect(container.textContent).toContain("Authored and requested");
  if (boundary === "stale") {
    expect(container.textContent).not.toContain("Stale snapshot");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(container.textContent).toContain("Stale snapshot");
    expect(container.textContent).toContain("Authored and requested");
  } else if (boundary === "heartbeat") {
    expect(container.textContent).toContain("Syncing pull requests");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(container.textContent).toContain("Worker unavailable");
    expect(container.textContent).not.toContain("Syncing pull requests");
    const count = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetcher).toHaveBeenCalledTimes(count);
  } else {
    expect(container.textContent).toContain("Syncing pull requests");
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(container.textContent).toContain("Sync stalled");
    expect(container.textContent).not.toContain("Syncing pull requests");
    expect(container.textContent).toContain("Authored and requested");
  }
});

it("shows a confirmed empty queue through the real client", async () => {
  window.location.hash = "#pull-requests";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(queueSnapshot())));
  const container = mount();
  await act(async () => root!.render(<Dashboard username="admin" workspace={workspace} overview={overview} pullRequestQueueApi={createSelfHostedPullRequestQueueApi()} onLogout={async () => {}} />));
  expect(container.textContent).toContain("No open pull requests.");
  expect(container.textContent).toContain("0 open");
});

it("retains progress and stops the spinner on a transient refresh failure", async () => {
  window.location.hash = "#pull-requests";
  const syncing = queueSnapshot({ items: [item], totalOpen: null, status: "partial", syncState: "syncing", membershipComplete: false, syncProgress: { runId: "r", phase: "running", updatedAt: null, completedRepositories: 1, totalRepositories: 2, retryAt: null } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(syncing)).mockResolvedValueOnce(Response.json({ error: "pull_request_queue_unavailable" }, { status: 503 })));
  const container = mount();
  await act(async () => root!.render(<Dashboard username="admin" workspace={workspace} overview={overview} pullRequestQueueApi={createSelfHostedPullRequestQueueApi()} onLogout={async () => {}} />));
  await act(async () => button(container, "Refresh").click());
  expect(container.textContent).toContain("Authored and requested");
  expect(container.textContent).toContain("Pull requests unavailable");
  expect(container.textContent).toContain("Last known progress: 1 / 2 repositories checked.");
  expect(container.textContent).not.toContain("Syncing pull requests");
});

it("shows coverage progress without labelling unscanned repositories unavailable", async () => {
  window.location.hash = "#pull-requests";
  const container = mount();
  const partial = queueSnapshot({ status: "partial", syncState: "syncing", membershipComplete: false, classificationComplete: false, coveredRepositoryIds: ["1"], unavailableRepositoryIds: [], repositories: [item, draft].map(({ pullRequest }) => ({ recordId: null, repository: pullRequest.repository })), totalOpen: null, syncProgress: { runId: "r", phase: "running", updatedAt: new Date().toISOString(), completedRepositories: 1, totalRepositories: 2, retryAt: null } });
  await act(async () => root!.render(<Dashboard username="admin" workspace={workspace} overview={overview} pullRequestQueueApi={{ readPullRequestQueue: vi.fn().mockResolvedValue(partial) }} onLogout={async () => {}} />));
  expect(container.textContent).toContain("1 repositories covered");
  expect(container.textContent).not.toContain("repositories covered; 0 unavailable");
  expect(container.textContent).not.toContain("Unavailable: acme/web");
});

it("continues to display explicitly unavailable repository names", async () => {
  window.location.hash = "#pull-requests";
  const container = mount();
  const partial = queueSnapshot({ status: "partial", syncState: "partial", membershipComplete: false, unavailableRepositoryIds: ["2"], repositories: [item, draft].map(({ pullRequest }) => ({ recordId: null, repository: pullRequest.repository })), totalOpen: null });
  await act(async () => root!.render(<Dashboard username="admin" workspace={workspace} overview={overview} pullRequestQueueApi={{ readPullRequestQueue: vi.fn().mockResolvedValue(partial) }} onLogout={async () => {}} />));
  expect(container.textContent).toContain("Unavailable: acme/web");
});
