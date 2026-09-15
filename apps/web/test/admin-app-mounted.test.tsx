// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationsOverview } from "@triagepilot/db";

import { App, Dashboard } from "../src/admin/App";
import { createSelfHostedOperationsApi } from "../src/admin/api";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("mounted admin application", () => {
  it("keeps sidebar worker health in sync when recovery refreshes the ledger", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input === "/api/operations/routing-runs") return Response.json({ jobId: "job-2" });
      if (input === "/api/operations/overview") {
        return Response.json({
          ...emptyOverview,
          worker: { available: false, workerId: null, lastHeartbeatAt: null },
        });
      }
      if (input === "/api/operations/availability/timezone") {
        return Response.json({ timezone: "UTC", updatedAt: "2026-08-18T10:00:00.000Z" });
      }
      if (input === "/api/operations/availability/absences") return Response.json([]);
      if (input === "/api/operations/availability/replacements") return Response.json([]);
      throw new Error(`unexpected request to ${String(input)}`);
    });
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(
        <Dashboard username="admin" overview={emptyOverview} api={createSelfHostedOperationsApi()} onLogout={async () => {}} />,
      );
      await flushAsyncWork();
    });
    expect(container.querySelector(".worker-summary strong")?.textContent).toBe("Worker healthy");

    await act(async () => {
      buttonNamed(container, "Re-run routing")?.click();
      await flushAsyncWork();
    });
    expect(container.querySelector(".status-ledger")?.textContent).toContain("Worker unavailable");
    expect(container.querySelector(".worker-summary strong")?.textContent).toBe("Worker unavailable");
  });

  it("tracks the selected operations section in navigation and breadcrumb", async () => {
    const previousHash = window.location.hash;
    const container = document.createElement("div");
    document.body.append(container);
    try {
      window.location.hash = "#repositories";
      await act(async () => {
        root = createRoot(container);
        root.render(<Dashboard username="admin" overview={emptyOverview} onLogout={async () => {}} />);
      });

      const link = container.querySelector<HTMLAnchorElement>('a[href="#repositories"]');
      expect(link?.getAttribute("aria-current")).toBe("location");
      expect(container.querySelector(".app-topbar strong")?.textContent).toBe("Repositories");

      await act(async () => {
        window.location.hash = "#reviewer-availability";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(container.querySelector<HTMLAnchorElement>('a[href="#reviewer-availability"]')?.getAttribute("aria-current")).toBe("location");
      expect(link?.hasAttribute("aria-current")).toBe(false);
      expect(container.querySelector(".app-topbar strong")?.textContent).toBe("Reviewer availability");
    } finally {
      window.location.hash = previousHash;
    }
  });

  it("exposes exactly one uniquely named region for each scrollable table", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(<Dashboard username="admin" overview={emptyOverview} onLogout={async () => {}} />);
    });

    const regions = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[role="region"], section[aria-label], section[aria-labelledby]',
      ),
    ).filter((region) => region.querySelector("table"));
    const names = regions.map(accessibleName);

    expect(names).toEqual([
      "Connected repositories",
      "Recent routing decisions",
      "Permanent job failures",
      "Action failures",
      "Absence history",
    ]);
    expect(new Set(names).size).toBe(5);
    expect(regions.every((region) => region.getAttribute("role") === "region")).toBe(true);
    expect(regions.every((region) => region.tabIndex === 0)).toBe(true);
    expect(container.textContent).toContain("1 of 2 required · shortfall 1");
  });

  it("moves an expired overview session to login while retaining recovery for other errors", async () => {
    let overviewRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input === "/api/auth/session") {
        return Response.json({
          authenticated: true,
          username: "admin",
          workspaceId: "00000000-0000-4000-8000-000000000001",
        });
      }
      if (input === "/api/operations/overview") {
        overviewRequests += 1;
        if (overviewRequests === 1) {
          return Response.json({ error: "database unavailable" }, { status: 503 });
        }
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (input === "/api/auth/logout") return new Response(null, { status: 204 });
      throw new Error(`unexpected request to ${String(input)}`);
    });
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("The dashboard could not load");
    expect(buttonNamed(container, "Retry overview")).not.toBeNull();
    expect(buttonNamed(container, "Sign out")).not.toBeNull();

    await act(async () => {
      buttonNamed(container, "Retry overview")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Sign in to TriagePilot");
    expect(container.textContent).toContain("The administrator session has expired.");
    expect(container.textContent).not.toContain("The dashboard could not load");
    expect(container.textContent).not.toContain("Retry overview");
  });

  it("mounts effective configuration after an authenticated self-hosted session", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === "/api/auth/session") {
        return Response.json({
          authenticated: true,
          username: "admin",
          workspaceId: "00000000-0000-4000-8000-000000000001",
        });
      }
      if (input === "/api/operations/overview") return Response.json(emptyOverview);
      if (input === "/api/operations/effective-configuration?repositoryId=repo-1") {
        return Response.json({
          repository: { label: "acme/api", href: "https://github.com/acme/api" },
          trustedPath: ".triagepilot.yml",
          trustedRevision: "trusted-base-sha",
          repositoryRevision: "trusted-base-sha",
          inheritanceMode: "replace",
          effectiveHash: "a".repeat(64),
          values: [
            { path: "$.mode", label: "mode", value: "shadow", source: "repository" },
          ],
        });
      }
      if (input === "/api/operations/availability/timezone") {
        return Response.json({ timezone: "Europe/Bratislava", updatedAt: "2026-08-18T10:00:00.000Z" });
      }
      if (input === "/api/operations/availability/absences") return Response.json([]);
      if (input === "/api/operations/availability/replacements") return Response.json([]);
      throw new Error(`unexpected request to ${String(input)}`);
    });
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Operations ledger");
    expect(container.textContent).toContain("Effective configuration");
    expect(container.textContent).toContain("Trusted path");
    expect(container.textContent).toContain(".triagepilot.yml");
    expect(container.textContent).toContain("repository source");
    expect(container.textContent).toContain("Reviewer availability");
    expect(container.textContent).toContain("Europe/Bratislava");
    expect(container.textContent).not.toContain("Effective configuration is unavailable");
    expect(calls).toMatchObject([
      ["/api/auth/session", { credentials: "same-origin" }],
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
      [
        "/api/operations/availability/timezone",
        {
          credentials: "same-origin",
          headers: { "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001" },
        },
      ],
      [
        "/api/operations/availability/absences",
        {
          credentials: "same-origin",
          headers: { "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001" },
        },
      ],
      [
        "/api/operations/availability/replacements",
        {
          credentials: "same-origin",
          headers: { "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000001" },
        },
      ],
    ]);
  });

  it("moves a routing-recovery session expiry back to administrator sign in", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input === "/api/auth/session") {
        return Response.json({
          authenticated: true,
          username: "admin",
          workspaceId: "00000000-0000-4000-8000-000000000001",
        });
      }
      if (input === "/api/operations/overview") return Response.json(emptyOverview);
      if (input === "/api/operations/effective-configuration?repositoryId=repo-1") {
        return Response.json({
          repository: { label: "acme/api", href: "https://github.com/acme/api" },
          trustedPath: null,
          trustedRevision: "self-hosted-probe",
          repositoryRevision: null,
          inheritanceMode: "defaults",
          effectiveHash: "a".repeat(64),
          values: [],
        });
      }
      if (input === "/api/operations/availability/timezone") {
        return Response.json({ timezone: "UTC", updatedAt: "2026-08-18T10:00:00.000Z" });
      }
      if (input === "/api/operations/availability/absences") return Response.json([]);
      if (input === "/api/operations/availability/replacements") return Response.json([]);
      if (input === "/api/operations/routing-runs") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      throw new Error(`unexpected request to ${String(input)}`);
    });
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
      await flushAsyncWork();
    });
    await act(async () => {
      buttonNamed(container, "Re-run routing")?.click();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Sign in to TriagePilot");
    expect(container.textContent).toContain("The administrator session has expired.");
    expect(container.textContent).not.toContain("Operations ledger");
  });
});

