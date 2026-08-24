import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readWebRuntimeEnv } from "../src/runtime-env";

const productionEnv = {
  NODE_ENV: "production",
  APP_BASE_URL: "https://triage.example.com",
  DATABASE_URL: "postgres://example",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "correct horse battery staple",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  GITHUB_ORGANIZATION: "acme",
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "hook-secret",
};

describe("readWebRuntimeEnv", () => {
  it("parses the complete production environment", async () => {
    await expect(readWebRuntimeEnv(productionEnv)).resolves.toMatchObject({
      appBaseUrl: "https://triage.example.com",
      githubOrganization: "acme",
      adminUsername: "admin",
      secureCookies: true,
    });
  });

  it.each([
    ["ADMIN_PASSWORD", "replace-with-admin-password"],
    ["SESSION_SECRET", "replace-with-session-secret-at-least-32-characters"],
    ["GITHUB_WEBHOOK_SECRET", "replace-with-github-webhook-secret"],
  ] as const)("rejects the documented production sentinel for %s", async (name, value) => {
    await expect(readWebRuntimeEnv({ ...productionEnv, [name]: value })).rejects.toThrow(name);
  });

  it.each(["DATABASE_URL", "ADMIN_USERNAME", "GITHUB_ORGANIZATION"] as const)(
    "rejects whitespace-only %s",
    async (name) => {
      await expect(readWebRuntimeEnv({ ...productionEnv, [name]: " \t " })).rejects.toThrow();
    },
  );

  it("loads administrator secrets from mounted files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triagepilot-web-env-"));
    const password = join(dir, "admin-password");
    const session = join(dir, "session-secret");
    await writeFile(password, "correct horse battery staple\n");
    await writeFile(session, "0123456789abcdef0123456789abcdef\n");

    await expect(
      readWebRuntimeEnv({
        ...productionEnv,
        ADMIN_PASSWORD: undefined,
        ADMIN_PASSWORD_FILE: password,
        SESSION_SECRET: undefined,
        SESSION_SECRET_FILE: session,
      }),
    ).resolves.toMatchObject({
      adminPassword: "correct horse battery staple",
      sessionSecret: "0123456789abcdef0123456789abcdef",
    });
  });

  it("rejects direct and file administrator passwords together", async () => {
    await expect(
      readWebRuntimeEnv({
        ...productionEnv,
        ADMIN_PASSWORD_FILE: "/mounted/admin-password",
      }),
    ).rejects.toThrow("ADMIN_PASSWORD and ADMIN_PASSWORD_FILE cannot both be set");
  });
});
