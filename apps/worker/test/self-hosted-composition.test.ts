import { describe, expect, it, vi } from "vitest";
import { buildRoutingKey } from "@triagepilot/contracts";
import { createWorkspaceReviewerAvailability, runMigrations } from "@triagepilot/db";

import { createSelfHostedWorkerComposition } from "../src/composition/self-hosted";
import { processRoutingJob } from "../src/processor";
import { withPostgresTestDatabaseUrl } from "../../../packages/db/test/postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("self-hosted worker composition", () => {
  it("resolves the persisted local workspace before exposing worker services", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const composition = await createSelfHostedWorkerComposition(workerEnv(databaseUrl));

      expect(composition.workspaceId).toBe(composition.localRepositories.workspaceId);

      await composition.close();
    });
  });

  it("keeps self-hosted configuration shadow-only without a trusted repository document", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const composition = await createSelfHostedWorkerComposition(workerEnv(databaseUrl));

      const result = await composition.configuration.resolve({ repositoryDocument: null });

      expect(result.ok && result.config.mode).toBe("shadow");
      expect(composition.configuration.allowOrganizationEnforce).toBe(false);

      await composition.close();
    });
  });

  it.each([
    {
      name: "root-only",
      root: "version: 1\nmode: enforce\n",
      legacy: null,
      expectedPath: ".triagepilot.yml",
      expectedMode: "enforce",
      ok: true,
    },
    {
      name: "legacy-only",
      root: null,
      legacy: "version: 1\nmode: enforce\n",
      expectedPath: ".github/triagepilot.yml",
      expectedMode: "enforce",
      ok: true,
    },
    {
      name: "both-present",
      root: "version: 1\nmode: shadow\n",
      legacy: "version: 1\nmode: enforce\n",
      expectedPath: ".triagepilot.yml",
      expectedMode: "shadow",
      ok: true,
    },
    {
      name: "neither-present",
      root: null,
      legacy: null,
      expectedPath: null,
      expectedMode: "shadow",
      ok: true,
    },
    {
      name: "invalid",
      root: "version: 1\nmode: invalid\n",
      legacy: null,
      expectedPath: ".triagepilot.yml",
      expectedMode: "shadow",
      ok: false,
    },
  ])("resolves repository configuration from the self-hosted worker path: $name", async (fixture) => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const requester = contentsRequester({ root: fixture.root, legacy: fixture.legacy });
      const composition = await createSelfHostedWorkerComposition(workerEnv(databaseUrl), {
        createRequester: async () => ({ request: requester }),
      });
      const { providerConnectionId } = await insertKnownRepository(composition);
      const job = routingJob(composition.workspaceId, providerConnectionId);

      const services = composition.buildRoutingServices(job);
      const result = await services.resolveConfiguration(job);

      expect(result.ok).toBe(fixture.ok);
      expect(result.provenance.repositoryPath).toBe(fixture.expectedPath);
      expect(result.ok ? result.config.mode : "shadow").toBe(fixture.expectedMode);
      expect(requester).not.toHaveBeenCalledWith(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        expect.anything(),
      );

      await composition.close();
    });
  });

  it("processes a change request through workspace-bound database and GitHub adapter ports", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const requester = decisionRequester();
      const composition = await createSelfHostedWorkerComposition(workerEnv(databaseUrl), {
        createRequester: async () => ({ request: requester }),
      });
      const { providerConnectionId } = await insertKnownRepository(composition);
      const job = routingJob(composition.workspaceId, providerConnectionId);

      await processRoutingJob(job, composition.buildRoutingServices(job));

      const decision = await composition.db
        .selectFrom("routing_decisions")
        .select(["workspace_id", "mode", "action", "repository_config_path"])
        .executeTakeFirstOrThrow();
      expect(decision).toMatchObject({
        workspace_id: composition.workspaceId,
        mode: "shadow",
        action: "policy_approval",
        repository_config_path: ".triagepilot.yml",
      });
      expect(requester.mock.calls.map(([route]) => route).filter((route) => route.startsWith("POST "))).toEqual([]);

      await composition.close();
    });
  });

  it("dispatches a claimed reviewer absence activation without provider access when no candidate exists", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const createRequester = vi.fn(async () => {
        throw new Error("activation without candidates must not compose GitHub access");
      });
      const clock = { now: () => new Date("2026-09-01T12:00:00.000Z") };
      const composition = await createSelfHostedWorkerComposition(workerEnv(databaseUrl), {
        createRequester,
        clock,
      });
      const { providerConnectionId } = await insertKnownRepository(composition);
      const absence = await createWorkspaceReviewerAvailability(composition.db, composition.workspaceId)
        .scheduleAbsence({
          provider: "github",
          providerConnectionId,
          externalActorId: "@user-d82a5f",
          startAt: new Date("2026-09-01T11:00:00.000Z"),
          endAt: new Date("2026-09-01T13:00:00.000Z"),
          now: new Date("2026-09-01T10:00:00.000Z"),
        });
      const queued = await composition.db.selectFrom("jobs")
        .select("id as jobId")
        .where("kind", "=", "activate_reviewer_absence")
        .where("payload", "@>", { absenceId: absence.id })
        .executeTakeFirstOrThrow();

      await expect(composition.runOnce(clock.now())).resolves.toBe(true);
      await expect(composition.db.selectFrom("jobs")
        .select(["status", "last_error"])
        .where("id", "=", queued.jobId)
        .executeTakeFirstOrThrow()).resolves.toEqual({ status: "succeeded", last_error: null });
      expect(createRequester).not.toHaveBeenCalled();

      await composition.close();
    });
  });

  it("rejects malformed activation scope before composing provider access", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      await runMigrations(databaseUrl);
      const createRequester = vi.fn(async () => {
        throw new Error("malformed scope must not compose GitHub access");
      });
      const composition = await createSelfHostedWorkerComposition(workerEnv(databaseUrl), { createRequester });
      const { providerConnectionId } = await insertKnownRepository(composition);
      const queued = await composition.localRepositories.jobs.enqueue({
        provider: "github",
        providerConnectionId,
        kind: "activate_reviewer_absence",
        payload: {
          kind: "activate_reviewer_absence",
          workspaceId: "spoofed-workspace",
          providerConnectionId: "spoofed-connection",
          absenceId: " ",
          absenceRevision: 1,
        },
        idempotencyKey: "malformed-activation",
        runAt: new Date("2026-09-01T12:00:00.000Z"),
      });

      await expect(composition.runOnce(new Date("2026-09-01T12:00:00.000Z"))).resolves.toBe(true);
      await expect(composition.db.selectFrom("jobs")
        .select(["status", "last_error"])
        .where("id", "=", queued.jobId)
        .executeTakeFirstOrThrow()).resolves.toEqual({
        status: "failed",
        last_error: "reviewer absence activation job payload is malformed",
      });
      expect(createRequester).not.toHaveBeenCalled();

      await composition.close();
    });
  });
});

