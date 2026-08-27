import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchOperationsOverview, getSession, login, logout, rerunRouting } from "../src/admin/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin API", () => {
  it("logs in with same-origin cookies and clears no credentials into the URL", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(null, { status: 204 });
    });

    await login("admin", "correct-password");

    expect(calls).toEqual([
      [
        "/api/auth/login",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "admin", password: "correct-password" }),
        },
      ],
    ]);
  });

  it("treats an unauthorized session check as signed out", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(getSession()).resolves.toEqual({ authenticated: false });
  });

  it("fetches the overview and logs out with same-origin cookies", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === "/api/operations/overview") {
        return Response.json(emptyOverview);
      }
      return new Response(null, { status: 204 });
    });

    await expect(fetchOperationsOverview()).resolves.toEqual(emptyOverview);
    await logout();

    expect(calls).toEqual([
      ["/api/operations/overview", { credentials: "same-origin" }],
      ["/api/auth/logout", { method: "POST", credentials: "same-origin" }],
    ]);
  });

  it("preserves an expired overview session as an HTTP 401 error", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(fetchOperationsOverview()).rejects.toMatchObject({
      name: "AdminApiError",
      status: 401,
      message: "The administrator session has expired.",
    });
  });

  it("queues a routing run with same-origin credentials", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return Response.json({ status: "queued", jobId: "job-recovery-1" }, { status: 202 });
    });

    await expect(rerunRouting({ pullRequestUrl: "https://github.com/acme/api/pull/7" })).resolves.toEqual({
      status: "queued",
      jobId: "job-recovery-1",
    });
    expect(calls).toEqual([["/api/operations/routing-runs", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pullRequestUrl: "https://github.com/acme/api/pull/7" }),
    }]]);
  });
});

const emptyOverview = {
  organization: "acme",
  githubApp: { appId: "123", configured: true, installationId: null },
  repositories: [],
  decisions: [],
  failures: { jobs: [], actions: [] },
  worker: { available: false, workerId: null, lastHeartbeatAt: null },
};
