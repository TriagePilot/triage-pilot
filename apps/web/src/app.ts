import { Hono } from "hono";
import { formatLog } from "@triagepilot/shared";

import { authRoutes, type AuthServices } from "./routes/auth";
import { operationsRoutes, type OperationsServices } from "./routes/operations";
import { githubWebhookRoutes, type WebhookServices } from "./routes/webhooks";

export type WebServices = WebhookServices & AuthServices & OperationsServices & {
  checkDatabase(): Promise<void>;
};

export interface StaticAsset {
  body: string;
  contentType: string;
}

export interface StaticAssetReader {
  readAsset(path: string): Promise<StaticAsset | null>;
}

export function createWebApp(services: WebServices, staticAssets?: StaticAssetReader) {
  const app = new Hono();
  app.get("/", async (c) => {
    const asset = await staticAssets?.readAsset("index.html");
    if (!asset) return c.notFound();
    return new Response(asset.body, { headers: { "content-type": asset.contentType } });
  });
  app.get("/assets/*", async (c) => {
    const assetPath = c.req.path.replace(/^\/+/, "");
    const asset = await staticAssets?.readAsset(assetPath);
    if (!asset) return c.notFound();
    return new Response(asset.body, { headers: { "content-type": asset.contentType } });
  });
  app.get("/health", async (c) => {
    try {
      await services.checkDatabase();
      return c.json({ ok: true, service: "triagepilot-web" });
    } catch {
      console.error(formatLog({ level: "error", event: "health_database_failed", service: "web" }));
      return c.json({ ok: false, service: "triagepilot-web" }, 503);
    }
  });
  app.route("/api/auth", authRoutes(services));
  app.route("/api/operations", operationsRoutes(services));
  app.route("/webhooks", githubWebhookRoutes(services));
  return app;
}