function workerEnv(databaseUrl: string) {
  return {
    databaseUrl,
    githubOrganization: "acme",
    github: {
      appId: "123",
      privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      webhookSecret: "hook-secret",
    },
    pollMs: 2000,
    workerId: "worker-test",
  };
}

async function insertKnownRepository(composition: Awaited<ReturnType<typeof createSelfHostedWorkerComposition>>) {
  const connection = await composition.db
    .insertInto("provider_connections")
    .values({
      workspace_id: composition.workspaceId,
      provider: "github",
      external_connection_id: "99",
      workspace_login: "acme",
      account_type: "Organization",
      status: "active",
      permissions: {},
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await composition.db
    .insertInto("repositories")
    .values({
      workspace_id: composition.workspaceId,
      provider: "github",
      provider_connection_id: connection.id,
      external_repository_id: "101",
      owner: "acme",
      name: "api",
      default_branch: "main",
      config_state: "valid",
      last_config_mode: "shadow",
    })
    .execute();
  return { providerConnectionId: connection.id };
}

function routingJob(workspaceId: string, providerConnectionId: string) {
  const changeRequest = {
    repository: { provider: "github" as const, externalId: "101", owner: "acme", name: "api" },
    externalId: "7",
    number: 7,
    baseRevision: "trusted-base-123",
    headRevision: "head-456",
  };
  return {
    kind: "process_change_request" as const,
    deliveryId: "delivery-1",
    eventName: "change_request.opened",
    workspaceId,
    providerConnectionId,
    changeRequest,
    isDraft: false,
    routingKey: buildRoutingKey({
      workspaceId,
      provider: "github",
      repositoryId: "101",
      changeRequestId: "7",
      trustedConfigRevision: "trusted-base-123",
      headRevision: "head-456",
      isDraft: false,
    }),
  };
}

function contentsRequester(input: { root: string | null; legacy: string | null }) {
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route !== "GET /repos/{owner}/{repo}/contents/{path}") {
      throw new Error(`unexpected route: ${route}`);
    }
    const content = parameters.path === ".triagepilot.yml" ? input.root : input.legacy;
    if (content === null) throw Object.assign(new Error("not found"), { status: 404 });
    return { data: { content: Buffer.from(content).toString("base64") } };
  });
}

function decisionRequester() {
  return vi.fn(async (route: string) => {
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      return { data: { content: Buffer.from("version: 1\nmode: shadow\n").toString("base64") } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return {
        data: {
          user: { login: "user-a2f4c9" },
          head: { ref: "feature/small", sha: "head-456" },
          base: { ref: "main", sha: "trusted-base-123" },
        },
      };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
      return { data: [{ filename: "src/small.ts", additions: 1, deletions: 0 }] };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits") {
      return { data: [{ commit: { message: "small cleanup" } }] };
    }
    throw new Error(`unexpected route: ${route}`);
  });
}
