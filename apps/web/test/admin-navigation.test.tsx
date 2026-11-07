// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Dashboard, App } from "../src/admin/App";
import type {
  OperationsApiClient,
  OperationsOverview,
  EffectiveConfigurationOverview,
} from "@triagepilot/ui";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.location.hash = "";
  vi.unstubAllGlobals();
});
const overview: OperationsOverview = {
  statuses: [],
  repositories: [
    {
      id: "one",
      repository: { label: "team/one", href: null },
      mode: "shadow",
      configState: "valid",
    },
    {
      id: "two",
      repository: { label: "team/two", href: null },
      mode: "enforce",
      configState: "invalid",
    },
  ],
  decisions: [],
  failures: { jobs: [], actions: [] },
  worker: { available: true, workerId: "worker", lastHeartbeatAt: null },
};
const config = (name: string): EffectiveConfigurationOverview => ({
  repository: { label: name, href: null },
  trustedPath: "config/routing.yml",
  trustedRevision: "rev",
  repositoryRevision: "rev",
  inheritanceMode: "replace",
  effectiveHash: "hash",
  values: [],
});
function client(): OperationsApiClient {
  return {
    readOperationsOverview: vi.fn().mockResolvedValue(overview),
    readEffectiveConfiguration: vi
      .fn()
      .mockImplementation(async (_w, r) => config(r.repository.label)),
    readAvailabilitySettings: async () => ({
      timezone: "UTC",
      updatedAt: "2026-11-01T00:00:00Z",
    }),
    listReviewerAbsences: async () => [],
    listReviewerReplacementHistory: async () => [],
    queueRoutingRecovery: vi.fn().mockResolvedValue({ jobId: "job" }),
  } as unknown as OperationsApiClient;
}
async function mount(api = client(), data = overview) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <Dashboard
        username="admin"
        overview={data}
        api={api}
        analyticsApi={{
          readAnalytics: async () => {
            throw new Error("history");
          },
          readCurrentWorkload: async () => {
            throw new Error("workload");
          },
        }}
        onLogout={async () => {}}
      />,
    ),
  );
  return api;
}
async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  )!;
}
it("renders all seven destinations exclusively and follows hash history changes", async () => {
  await mount();
  for (const [hash, title] of [
    ["overview", "Overview"],
    ["repositories", "Repositories"],
    ["decisions", "Routing decisions"],
    ["analytics", "Analytics"],
    ["reviewer-availability", "Reviewer availability"],
    ["effective-configuration", "Configuration"],
    ["system-health", "System health"],
  ]) {
    await navigate(`#${hash}`);
    expect(container.querySelector("main h1")?.textContent).toBe(title);
    expect(container.querySelectorAll("main h1")).toHaveLength(1);
    expect(
      container
        .querySelector("[aria-current='location']")
        ?.getAttribute("href"),
    ).toBe(`#${hash}`);
    expect(
      container.querySelector("main [hidden] .operations-dashboard"),
    ).toBeNull();
  }
  await navigate("#repositories");
  expect(container.querySelector("main h1")?.textContent).toBe("Repositories");
  await navigate("#configuration?repositoryId=two");
  expect(
    container.querySelector<HTMLSelectElement>(
      '[aria-label="Configuration repository"]',
    )?.value,
  ).toBe("two");
});
it("keeps configuration visible with no repositories", async () => {
  await mount(client(), { ...overview, repositories: [] });
  await navigate("#effective-configuration");
  expect(container.querySelector("main")?.textContent).toContain(
    "No repositories are connected",
  );
  expect(
    container.querySelector("a[href='#effective-configuration']"),
  ).not.toBeNull();
});
it("discards stale configuration responses when changing repository", async () => {
  let resolve!: (value: EffectiveConfigurationOverview) => void;
  const api = client();
  api.readEffectiveConfiguration = vi.fn((_w, r) =>
    r.id === "one"
      ? new Promise((yes) => {
          resolve = yes;
        })
      : Promise.resolve(config("team/two")),
  );
  await navigate("#effective-configuration?repositoryId=one");
  await mount(api);
  await navigate("#effective-configuration?repositoryId=two");
  expect(container.querySelector("main")?.textContent).toContain("team/two");
  await act(async () => resolve(config("STALE")));
  expect(container.querySelector("main")?.textContent).not.toContain("STALE");
  expect(container.querySelector("main")?.textContent).toContain(
    "config/routing.yml",
  );
});
it("updates sidebar health on refresh and reports a refresh failure without losing the page", async () => {
  const api = await mount();
  await navigate("#repositories");
  api.readOperationsOverview = vi
    .fn()
    .mockResolvedValue({
      ...overview,
      worker: { available: false, workerId: null, lastHeartbeatAt: null },
    });
  await act(async () => button("Refresh repositories").click());
  expect(container.querySelector(".worker-summary strong")?.textContent).toBe(
    "Worker unavailable",
  );
  api.readOperationsOverview = vi
    .fn()
    .mockRejectedValue(new Error("refresh failed"));
  await act(async () => button("Refresh repositories").click());
  expect(container.querySelector("main h1")?.textContent).toBe("Repositories");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "refresh failed",
  );
});
it("does not read configuration while loading the overview", async () => {
  const reads: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    reads.push(String(input));
    if (input === "/api/auth/session")
      return Response.json({
        authenticated: true,
        username: "admin",
        workspaceId: "ws",
      });
    if (input === "/api/operations/overview") return Response.json(overview);
    throw new Error("Configuration must remain independent");
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  expect(container.querySelector("main h1")?.textContent).toBe("Overview");
  expect(reads).toEqual(["/api/auth/session", "/api/operations/overview"]);
});
