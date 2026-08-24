import { describe, expect, it } from "vitest";

import { readWorkerEnv } from "../src/env";

const workerEnv = {
  DATABASE_URL: "postgres://example",
  GITHUB_ORGANIZATION: "acme",
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
};

describe("readWorkerEnv", () => {
  it.each(["DATABASE_URL", "GITHUB_ORGANIZATION", "GITHUB_APP_ID", "GITHUB_PRIVATE_KEY"] as const)(
    "rejects a missing %s",
    async (name) => {
      await expect(readWorkerEnv({ ...workerEnv, [name]: undefined })).rejects.toThrow();
    },
  );

  it("defaults the poll interval and derives the worker ID", async () => {
    await expect(readWorkerEnv(workerEnv, 42)).resolves.toEqual({
      databaseUrl: "postgres://example",
      githubOrganization: "acme",
      github: {
        appId: "123",
        privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
      },
      pollMs: 2000,
      workerId: "worker-42",
    });
  });

  it("accepts only positive numeric polling intervals", async () => {
    await expect(readWorkerEnv({ ...workerEnv, WORKER_POLL_MS: "0" })).rejects.toThrow("WORKER_POLL_MS");
    await expect(readWorkerEnv({ ...workerEnv, WORKER_POLL_MS: "" })).rejects.toThrow("WORKER_POLL_MS");
    await expect(readWorkerEnv({ ...workerEnv, WORKER_POLL_MS: "not-a-number" })).rejects.toThrow("WORKER_POLL_MS");
  });

  it("does not return a webhook secret", async () => {
    const env = await readWorkerEnv({ ...workerEnv, GITHUB_WEBHOOK_SECRET: "web-only-secret" });

    expect(env.github).not.toHaveProperty("webhookSecret");
  });
});
