import { readFile } from "node:fs/promises";
import { loadGitHubCredentials, type GitHubAppCredentialShape } from "@triagepilot/github";
import { z } from "zod";

const runtimeEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().trim().min(1),
  ADMIN_USERNAME: z.string().trim().min(1),
  GITHUB_ORGANIZATION: z.string().trim().min(1),
});

export interface WebRuntimeEnv {
  nodeEnv: "development" | "test" | "production";
  appBaseUrl: string;
  databaseUrl: string;
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  githubOrganization: string;
  github: GitHubAppCredentialShape;
  secureCookies: boolean;
}

async function readSecret(source: NodeJS.ProcessEnv, directName: string, fileName: string): Promise<string> {
  const direct = source[directName]?.trim();
  const file = source[fileName]?.trim();

  if (direct && file) {
    throw new Error(`${directName} and ${fileName} cannot both be set`);
  }

  const value = file ? (await readFile(file, "utf8")).trim() : direct;
  if (!value) {
    throw new Error(`${directName} or ${fileName} is required`);
  }

  return value;
}

function rejectProductionPlaceholder(name: string, value: string): void {
  if (value.startsWith("replace-with-")) {
    throw new Error(`${name} cannot use a replace-with- value in production`);
  }
}

export async function readWebRuntimeEnv(source: NodeJS.ProcessEnv): Promise<WebRuntimeEnv> {
  const parsed = runtimeEnvSchema.parse(source);
  const [adminPassword, sessionSecret, github] = await Promise.all([
    readSecret(source, "ADMIN_PASSWORD", "ADMIN_PASSWORD_FILE"),
    readSecret(source, "SESSION_SECRET", "SESSION_SECRET_FILE"),
    loadGitHubCredentials(source),
  ]);

  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }

  if (parsed.NODE_ENV === "production") {
    for (const [name, value] of Object.entries({
      APP_BASE_URL: parsed.APP_BASE_URL,
      DATABASE_URL: parsed.DATABASE_URL,
      ADMIN_USERNAME: parsed.ADMIN_USERNAME,
      ADMIN_PASSWORD: adminPassword,
      SESSION_SECRET: sessionSecret,
      GITHUB_ORGANIZATION: parsed.GITHUB_ORGANIZATION,
      GITHUB_APP_ID: github.appId,
      GITHUB_PRIVATE_KEY: github.privateKey,
      GITHUB_WEBHOOK_SECRET: github.webhookSecret,
    })) {
      rejectProductionPlaceholder(name, value);
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    appBaseUrl: parsed.APP_BASE_URL,
    databaseUrl: parsed.DATABASE_URL,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword,
    sessionSecret,
    githubOrganization: parsed.GITHUB_ORGANIZATION,
    github,
    secureCookies: new URL(parsed.APP_BASE_URL).protocol === "https:",
  };
}
