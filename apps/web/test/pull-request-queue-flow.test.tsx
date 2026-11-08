// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { QueueItem } from "@triagepilot/contracts";
import { queuePull, queueReviewState, queueSnapshot } from "../../../test/pull-request-queue-fixtures.js";
import { App, Dashboard } from "../src/admin/App";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.location.hash = "";
  vi.unstubAllGlobals();
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
  expect(container.querySelectorAll(".queue-row")).toHaveLength(2);
  expect(container.textContent).toContain("Draft in another repository");
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
  expect(api.readPullRequestQueue).toHaveBeenLastCalledWith(workspace, { forceRefresh: true }, expect.any(AbortSignal));
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
