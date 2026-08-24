import { Hono } from "hono";
import type { OperationsOverview } from "@triagepilot/db";

import { requireAdminSession, type AdminSessionServices } from "./auth";

export interface OperationsServices extends AdminSessionServices {
  listOperationsOverview(): Promise<OperationsOverview>;
}

export function operationsRoutes(services: OperationsServices) {
  const app = new Hono();

  app.get("/overview", requireAdminSession(services), async (c) =>
    c.json(await services.listOperationsOverview()),
  );

  return app;
}
