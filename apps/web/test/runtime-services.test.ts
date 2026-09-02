import { describe, expect, it, vi } from "vitest";
import { ensureLocalWorkspace } from "@triagepilot/db";

import { createWebRuntimeServices } from "../src/runtime-services";
import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";

describe("web runtime services", () => {
  it("delegates routing recovery to the provider-aware self-hosted composition", async () => {
    const db = new NoAccessDb();
    const queueRoutingRecovery = vi.fn(async () => ({ jobId: "job-recovery-1", routingKey: "routing-key-1" }));
    const services = createWebRuntimeServices({
      ...runtimeInput(db as never, () => new Date()),
      queueRoutingRecovery,
    });

    await expect(services.queueRoutingRecovery({
      changeRequestUrl: "https://github.com/acme/api/pull/7",
    })).resolves.toEqual({ jobId: "job-recovery-1" });
    expect(queueRoutingRecovery).toHaveBeenCalledWith({
      changeRequestUrl: "https://github.com/acme/api/pull/7",
    });
    expect(db.accessedTables).toEqual([]);
  });

  it("delegates review policy acceptance to the database service", async () => {
    const db = new NoAccessDb();
    const acceptHumanReviewPolicyDelivery = vi.fn(async () => ({ inserted: true, jobId: "job-review-1" }));
    const services = createWebRuntimeServices({
      ...runtimeInput(db as never, () => new Date()),
      repositories: { acceptHumanReviewPolicyDelivery } as never,
    });
    const delivery = {
      deliveryId: "delivery-review-1",
      eventName: "pull_request_review",
      installation: { githubInstallationId: "99", accountLogin: "acme" },
      repository: { githubRepositoryId: "101", owner: "acme", name: "api" },
      payload: {
        kind: "evaluate_human_review_policy" as const,
        deliveryId: "delivery-review-1",
        changeRequest: {
          repository: { provider: "github" as const, externalId: "101", owner: "acme", name: "api" },
          externalId: "7",
          number: 7,
        },
      },
    };
    await expect(services.acceptHumanReviewPolicyDelivery(delivery)).resolves.toEqual({
      inserted: true,
      jobId: "job-review-1",
    });
    expect(acceptHumanReviewPolicyDelivery).toHaveBeenCalledWith({
      deliveryId: "delivery-review-1",
      eventName: "pull_request_review",
      connection: {
        provider: "github",
        externalConnectionId: "99",
        workspaceLogin: "acme",
        accountType: "Organization",
      },
      repository: {
        provider: "github",
        externalRepositoryId: "101",
        owner: "acme",
        name: "api",
      },
      payload: delivery.payload,
    });
  });

  it("uses configured in-memory credentials without reading removed setup state", async () => {
    const db = new NoAccessDb();
    const services = createWebRuntimeServices(runtimeInput(db as never, () => new Date()));

    expect(await services.getWebhookSecret()).toBe("hook-secret");
    expect(services.githubOrganization).toBe("acme");
    expect(db.accessedTables).toEqual([]);
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    "returns a secret-free overview and uses the 30-second heartbeat boundary",
    async () => {
      await withPostgresTestDatabase(async (db) => {
        const workspaceId = await ensureLocalWorkspace(db);
        const connection = await db
          .insertInto("provider_connections")
          .values({
            workspace_id: workspaceId,
            provider: "github",
            external_connection_id: "9007199254740993",
            workspace_login: "acme",
            account_type: "Organization",
            status: "active",
            permissions: {},
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const repository = await db
          .insertInto("repositories")
          .values({
            workspace_id: workspaceId,
            provider: "github",
            provider_connection_id: connection.id,
            external_repository_id: "101",
            owner: "acme",
            name: "api",
            default_branch: "main",
            config_state: "valid",
            last_config_mode: "shadow",
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const decision = await db
          .insertInto("routing_decisions")
          .values({
            workspace_id: workspaceId,
            repository_id: repository.id,
            delivery_id: "delivery-1",
            routing_key: "legacy:delivery-1",
            mode: "shadow",
            action: "request_human_review",
            action_status: "not_applied",
            action_error: null,
            action_applied_at: null,
            policy_check_state: "in_progress",
            risk_score: 55,
            selected_reviewer: "@team-a7f19c/reviewers",
            selected_reviewers: JSON.stringify(["@team-a7f19c/reviewers", "@user-b4e82d"]),
            no_human_reason: null,
            details: { pullNumber: 7, privateKey: "raw-detail-secret" },
            effective_config_hash: "legacy-test-hash",
            inheritance_mode: "legacy",
            created_at: new Date("2026-08-18T10:00:00.000Z"),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const job = await db
          .insertInto("jobs")
          .values({
            workspace_id: workspaceId,
            provider: "github",
            provider_connection_id: connection.id,
            kind: "process_pull_request",
            status: "failed",
            payload: { webhookSecret: "raw-job-secret" },
            idempotency_key: "job-1",
            last_error: "GitHub permission denied",
            run_at: new Date("2026-08-18T10:01:00.000Z"),
            updated_at: new Date("2026-08-18T10:01:00.000Z"),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await db
          .insertInto("worker_heartbeat")
          .values({ worker_id: "worker-1", heartbeat_at: new Date("2026-08-18T10:02:00.000Z") })
          .execute();

        let currentTime = new Date("2026-08-18T10:02:30.000Z");
        const services = createWebRuntimeServices(runtimeInput(db, () => currentTime, workspaceId));
        await expect(services.checkDatabase()).resolves.toBeUndefined();
        const overview = await services.listOperationsOverview();

        expect(overview).toEqual({
          statuses: [
            { id: "workspace", label: "Organization", value: "acme" },
            {
              id: "connection",
              label: "GitHub App",
              value: "App 123",
              detail: "Installation 9007199254740993",
            },
          ],
          repositories: [
            {
              id: repository.id,
              repository: { label: "acme/api", href: "https://github.com/acme/api" },
              configState: "valid",
              mode: "shadow",
            },
          ],
          decisions: [
            {
              id: decision.id,
              repository: { label: "acme/api", href: "https://github.com/acme/api" },
              changeRequest: { label: "#7", href: "https://github.com/acme/api/pull/7" },
              mode: "shadow",
              action: "request_human_review",
              actionStatus: "not_applied",
              actionError: null,
              policyCheckState: "in_progress",
              riskScore: 55,
              riskBreakdown: null,
              requestedReviewerCount: null,
              reviewerShortfall: null,
              selectedReviewer: "@team-a7f19c/reviewers",
              selectedReviewers: ["@team-a7f19c/reviewers", "@user-b4e82d"],
              createdAt: "2026-08-18T10:00:00.000Z",
            },
          ],
          failures: {
            jobs: [
              {
                id: job.id,
                error: "GitHub permission denied",
                failedAt: "2026-08-18T10:01:00.000Z",
              },
            ],
            actions: [],
          },
          worker: {
            available: true,
            workerId: "worker-1",
            lastHeartbeatAt: "2026-08-18T10:02:00.000Z",
          },
        });

        const serialized = JSON.stringify(overview);
        for (const secret of [
          "private-key-secret",
          "hook-secret",
          "correct-password",
          "session-secret-value-that-is-long-enough",
          "raw-detail-secret",
          "raw-job-secret",
        ]) {
          expect(serialized).not.toContain(secret);
        }

        currentTime = new Date("2026-08-18T10:02:30.001Z");
        await expect(services.listOperationsOverview()).resolves.toMatchObject({
          worker: {
            available: false,
            workerId: "worker-1",
            lastHeartbeatAt: "2026-08-18T10:02:00.000Z",
          },
        });
      });
    },
  );
});

function runtimeInput(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  now: () => Date,
  workspaceId = "00000000-0000-4000-8000-000000000001",
) {
  return {
    db,
    workspaceId,
    adminUsername: "admin",
    adminPassword: "correct-password",
    sessionSecret: "session-secret-value-that-is-long-enough",
    secureCookies: false,
    now,
    sourceAddress: () => "203.0.113.8",
    githubOrganization: "acme",
    github: {
      appId: "123",
      privateKey: "private-key-secret",
      webhookSecret: "hook-secret",
    },
    verifySignature: async () => {},
    normalizeGitHubWebhook: () => null,
    readEffectiveConfiguration: async () => ({
      repository: { label: "acme/api", href: "https://github.com/acme/api" },
      trustedPath: null,
      trustedRevision: "self-hosted-probe",
      repositoryRevision: null,
      inheritanceMode: "defaults" as const,
      effectiveHash: "a".repeat(64),
      values: [],
    }),
    queueRoutingRecovery: async () => ({ jobId: "job-recovery-1", routingKey: "routing-key-1" }),
  };
}

class NoAccessDb {
  accessedTables: string[] = [];

  selectFrom(table: string): never {
    this.accessedTables.push(table);
    throw new Error(`unexpected read from ${table}`);
  }
}
