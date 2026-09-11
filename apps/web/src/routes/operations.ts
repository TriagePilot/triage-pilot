import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { EffectiveConfigurationOverview, OperationsOverview } from "@triagepilot/ui";
import {
  RoutingRecoveryClosedError,
  RoutingRecoveryTargetUnavailableError,
  RoutingRecoveryValidationError,
} from "@triagepilot/application";

import { requireAdminSession, type AdminSessionServices } from "./auth";

export interface OperationsServices extends AdminSessionServices {
  listOperationsOverview(): Promise<OperationsOverview>;
  readEffectiveConfiguration(repositoryId: string): Promise<EffectiveConfigurationOverview>;
  queueRoutingRecovery(
    request: { decisionId: string } | { changeRequestUrl: string },
  ): Promise<{ jobId: string }>;
}

export function operationsRoutes(services: OperationsServices) {
  const app = new Hono();

  app.get("/overview", requireAdminSession(services), requireBoundWorkspace(services), async (c) =>
    c.json(await services.listOperationsOverview()),
  );
  app.get("/effective-configuration", requireAdminSession(services), requireBoundWorkspace(services), async (c) => {
    const repositoryId = c.req.query("repositoryId")?.trim();
    if (!repositoryId) return c.json({ error: "repository_required" }, 400);
    return c.json(await services.readEffectiveConfiguration(repositoryId));
  });
  app.post("/routing-runs", requireAdminSession(services), requireBoundWorkspace(services), async (c) => {
    const request = parseRoutingRecoveryRequest(await c.req.json().catch(() => null));
    if (request === null) {
      return c.json({
        error: "invalid_target",
        message: "Exactly one routing recovery target is required",
      }, 422);
    }
    try {
      const queued = await services.queueRoutingRecovery(request);
      return c.json({ status: "queued", jobId: queued.jobId }, 202);
    } catch (caught) {
      if (caught instanceof RoutingRecoveryValidationError) {
        return c.json({ error: caught.code, message: caught.message }, 422);
      }
      if (caught instanceof RoutingRecoveryTargetUnavailableError) {
        return c.json({ error: caught.code, message: caught.message }, 404);
      }
      if (caught instanceof RoutingRecoveryClosedError) {
        return c.json({ error: caught.code, message: caught.message }, 409);
      }
      throw caught;
    }
  });

  return app;
}

function parseRoutingRecoveryRequest(
  value: unknown,
): { decisionId: string } | { changeRequestUrl: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== 1) return null;
  if (keys[0] === "decisionId" && typeof input.decisionId === "string" && input.decisionId.trim()) {
    return { decisionId: input.decisionId.trim() };
  }
  if (keys[0] === "changeRequestUrl" && typeof input.changeRequestUrl === "string" && input.changeRequestUrl.trim()) {
    return { changeRequestUrl: input.changeRequestUrl.trim() };
  }
  return null;
}

function requireBoundWorkspace(services: OperationsServices): MiddlewareHandler {
  return async (c: Context, next) => {
    if (c.req.header("x-triagepilot-workspace") !== services.workspaceId) {
      return c.json({ error: "workspace_scope_mismatch" }, 403);
    }
    await next();
  };
}
