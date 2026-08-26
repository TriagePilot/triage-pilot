// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvailabilityOverview, OperationsOverview } from "@triagepilot/db";

import { App, Dashboard } from "../src/admin/App";

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
  it("exposes exactly one uniquely named region for each scrollable table", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(<Dashboard username="admin" overview={emptyOverview} availability={emptyAvailability} onAvailabilityChange={() => {}} onLogout={async () => {}} />);
    });

    const regions = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[role="region"], section[aria-label], section[aria-labelledby]',
      ),
    ).filter((region) => region.querySelector("table"));
    const names = regions.map(accessibleName);

    expect(names).toEqual([
      "Absence history",
      "Connected repositories",
      "Recent routing decisions",
      "Permanent job failures",
      "Action failures",
    ]);
    expect(new Set(names).size).toBe(5);
    expect(regions.every((region) => region.getAttribute("role") === "region")).toBe(true);
    expect(regions.every((region) => region.tabIndex === 0)).toBe(true);
  });

  it("moves an expired overview session to login while retaining recovery for other errors", async () => {
    let overviewRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input === "/api/auth/session") {
        return Response.json({ authenticated: true, username: "admin" });
      }
      if (input === "/api/operations/overview") {
        overviewRequests += 1;
        if (overviewRequests === 1) {
          return Response.json({ error: "database unavailable" }, { status: 503 });
        }
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (input === "/api/operations/availability") {
        return Response.json({ timezone: "UTC", absences: [] });
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

    expect(container.textContent).toContain("Administrator sign in");
    expect(container.textContent).toContain("The administrator session has expired.");
    expect(container.textContent).not.toContain("The dashboard could not load");
    expect(container.textContent).not.toContain("Retry overview");
  });

  it("moves an expired availability session to login even when the overview request also fails", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input === "/api/auth/session") {
        return Response.json({ authenticated: true, username: "admin" });
      }
      if (input === "/api/operations/overview") {
        return Response.json({ error: "database unavailable" }, { status: 503 });
      }
      if (input === "/api/operations/availability") {
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

    expect(container.textContent).toContain("Administrator sign in");
    expect(container.textContent).toContain("The administrator session has expired.");
    expect(container.textContent).not.toContain("The dashboard could not load");
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
  organization: "acme",
  githubApp: { appId: "123", configured: true, installationId: "99" },
  repositories: [],
  decisions: [],
  failures: { jobs: [], actions: [] },
  worker: { available: true, workerId: "worker-1", lastHeartbeatAt: "2026-08-18T12:00:00.000Z" },
};

const emptyAvailability: AvailabilityOverview = { timezone: "UTC", absences: [] };
