import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "@triagepilot/db";

import { createWebApp } from "../src/app";
import { createSelfHostedWebComposition } from "../src/composition/self-hosted";
import { withPostgresTestDatabaseUrl } from "../../../packages/db/test/postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("self-hosted web composition", () => {
  it("resolves the persisted local workspace before exposing web services", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const composition = await createSelfHostedWebComposition(webEnv(databaseUrl));

      expect(composition.services.workspaceId).toBe(composition.workspaceId);

      await composition.close();
    });
  });

  it("binds availability reads and mutations to the active workspace provider connection", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const composition = await createSelfHostedWebComposition(webEnv(databaseUrl));
      try {
        await expect(composition.services.readAvailabilitySettings()).rejects.toThrow(
          "Provider connection is not active in this workspace",
        );
        await composition.services.activateConfiguredInstallation({ githubInstallationId: "99", accountLogin: "acme" });

        await expect(composition.services.readAvailabilitySettings()).resolves.toMatchObject({ timezone: "UTC" });
        await composition.services.updateAvailabilityTimezone({ timezone: "Europe/Bratislava", now: new Date("2026-09-01T05:00:00.000Z") });
        const scheduled = await composition.services.scheduleReviewerAbsence({
          externalActorId: "@user-d82a5f",
          startAt: new Date("2030-09-01T06:00:00.000Z"),
          endAt: new Date("2030-09-01T15:00:00.000Z"),
          now: new Date("2026-09-01T05:00:00.000Z"),
        });
        expect(scheduled).toMatchObject({ externalActorId: "@user-d82a5f", status: "upcoming", revision: 1 });
        await expect(composition.services.listReviewerAbsences()).resolves.toMatchObject([{ id: scheduled.id }]);

        await composition.services.deleteConfiguredInstallation({ githubInstallationId: "99" });
        await expect(composition.services.listReviewerAbsences()).rejects.toThrow(
          "Provider connection is not active in this workspace",
        );
      } finally {
        await composition.close();
      }
    });
  });

  it("keeps self-hosted configuration shadow-only without a trusted repository document", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const composition = await createSelfHostedWebComposition(webEnv(databaseUrl));

      const result = await composition.configuration.resolve({ repositoryDocument: null });

      expect(result.ok && result.config.mode).toBe("shadow");
      expect(composition.configuration.allowOrganizationEnforce).toBe(false);

      await composition.close();
    });
  });

  it("verifies and normalizes a GitHub webhook before enqueueing a workspace-bound job", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const composition = await createSelfHostedWebComposition(webEnv(databaseUrl));
      const app = createWebApp(composition.services);
      const body = pullRequestBody({ owner: "AcMe", repo: "api" });

      const response = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body),
        body,
      });

      expect(response.status).toBe(202);
      const job = await composition.db.selectFrom("jobs").select(["workspace_id", "provider", "payload"]).executeTakeFirstOrThrow();
      expect(job.workspace_id).toBe(composition.workspaceId);
      expect(job.provider).toBe("github");
      expect(job.payload).toMatchObject({
        kind: "process_change_request",
        workspaceId: composition.workspaceId,
        changeRequest: {
          repository: { provider: "github", externalId: "101", owner: "AcMe", name: "api" },
          externalId: "7",
          number: 7,
          baseRevision: "trusted-base-123",
          headRevision: "head-456",
        },
      });
      expect(JSON.stringify(job.payload)).not.toContain("pull_request");

      await composition.close();
    });
  });

  it("rejects a personal account matching the configured organization before persistence", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const composition = await createSelfHostedWebComposition(webEnv(databaseUrl));
      const writeWarning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const app = createWebApp(composition.services);
      const body = pullRequestBody({ owner: "acme", ownerType: "User", repo: "api" });

      try {
        const response = await app.request("/webhooks/github", {
          method: "POST",
          headers: signedHeaders(body),
          body,
        });

        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ ok: true, ignored: "account_scope" });
        await expect(composition.db.selectFrom("webhook_receipts").select("delivery_id").execute()).resolves.toEqual([]);
        await expect(composition.db.selectFrom("provider_connections").select("id").execute()).resolves.toEqual([]);
        await expect(composition.db.selectFrom("jobs").select("id").execute()).resolves.toEqual([]);
        expect(writeWarning).toHaveBeenCalledOnce();
      } finally {
        writeWarning.mockRestore();
        await composition.close();
      }
    });
  });

  it("serializes ignored-webhook logs with workspace scope and no credential or payload material", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const composition = await createSelfHostedWebComposition(webEnv(databaseUrl));
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (record: string) => warnings.push(record);
      try {
        composition.services.logIgnoredWebhook({
          eventName: "pull_request",
          deliveryId: "delivery-ignored",
          accountType: "User",
          accountLogin: "person-login",
        });
      } finally {
        console.warn = originalWarn;
        await composition.close();
      }

      expect(warnings).toHaveLength(1);
      const serialized = warnings[0] ?? "";
      expect(JSON.parse(serialized)).toMatchObject({
        event: "ignored_out_of_scope_github_webhook",
        service: "web",
        workspaceId: composition.workspaceId,
        provider: "github",
        deliveryId: "delivery-ignored",
        providerAccountType: "User",
        providerAccountLogin: "person-login",
      });
      expect(serialized).not.toContain("hook-secret");
      expect(serialized).not.toContain("PRIVATE KEY");
      expect(serialized).not.toContain("diff --git");
      expect(serialized).not.toContain("commit message");
      expect(serialized).not.toContain("tenant");
    });
  });
});

function webEnv(databaseUrl: string) {
  return {
    nodeEnv: "test" as const,
    appBaseUrl: "http://localhost:8787",
    databaseUrl,
    adminUsername: "admin",
    adminPassword: "password",
    sessionSecret: "12345678901234567890123456789012",
    githubOrganization: "acme",
    github: {
      appId: "123",
      privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      webhookSecret: "hook-secret",
    },
    secureCookies: false,
  };
}

function pullRequestBody(input: { owner: string; ownerType?: string; repo: string }) {
  return JSON.stringify({
    action: "opened",
    installation: { id: 99 },
    sender: { id: 502, login: "event-sender-71c9ab" },
    repository: {
      id: 101,
      name: input.repo,
      owner: { login: input.owner, type: input.ownerType ?? "Organization" },
    },
    pull_request: {
      id: 7001,
      number: 7,
      draft: false,
      base: { sha: "trusted-base-123" },
      head: { sha: "head-456" },
    },
  });
}

function signedHeaders(body: string) {
  return {
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-1",
    "x-github-hook-id": "hook-1",
    "x-hub-signature-256": `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`,
  };
}
