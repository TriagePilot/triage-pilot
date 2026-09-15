import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";

import { createWebApp, type StaticAsset } from "./app";
import { createSelfHostedWebComposition } from "./composition/self-hosted";
import { readWebRuntimeEnv } from "./runtime-env";

const env = await readWebRuntimeEnv(process.env);
const composition = await createSelfHostedWebComposition(env);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/public");

const app = createWebApp(
  composition.services,
  {
    async readAsset(assetPath) {
      return readPublicAsset(publicDir, assetPath);
    },
  },
);

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
console.log(`TriagePilot web listening at ${env.appBaseUrl}`);

async function readPublicAsset(publicRoot: string, assetPath: string): Promise<StaticAsset | null> {
  const resolved = path.resolve(publicRoot, assetPath);
  if (!resolved.startsWith(`${publicRoot}${path.sep}`) && resolved !== publicRoot) return null;

  try {
    const body = await fs.readFile(resolved);
    return { body, contentType: contentTypeFor(resolved) };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
