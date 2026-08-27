import { Hono } from "hono";
import type { OperationsOverview } from "@triagepilot/db";
import type { EffectiveConfigurationOverview } from "@triagepilot/ui";

import { requireAdminSession, type AdminSessionServices } from "./auth";

export interface OperationsServices extends AdminSessionServices {
  listOperationsOverview(): Promise<OperationsOverview>;
  readEffectiveConfiguration(): Promise<EffectiveConfigurationOverview>;
}

export function operationsRoutes(services: OperationsServices) {
  const app = new Hono();

  app.get("/overview", requireAdminSession(services), async (c) =>
    c.json(await services.listOperationsOverview()),
  );
  app.get("/effective-configuration", requireAdminSession(services), async (c) =>
    c.json(await services.readEffectiveConfiguration()),
  );

  return app;
}
