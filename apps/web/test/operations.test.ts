import { describe, expect, it } from "vitest";
import {
  RoutingRecoveryClosedError,
  RoutingRecoveryTargetUnavailableError,
  RoutingRecoveryValidationError,
} from "@triagepilot/application";

import { createWebApp } from "../src/app";
import { buildServices } from "./helpers";

const overview = {
  statuses: [
    { id: "workspace", label: "Organization", value: "acme" },
    { id: "connection", label: "GitHub App", value: "App 123", detail: "Installation 99" },
  ],
  repositories: [
    {
      id: "repo-1",
      repository: { label: "acme/api", href: "https://github.com/acme/api" },
      configState: "valid",
      mode: "shadow" as const,
    },
  ],
  decisions: [
    {
      id: "decision-1",
      repository: { label: "acme/api", href: "https://github.com/acme/api" },
      changeRequest: { label: "#7", href: "https://github.com/acme/api/pull/7" },
      mode: "shadow" as const,
      action: "request_human_review" as const,
      actionStatus: "not_applied" as const,
      actionError: null,
      policyCheckState: "in_progress" as const,
      riskScore: 55,
      riskBreakdown: null,
      requestedReviewerCount: 2,
      reviewerShortfall: 0,
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

  it("requires an administrator session for effective configuration", async () => {
    const app = createWebApp(buildServices());

    const response = await app.request("/api/operations/effective-configuration");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects an authenticated overview request without a workspace header", async () => {
    const { app, cookie } = await authenticatedApp();

    const response = await app.request("/api/operations/overview", {
      headers: { cookie },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "workspace_scope_mismatch" });
  });

  it("rejects an authenticated overview request for a mismatched workspace", async () => {
    const { app, cookie } = await authenticatedApp();

    const response = await app.request("/api/operations/overview", {
      headers: { cookie, "x-triagepilot-workspace": "ws_other" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "workspace_scope_mismatch" });
  });

  it("returns the operational overview to an authenticated administrator in the bound workspace", async () => {
    const { app, cookie } = await authenticatedApp({
      listOperationsOverview: async () => overview,
    });

    const response = await app.request("/api/operations/overview", {
      headers: { cookie, "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(overview);
  });

  it("requires an administrator session and the bound workspace to queue routing recovery", async () => {
    const unauthenticated = await createWebApp(buildServices()).request("/api/operations/routing-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decisionId: "00000000-0000-4000-8000-000000000010" }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ error: "unauthorized" });

    const { app, cookie } = await authenticatedApp();
    const unscoped = await app.request("/api/operations/routing-runs", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ decisionId: "00000000-0000-4000-8000-000000000010" }),
    });
    expect(unscoped.status).toBe(403);
    expect(await unscoped.json()).toEqual({ error: "workspace_scope_mismatch" });
  });

  it.each([
    null,
    {},
    { decisionId: "" },
    { changeRequestUrl: "" },
    {
      decisionId: "00000000-0000-4000-8000-000000000010",
      changeRequestUrl: "https://github.com/acme/api/pull/7",
    },
    { decisionId: "00000000-0000-4000-8000-000000000010", extra: true },
  ])("requires exactly one non-empty routing recovery target %#", async (body) => {
    const { app, cookie } = await authenticatedApp();
    const response = await app.request("/api/operations/routing-runs", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_target",
      message: "Exactly one routing recovery target is required",
    });
  });

  it.each([
    { decisionId: "00000000-0000-4000-8000-000000000010" },
    { changeRequestUrl: "https://github.com/acme/api/pull/7" },
  ])("queues one authenticated routing recovery target %#", async (request) => {
    const received: unknown[] = [];
    const { app, cookie } = await authenticatedApp({
      queueRoutingRecovery: async (input) => {
        received.push(input);
        return { jobId: "job-recovery-1" };
      },
    });
    const response = await app.request("/api/operations/routing-runs", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "queued", jobId: "job-recovery-1" });
    expect(received).toEqual([request]);
  });

  it.each([
    [new RoutingRecoveryValidationError("Enter a valid GitHub pull request URL"), 422, "invalid_target"],
    [new RoutingRecoveryTargetUnavailableError("Routing recovery target is unavailable in this workspace"), 404, "not_found_or_inactive"],
    [new RoutingRecoveryClosedError("Only an open change request can be routed again"), 409, "change_request_closed"],
  ] as const)("maps routing recovery application errors without disclosing target state", async (error, status, code) => {
    const { app, cookie } = await authenticatedApp({
      queueRoutingRecovery: async () => { throw error; },
    });
    const response = await app.request("/api/operations/routing-runs", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({ changeRequestUrl: "not-a-provider-url" }),
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code, message: error.message });
  });

  it("rejects a routing recovery request after the administrator session expires", async () => {
    let now = new Date("2026-08-18T10:00:00.000Z");
    const app = createWebApp(buildServices({ now: () => now }));
    const loginResponse = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-password" }),
    });
    const cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    now = new Date(now.getTime() + 43_200_001);

    const response = await app.request("/api/operations/routing-runs", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({ decisionId: "00000000-0000-4000-8000-000000000010" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects an authenticated effective-configuration request without a workspace header", async () => {
    const { app, cookie } = await authenticatedApp();

    const response = await app.request("/api/operations/effective-configuration", {
      headers: { cookie },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "workspace_scope_mismatch" });
  });

  it("rejects an authenticated effective-configuration request for a mismatched workspace", async () => {
    const { app, cookie } = await authenticatedApp();

    const response = await app.request("/api/operations/effective-configuration", {
      headers: { cookie, "x-triagepilot-workspace": "ws_other" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "workspace_scope_mismatch" });
  });

  it("returns effective configuration provenance to an authenticated administrator in the bound workspace", async () => {
    const { app, cookie } = await authenticatedApp({
      readEffectiveConfiguration: async () => effectiveConfiguration,
    });

    const response = await app.request("/api/operations/effective-configuration?repositoryId=repo-1", {
      headers: { cookie, "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(effectiveConfiguration);
  });

  it("requires effective-configuration queries to name a repository", async () => {
    const { app, cookie } = await authenticatedApp();

    const response = await app.request("/api/operations/effective-configuration", {
      headers: { cookie, "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "repository_required" });
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

const effectiveConfiguration = {
  repository: { label: "acme/api", href: "https://github.com/acme/api" },
  trustedPath: ".triagepilot.yml",
  trustedRevision: "trusted-base-sha",
  repositoryRevision: "trusted-base-sha",
  inheritanceMode: "replace" as const,
  effectiveHash: "a".repeat(64),
  values: [
    { path: "$.mode", label: "mode", value: "shadow", source: "repository" as const },
  ],
};

async function authenticatedApp(overrides: Parameters<typeof buildServices>[0] = {}) {
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