function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
  }
  return element.getAttribute("aria-label")?.trim() ?? "";
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

const emptyOverview: OperationsOverview = {
  statuses: [
    { id: "workspace", label: "Organization", value: "acme" },
    { id: "connection", label: "GitHub App", value: "App 123", detail: "Installation 99" },
  ],
  repositories: [
    {
      id: "repo-1",
      repository: { label: "acme/api", href: "https://github.com/acme/api" },
      configState: "valid",
      mode: "shadow",
    },
  ],
  decisions: [
    {
      id: "decision-1",
      repository: { label: "acme/api", href: "https://github.com/acme/api" },
      changeRequest: { label: "#7", href: "https://github.com/acme/api/pull/7" },
      mode: "shadow",
      action: "request_human_review",
      actionStatus: "not_applied",
      actionError: null,
      policyCheckState: "not_started",
      riskScore: 55,
      riskBreakdown: null,
      selectedReviewer: "@user-b4e82d",
      selectedReviewers: ["@user-b4e82d"],
      requestedReviewerCount: 2,
      reviewerShortfall: 1,
      createdAt: "2026-08-18T12:00:00.000Z",
    },
  ],
  failures: { jobs: [], actions: [] },
  worker: { available: true, workerId: "worker-1", lastHeartbeatAt: "2026-08-18T12:00:00.000Z" },
};
