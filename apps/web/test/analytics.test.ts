import { describe, expect, it, vi } from "vitest";
import { AnalyticsScopeUnavailableError, ProviderConnectionUnavailableError } from "@triagepilot/db";
import { createWebApp } from "../src/app";
import { buildServices } from "./helpers";

async function setup(overrides: Parameters<typeof buildServices>[0] = {}) {
  const services = buildServices(overrides);
  const app = createWebApp(services);
  const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "correct-password" }) });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  return { app, headers: { cookie, "x-triagepilot-workspace": services.workspaceId } };
}
describe("analytics routes", () => {
  it.each(["", "/workload"])("protects endpoint %s", async suffix => {
    const { app, headers } = await setup();
    const path = `/api/operations/analytics${suffix}`;
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { ...headers, "x-triagepilot-workspace": "foreign" } })).status).toBe(403);
    expect((await app.request(path, { headers })).status).toBe(200);
  });
  it.each(["?averageReviewMinutes=NaN", "?mode=invalid", "?periodDays=7&periodDays=7", "/workload?periodDays=30", "/workload?mode=auto", "/workload?forceRefresh=yes"])("rejects malformed query %s", async suffix => {
    const { app, headers } = await setup();
    const response = await app.request(`/api/operations/analytics${suffix}`, { headers });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_query" });
  });
  it.each([new AnalyticsScopeUnavailableError("private repository"), new ProviderConnectionUnavailableError("private connection")])("returns uniform safe scope errors", async error => {
    const fail = async () => { throw error; };
    const { app, headers } = await setup({ readAnalytics: fail, readCurrentWorkload: fail });
    for (const path of ["", "/workload"]) {
      const response = await app.request(`/api/operations/analytics${path}?repositoryId=foreign`, { headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found_or_inactive" });
    }
  });
  it("does not return provider bodies", async () => {
    const { app, headers } = await setup({ readCurrentWorkload: async () => { throw new Error("secret provider body"); } });
    const response = await app.request("/api/operations/analytics/workload", { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "analytics_unavailable" });
  });
  it("parses independent history and workload requests", async () => {
    const base = buildServices();
    const history = vi.fn(base.readAnalytics), workload = vi.fn(base.readCurrentWorkload);
    const { app, headers } = await setup({ readAnalytics: history, readCurrentWorkload: workload });
    await app.request("/api/operations/analytics?repositoryId=a&repositoryId=a&mode=shadow&periodDays=90&averageReviewMinutes=15", { headers });
    expect(history).toHaveBeenCalledWith({ repositoryIds: ["a"], mode: "shadow", periodDays: 90, averageReviewMinutes: 15 });
    expect(workload).not.toHaveBeenCalled();
    await app.request("/api/operations/analytics/workload?forceRefresh=true&averageReviewMinutes=60", { headers });
    expect(workload).toHaveBeenCalledWith({ repositoryIds: [], averageReviewMinutes: 60, forceRefresh: true });
  });
});
