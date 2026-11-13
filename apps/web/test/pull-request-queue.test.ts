import { describe, expect, it, vi } from "vitest";
import { PullRequestQueueUnavailableError } from "@triagepilot/contracts";
import { queueSnapshot } from "../../../test/pull-request-queue-fixtures";
import { createWebApp } from "../src/app";
import { buildServices } from "./helpers";
async function setup(overrides: Parameters<typeof buildServices>[0] = {}) {
  const services = buildServices(overrides), app = createWebApp(services);
  const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "correct-password" }) });
  return { app, headers: { cookie: login.headers.get("set-cookie")!.split(";")[0]!, "x-triagepilot-workspace": services.workspaceId } };
}
const path = "/api/operations/pull-requests";
describe("pull request queue route", () => {
  it("requests the fast initial snapshot for the initial phase", async () => {
    const read = vi.fn(async () => queueSnapshot()); const { app, headers } = await setup({ readPullRequestQueue: read });
    expect((await app.request(path + "?phase=initial", { headers })).status).toBe(200);
    expect(read).toHaveBeenCalledWith({ forceRefresh: false, phase: "initial", signal: expect.any(AbortSignal) });
  });

  it("protects reads before calling providers and prevents HTTP caching", async () => {
    const read = vi.fn(async () => queueSnapshot()), recovery = vi.fn(), routing = vi.fn();
    const { app, headers } = await setup({ readPullRequestQueue: read, queueRoutingRecovery: recovery, acceptRoutingDelivery: routing });
    for (const [requestHeaders, status] of [[{}, 401], [{ ...headers, "x-triagepilot-workspace": "other" }, 403], [{ ...headers, origin: "https://foreign.example" }, 403]] as const) {
      const response = await app.request(path, { headers: requestHeaders });
      expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(read).not.toHaveBeenCalled();
    expect((await app.request(path, { headers })).status).toBe(200);
    expect(recovery).not.toHaveBeenCalled(); expect(routing).not.toHaveBeenCalled();
  });
  it.each(["?refresh=1", "?refresh=", "?refresh=true&refresh=false", "?workspaceId=x", "?repositoryId=x", "?phase=other", "?phase=initial&phase=details"])("rejects invalid query %s", async query => {
    const read = vi.fn(); const { app, headers } = await setup({ readPullRequestQueue: read });
    expect((await app.request(path + query, { headers })).status).toBe(400); expect(read).not.toHaveBeenCalled();
  });
  it.each([queueSnapshot(), queueSnapshot({ status: "partial", membershipComplete: false, coveredRepositoryIds: ["1"], unavailableRepositoryIds: ["2"], totalOpen: null }), queueSnapshot({ stale: true, refreshError: "Pull request queue is rate limited" })])("returns explicit coverage and freshness", async snapshot => {
    const read = vi.fn(async () => snapshot); const { app, headers } = await setup({ readPullRequestQueue: read });
    const response = await app.request(path + "?refresh=true", { headers });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(snapshot);
    expect(read).toHaveBeenCalledWith({ forceRefresh: true, signal: expect.any(AbortSignal) });
  });
  it.each([[new PullRequestQueueUnavailableError("authority"), 404], [new Error("secret-token provider body"), 503], [new PullRequestQueueUnavailableError("rate_limited"), 503]] as const)("sanitizes errors", async (error, status) => {
    const { app, headers } = await setup({ readPullRequestQueue: async () => { throw error; } });
    const response = await app.request(path, { headers }); expect(response.status).toBe(status); expect(await response.text()).not.toContain("secret-token");
  });
  it("returns bootstrap unavailability as a usable snapshot", async () => {
    const { app, headers } = await setup({ readPullRequestQueue: async () => queueSnapshot({ status: "unavailable", totalOpen: null, membershipComplete: false }) });
    expect((await app.request(path, { headers })).status).toBe(200);
  });
});

it("preserves bootstrap progress through the real client and route", async () => {
  const { createSelfHostedPullRequestQueueApi } = await import("../src/admin/api");
  const snapshot = queueSnapshot({ status: "unavailable", syncState: "syncing", membershipComplete: false, classificationComplete: false, totalOpen: null, refreshError: "Provider unavailable", syncProgress: { runId: "run", phase: "queued", updatedAt: "2026-01-01T00:00:00.000Z", completedRepositories: 0, totalRepositories: null, retryAt: "2026-01-01T00:01:00.000Z" } });
  const { app, headers } = await setup({ readPullRequestQueue: async () => snapshot });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => app.request(String(url), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }));
  try {
    const client = createSelfHostedPullRequestQueueApi();
    expect(await client.readPullRequestQueue({ workspaceId: headers["x-triagepilot-workspace"] } as any, { forceRefresh: false })).toEqual(snapshot);
  } finally { fetchMock.mockRestore(); }
});

it("preserves a safe authority error through the real client and route", async () => {
  const { createSelfHostedPullRequestQueueApi } = await import("../src/admin/api");
  const { app, headers } = await setup({ readPullRequestQueue: async () => { throw new PullRequestQueueUnavailableError("authority"); } });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => app.request(String(url), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }));
  try {
    const client = createSelfHostedPullRequestQueueApi();
    await expect(client.readPullRequestQueue({ workspaceId: headers["x-triagepilot-workspace"] } as any, { forceRefresh: false })).rejects.toMatchObject({ status: 404, message: "The GitHub installation is unavailable." });
  } finally { fetchMock.mockRestore(); }
});
