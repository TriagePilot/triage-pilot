import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createDatabase } from "@triagepilot/db";
import { verifyGitHubSignature } from "@triagepilot/github";

import { createWebApp, type StaticAsset } from "./app";
import { readWebRuntimeEnv } from "./runtime-env";
import { createWebRuntimeServices } from "./runtime-services";

const env = await readWebRuntimeEnv(process.env);
const db = createDatabase(env.databaseUrl);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/public");

const app = createWebApp(
  createWebRuntimeServices({
    db,
    adminUsername: env.adminUsername,
    adminPassword: env.adminPassword,
    sessionSecret: env.sessionSecret,
    secureCookies: env.secureCookies,
    now: () => new Date(),
    sourceAddress: (c) => getConnInfo(c).remote.address ?? "unknown",
    githubOrganization: env.githubOrganization,
    github: env.github,
    verifySignature: verifyGitHubSignature,
  }),
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
    const body = await fs.readFile(resolved, "utf8");
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
  return "application/octet-stream";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
