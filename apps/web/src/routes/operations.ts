import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { OperationsOverview } from "@triagepilot/db";
import type { EffectiveConfigurationOverview } from "@triagepilot/ui";

import { requireAdminSession, type AdminSessionServices } from "./auth";

export interface OperationsServices extends AdminSessionServices {
  listOperationsOverview(): Promise<OperationsOverview>;
  readEffectiveConfiguration(): Promise<EffectiveConfigurationOverview>;
}

export function operationsRoutes(services: OperationsServices) {
  const app = new Hono();

  app.get("/overview", requireAdminSession(services), requireBoundWorkspace(services), async (c) =>
    c.json(await services.listOperationsOverview()),
  );
  app.get("/effective-configuration", requireAdminSession(services), requireBoundWorkspace(services), async (c) =>
    c.json(await services.readEffectiveConfiguration()),
  );

  return app;
}

function requireBoundWorkspace(services: OperationsServices): MiddlewareHandler {
  return async (c: Context, next) => {
    if (c.req.header("x-triagepilot-workspace") !== services.workspaceId) {
      return c.json({ error: "workspace_scope_mismatch" }, 403);
    }
    await next();
  };
}
