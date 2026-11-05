import { Hono } from "hono";
import type { AnalyticsQuery, AnalyticsReport, CurrentWorkloadReport } from "@triagepilot/contracts";
import { AnalyticsScopeUnavailableError, ProviderConnectionUnavailableError } from "@triagepilot/db";
import { GitHubBacklogError } from "@triagepilot/provider-github";
import { requireAdminSession, type AdminSessionServices } from "./auth.js";
import { AnalyticsQueryError, parseAnalyticsQuery, parseWorkloadQuery, type CurrentWorkloadQuery } from "../analytics-input.js";

export interface AnalyticsServices extends AdminSessionServices {
  readAnalytics(query: AnalyticsQuery): Promise<AnalyticsReport>;
  readCurrentWorkload(query: CurrentWorkloadQuery): Promise<CurrentWorkloadReport>;
}
export function analyticsRoutes(services: AnalyticsServices) {
  const app = new Hono();
  app.use("*", requireAdminSession(services), async (c, next) => {
    if (c.req.header("x-triagepilot-workspace") !== services.workspaceId) return c.json({ error: "workspace_scope_mismatch" }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof AnalyticsQueryError) return c.json({ error: "invalid_query" }, 400);
    if (error instanceof AnalyticsScopeUnavailableError || error instanceof ProviderConnectionUnavailableError
      || (error instanceof GitHubBacklogError && (error.reason === "forbidden" || error.reason === "not_found"))) {
      return c.json({ error: "not_found_or_inactive" }, 404);
    }
    return c.json({ error: "analytics_unavailable" }, 503);
  });
  app.get("/", async c => c.json(await services.readAnalytics(parseAnalyticsQuery(new URL(c.req.url).searchParams))));
  app.get("/workload", async c => c.json(await services.readCurrentWorkload(parseWorkloadQuery(new URL(c.req.url).searchParams))));
  return app;
}
