import { Hono } from "hono";
import type { OperationsOverview } from "@triagepilot/db";

import { requireAdminSession, type AdminSessionServices } from "./auth";
import { parsePullRequestUrl, RoutingRunError, type RoutingRunRequest } from "../routing-run";

export interface OperationsServices extends AdminSessionServices {
  listOperationsOverview(): Promise<OperationsOverview>;
  rerunRouting(request: RoutingRunRequest): Promise<{ jobId: string }>;
}

export function operationsRoutes(services: OperationsServices) {
  const app = new Hono();

  app.get("/overview", requireAdminSession(services), async (c) =>
    c.json(await services.listOperationsOverview()),
  );

  app.post("/routing-runs", requireAdminSession(services), async (c) => {
    const request = parseRoutingRunRequest(await c.req.json().catch(() => null));
    if (!request) {
      return c.json({ error: "validation_failed", message: "Provide one decision ID or GitHub pull request URL." }, 422);
    }
    try {
      const result = await services.rerunRouting(request);
      return c.json({ status: "queued", jobId: result.jobId }, 202);
    } catch (error) {
      if (error instanceof RoutingRunError) {
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      throw error;
    }
  });

  return app;
}

function parseRoutingRunRequest(value: unknown): RoutingRunRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const decisionId = typeof input.decisionId === "string" ? input.decisionId.trim() : "";
  const pullRequestUrl = typeof input.pullRequestUrl === "string" ? input.pullRequestUrl.trim() : "";
  if (decisionId && !pullRequestUrl) return { decisionId };
  if (!decisionId && pullRequestUrl && isGitHubPullRequestUrl(pullRequestUrl)) return { pullRequestUrl };
  return null;
}

function isGitHubPullRequestUrl(value: string): boolean {
  return parsePullRequestUrl(value) !== null;
}
