import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSelfHostedOperationsApi,
  fetchEffectiveConfigurationForWorkspace,
  fetchOperationsOverviewForWorkspace,
  getSession,
  login,
  logout,
} from "../src/admin/api";

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

  it("fetches the workspace-scoped overview and logs out with same-origin cookies", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === "/api/operations/overview") {
        return Response.json(emptyOverview);
      }
      return new Response(null, { status: 204 });
    });

    await expect(fetchOperationsOverviewForWorkspace(workspace)).resolves.toEqual(emptyOverview);
    await logout();

    expect(calls).toEqual([
      [
        "/api/operations/overview",
        {
          credentials: "same-origin",
          headers: { "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001" },
        },
      ],
      ["/api/auth/logout", { method: "POST", credentials: "same-origin" }],
    ]);
  });

  it("sends the active workspace context when fetching reusable operations data", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === "/api/operations/overview") return Response.json(emptyOverview);
      if (input === "/api/operations/effective-configuration?repositoryId=repo-1") {
        return Response.json({
          repository: repository.repository,
          trustedPath: null,
          trustedRevision: "self-hosted-probe",
          repositoryRevision: null,
          inheritanceMode: "defaults",
          effectiveHash: "a".repeat(64),
          values: [],
        });
      }
      throw new Error(`unexpected request to ${String(input)}`);
    });

    await fetchOperationsOverviewForWorkspace(workspace);
    await fetchEffectiveConfigurationForWorkspace(workspace, repository);

    expect(calls).toEqual([
      [
        "/api/operations/overview",
        {
          credentials: "same-origin",
          headers: { "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001" },
        },
      ],
      [
        "/api/operations/effective-configuration?repositoryId=repo-1",
        {
          credentials: "same-origin",
          headers: { "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001" },
        },
      ],
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

    await expect(fetchOperationsOverviewForWorkspace(workspace)).rejects.toMatchObject({
      name: "AdminApiError",
      status: 401,
      message: "The administrator session has expired.",
    });
  });

  it("implements workspace-scoped availability reads and mutations through the reusable client", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (String(input).endsWith("/timezone")) return Response.json({ timezone: "Europe/Bratislava", updatedAt: "2026-09-01T00:00:00.000Z" });
      if (String(input).endsWith("/replacements?absenceId=absence-1")) return Response.json([]);
      return Response.json(absence);
    });
    const client = createSelfHostedOperationsApi();
    await client.readAvailabilitySettings(workspace);
    await client.scheduleReviewerAbsence(workspace, {
      externalActorId: "@user-d82a5f", startLocal: "2026-09-01T08:00", endLocal: "2026-09-01T17:00",
    });
    await client.listReviewerReplacementHistory(workspace, "absence-1");

    expect(calls).toEqual([
      ["/api/operations/availability/timezone", {
        credentials: "same-origin",
        headers: { "x-triagepilot-workspace": workspace.id },
      }],
      ["/api/operations/availability/absences", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-triagepilot-workspace": workspace.id },
        body: JSON.stringify({ externalActorId: "@user-d82a5f", startLocal: "2026-09-01T08:00", endLocal: "2026-09-01T17:00" }),
      }],
      ["/api/operations/availability/replacements?absenceId=absence-1", {
        credentials: "same-origin",
        headers: { "x-triagepilot-workspace": workspace.id },
      }],
    ]);
  });

  it("surfaces exact availability validation and session-expiry messages", async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ issues: [{ message: "Choose the UTC offset for this ambiguous local time." }] }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 })));
    const client = createSelfHostedOperationsApi({ onUnauthorized });

    await expect(client.scheduleReviewerAbsence(workspace, {
      externalActorId: "@user-d82a5f", startLocal: "2026-10-25T02:30", endLocal: "2026-10-25T03:30",
    })).rejects.toMatchObject({ status: 422, message: "Choose the UTC offset for this ambiguous local time." });
    await expect(client.listReviewerAbsences(workspace)).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

const emptyOverview = {
  statuses: [
    { id: "workspace", label: "Organization", value: "acme" },
    { id: "connection", label: "GitHub App", value: "App 123", detail: "No active installation" },
  ],
  repositories: [],
  decisions: [],
  failures: { jobs: [], actions: [] },
  worker: { available: false, workerId: null, lastHeartbeatAt: null },
};

const workspace = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Self-hosted",
};

const repository = {
  id: "repo-1",
  repository: { label: "acme/api", href: "https://github.com/acme/api" },
};

const absence = {
  id: "absence-1", externalActorId: "@user-d82a5f", startAt: "2026-09-01T06:00:00.000Z",
  endAt: "2026-09-01T15:00:00.000Z", status: "upcoming", revision: 1, cancelledAt: null,
  createdAt: "2026-08-18T10:00:00.000Z", updatedAt: "2026-08-18T10:00:00.000Z",
};
