import { Hono } from "hono";
import { PullRequestQueueUnavailableError, type PullRequestQueueSnapshot } from "@triagepilot/contracts";
import { requireAdminSession, type AdminSessionServices } from "./auth.js";

export interface PullRequestQueueServices extends AdminSessionServices {
  readPullRequestQueue(input: { forceRefresh: boolean; phase?: "initial" | "details"; signal?: AbortSignal }): Promise<PullRequestQueueSnapshot>;
}
export function pullRequestQueueRoutes(services: PullRequestQueueServices) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("*", requireAdminSession(services), async (c, next) => {
    if (c.req.header("x-triagepilot-workspace") !== services.workspaceId) return c.json({ error: "workspace_scope_mismatch" }, 403);
    const origin = c.req.header("origin");
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "forbidden_origin" }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof PullRequestQueueUnavailableError && error.reason === "authority") return c.json({ error: "not_found_or_inactive" }, 404);
    return c.json({ error: "pull_request_queue_unavailable" }, 503);
  });
  app.get("/", async c => {
    const query = new URL(c.req.url).searchParams;
    const phase = query.get("phase");
    if ([...query.keys()].some(key => key !== "refresh" && key !== "phase") || query.getAll("refresh").length > 1 || query.getAll("phase").length > 1 || (query.has("refresh") && query.get("refresh") !== "true" && query.get("refresh") !== "false") || (phase !== null && phase !== "initial" && phase !== "details")) return c.json({ error: "invalid_query" }, 400);
    const snapshot = await services.readPullRequestQueue({ forceRefresh: query.get("refresh") === "true", ...(phase ? { phase } : {}), signal: c.req.raw.signal });
    return c.json(snapshot, snapshot.status === "unavailable" ? 503 : 200);
  });
  return app;
}
