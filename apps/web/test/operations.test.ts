import { describe, expect, it } from "vitest";

import { createWebApp } from "../src/app";
import { buildServices } from "./helpers";

const overview = {
  organization: "acme",
  githubApp: { appId: "123", configured: true, installationId: "99" },
  repositories: [
    {
      id: "repo-1",
      owner: "acme",
      name: "api",
      configState: "valid",
      mode: "shadow" as const,
    },
  ],
  decisions: [
    {
      id: "decision-1",
      repository: "acme/api",
      pullNumber: 7,
      headSha: "head-1",
      runCount: 1,
      mode: "shadow" as const,
      action: "request_human_review" as const,
      actionStatus: "not_applied" as const,
      actionError: null,
      policyCheckState: "in_progress" as const,
      riskScore: 55,
      riskBreakdown: null,
      selectedReviewer: "@team-a7f19c/reviewers",
      selectedReviewers: ["@team-a7f19c/reviewers", "@user-b4e82d"],
      createdAt: "2026-08-18T10:00:00.000Z",
    },
  ],
  failures: {
    jobs: [
      {
        id: "job-1",
        error: "GitHub permission denied",
        failedAt: "2026-08-18T10:01:00.000Z",
      },
    ],
    actions: [],
  },
  worker: {
    available: true,
    workerId: "worker-1",
    lastHeartbeatAt: "2026-08-18T10:02:00.000Z",
  },
};

describe("operations routes", () => {
  it("requires an administrator session for the operational overview", async () => {
    const app = createWebApp(buildServices());

    const response = await app.request("/api/operations/overview");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("returns the operational overview to an authenticated administrator", async () => {
    const { app, cookie } = await authenticatedApp({
      listOperationsOverview: async () => overview,
    });

    const response = await app.request("/api/operations/overview", {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(overview);
  });

  it("queues a routing run for an authenticated administrator", async () => {
    const requests: unknown[] = [];
    const { app, cookie } = await authenticatedApp({
      rerunRouting: async (request) => {
        requests.push(request);
        return { jobId: "job-recovery-1" };
      },
    });

    const response = await app.request("/api/operations/routing-runs", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ decisionId: "decision-1" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: "job-recovery-1", status: "queued" });
    expect(requests).toEqual([{ decisionId: "decision-1" }]);
  });

  it.each([
    {},
    { decisionId: "decision-1", pullRequestUrl: "https://github.com/acme/api/pull/7" },
    { pullRequestUrl: "not a URL" },
    { pullRequestUrl: "https://github.com/acme/api/pull/999999999999999999999999" },
  ])("rejects an invalid routing run request %#", async (body) => {
    const { app, cookie } = await authenticatedApp({});

    const response = await app.request("/api/operations/routing-runs", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "validation_failed" });
  });

  it("requires an administrator session to queue a routing run", async () => {
    const response = await createWebApp(buildServices()).request("/api/operations/routing-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decisionId: "decision-1" }),
    });

    expect(response.status).toBe(401);
  });

  it.each(["/api/setup/status", "/api/setup/github-app", "/api/operations/recent"])(
    "does not expose the removed route %s",
    async (path) => {
      const app = createWebApp(buildServices());

      const response = await app.request(path);

      expect(response.status).toBe(404);
    },
  );
});

async function authenticatedApp(overrides: Parameters<typeof buildServices>[0]) {
  const app = createWebApp(buildServices(overrides));
  const loginResponse = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "correct-password" }),
  });
  return {
    app,
    cookie: (loginResponse.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "",
  };
}
