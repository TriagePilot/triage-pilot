import { describe, expect, it } from "vitest";

import { readWebRuntimeEnv } from "../src/runtime-env";

describe("web env scope", () => {
  it("ignores unsupported OAuth and allowlist configuration", async () => {
    const env = await readWebRuntimeEnv({
      NODE_ENV: "development",
      APP_BASE_URL: "http://localhost:8787",
      DATABASE_URL: "postgres://triagepilot:triagepilot@postgres:5432/triagepilot",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "correct-password",
      SESSION_SECRET: "s".repeat(32),
      GITHUB_ORGANIZATION: "acme",
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
      GITHUB_WEBHOOK_SECRET: "hook-secret",
      GITHUB_OAUTH_CLIENT_ID: "unused",
      ADMIN_ALLOWED_GITHUB_USERS: "unused",
    });

    expect(env).not.toHaveProperty("githubOAuthClientId");
    expect(env).not.toHaveProperty("adminAllowedGithubUsers");
  });
});
