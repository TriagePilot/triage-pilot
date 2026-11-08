// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { QueueItem } from "@triagepilot/contracts";
import { queueAssessment, queuePull, queueReviewState, queueSnapshot } from "../../../test/pull-request-queue-fixtures.js";
import { PullRequests } from "../src/index.js";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const workspace = { id: "1", displayName: "Test" };
const authorization = { canViewOperations: true, canManageConfiguration: false, canManageReviewerAvailability: false, canRunRoutingRecovery: false };
const item: QueueItem = { pullRequest: queuePull({ requestedUsers: [{ id: "2", login: "bob", type: "human" }], requestedTeams: [{ id: "t", name: "team" }] }), reviewState: queueReviewState(), assessment: queueAssessment(), attention: { group: "reviewers", badge: "reviewers_move", reason: "Waiting", actorIds: ["2"], teamIds: ["t"], secondaryReasons: ["Concurrent request"], approvedCount: null, requiredCount: 1, assessmentStatus: "current", checkUpdatePending: false }, links: { provider: "https://example.com/pr", decision: "https://example.com/decisions" } };
let root: Root; let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.replaceChildren(); });
it("renders owners and evidence, traps dialog focus, restores focus, and refreshes only on demand", async () => {
  const api = { readPullRequestQueue: vi.fn().mockResolvedValue(queueSnapshot({ items: [item], totalOpen: 1 })) };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<PullRequests api={api} workspace={workspace} authorization={authorization} />));
  expect(container.textContent).toContain("bob, team"); expect(container.textContent).toContain("Last updated:"); expect(api.readPullRequestQueue).toHaveBeenCalledTimes(1);
  const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent === "Change")!;
  await act(async () => trigger.click()); expect(container.textContent).toContain("Concurrent request"); expect(container.textContent).toContain("Approvals: Unknown"); expect(container.textContent).toContain("Projected risk"); expect(container.textContent).toContain("Decision: 1");
  const dialog = container.querySelector('[role="dialog"]')!; const close = dialog.querySelector("button")!; expect(document.activeElement).toBe(close);
  await act(async () => close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }))); expect(document.activeElement?.textContent).toBe("View routing decisions");
  await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); expect(document.activeElement).toBe(trigger);
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!.click()); expect(api.readPullRequestQueue).toHaveBeenCalledTimes(2); expect(api.readPullRequestQueue).toHaveBeenLastCalledWith(workspace, { forceRefresh: true }, expect.any(AbortSignal));
});
it("renders empty and partial snapshots accurately", async () => {
  const api = { readPullRequestQueue: vi.fn().mockResolvedValue(queueSnapshot({ status: "partial", membershipComplete: false, totalOpen: null })) };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<PullRequests api={api} workspace={workspace} authorization={authorization} />));
  expect(container.textContent).toContain("Partial coverage"); expect(container.textContent).not.toContain("No open pull requests.");
});
it("keeps rows during refresh, displays stale failures, and clears them on unauthorized", async () => {
  let reject!: (reason: unknown) => void;
  const pending = new Promise<never>((_, no) => { reject = no; });
  const api = { readPullRequestQueue: vi.fn().mockResolvedValueOnce(queueSnapshot({ items: [item], totalOpen: 1 })).mockReturnValueOnce(pending).mockRejectedValueOnce(Object.assign(new Error("Signed out"), { status: 401 })) };
  const onUnauthorized = vi.fn(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<PullRequests api={api} workspace={workspace} authorization={authorization} onUnauthorized={onUnauthorized} />));
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!.click());
  expect(container.textContent).toContain("Updating pull requests"); expect(container.textContent).toContain("Change");
  await act(async () => reject(new Error("offline"))); expect(container.textContent).toContain("Refresh failed"); expect(container.textContent).toContain("Change");
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!.click()); expect(onUnauthorized).toHaveBeenCalledWith("Signed out"); expect(container.textContent).not.toContain("Change");
});
it("limits each group to 50 and changes local filters without another request", async () => {
  const items = Array.from({ length: 51 }, (_, index) => ({ ...item, pullRequest: { ...item.pullRequest, number: index + 1, title: `Change ${index + 1}` } }));
  const api = { readPullRequestQueue: vi.fn().mockResolvedValue(queueSnapshot({ items, totalOpen: 51 })) };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<PullRequests api={api} workspace={workspace} authorization={authorization} />));
  expect(container.querySelectorAll(".queue-row")).toHaveLength(50);
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Show more")!.click()); expect(container.querySelectorAll(".queue-row")).toHaveLength(51);
  const person = [...container.querySelectorAll("select")].find((element) => element.parentElement?.textContent?.startsWith("Person"))!;
  await act(async () => { person.value = "2"; person.dispatchEvent(new Event("change", { bubbles: true })); }); expect(container.textContent).toContain("reviewer"); expect(api.readPullRequestQueue).toHaveBeenCalledTimes(1);
  const search = container.querySelector("input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "not found"); search.dispatchEvent(new Event("input", { bubbles: true })); }); expect(container.textContent).toContain("Clear filters");
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!.click()); expect(container.querySelectorAll(".queue-row").length).toBeGreaterThan(0);
});
it("ignores a late response after a workspace switch", async () => {
  let resolve!: (value: ReturnType<typeof queueSnapshot>) => void; const pending = new Promise<ReturnType<typeof queueSnapshot>>((yes) => { resolve = yes; });
  const api = { readPullRequestQueue: vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(queueSnapshot({ workspaceId: "2" })) };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<PullRequests api={api} workspace={workspace} authorization={authorization} />)); expect(container.textContent).toContain("Loading pull requests");
  await act(async () => root.render(<PullRequests api={api} workspace={{ id: "2", displayName: "Other" }} authorization={authorization} />));
  await act(async () => resolve(queueSnapshot({ items: [item], totalOpen: 1 }))); expect(container.textContent).not.toContain("Change"); expect(container.textContent).toContain("No open pull requests");
});
