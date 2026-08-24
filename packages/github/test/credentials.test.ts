import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadGitHubAppCredentials, loadGitHubCredentials } from "../src/credentials";

describe("loadGitHubCredentials", () => {
  it("loads mounted private-key and webhook-secret files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triagepilot-creds-"));
    const key = join(dir, "key.pem");
    const hook = join(dir, "webhook");
    await writeFile(key, "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n");
    await writeFile(hook, "hook-secret\n");

    await expect(
      loadGitHubCredentials({
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_FILE: key,
        GITHUB_WEBHOOK_SECRET_FILE: hook,
      }),
    ).resolves.toEqual({
      appId: "123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
      webhookSecret: "hook-secret",
    });
  });

  it("rejects direct and file values for the same secret", async () => {
    await expect(
      loadGitHubCredentials({
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY: "direct",
        GITHUB_PRIVATE_KEY_FILE: "/mounted/key",
        GITHUB_WEBHOOK_SECRET: "hook",
      }),
    ).rejects.toThrow("GITHUB_PRIVATE_KEY and GITHUB_PRIVATE_KEY_FILE cannot both be set");
  });
});

describe("loadGitHubAppCredentials", () => {
  it("loads only the App ID and private key without requiring a webhook secret", async () => {
    await expect(
      loadGitHubAppCredentials({
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
      }),
    ).resolves.toEqual({
      appId: "123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
    });
  });

  it("does not return the webhook secret when one exists in the source", async () => {
    const credentials = await loadGitHubAppCredentials({
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
      GITHUB_WEBHOOK_SECRET: "web-only-secret",
    });

    expect(credentials).not.toHaveProperty("webhookSecret");
  });
});
