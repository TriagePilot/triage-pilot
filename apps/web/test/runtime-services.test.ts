import { describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  acceptHumanReviewPolicyDelivery: vi.fn(),
  cancelReviewerAbsence: vi.fn(),
  createReviewerAbsence: vi.fn(),
  readAvailabilityOverview: vi.fn(),
  updateOrganizationTimezone: vi.fn(),
  updateReviewerAbsence: vi.fn(),
}));

vi.mock("@triagepilot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@triagepilot/db")>()),
  acceptHumanReviewPolicyDelivery: dbMocks.acceptHumanReviewPolicyDelivery,
  cancelReviewerAbsence: dbMocks.cancelReviewerAbsence,
  createReviewerAbsence: dbMocks.createReviewerAbsence,
  readAvailabilityOverview: dbMocks.readAvailabilityOverview,
  updateOrganizationTimezone: dbMocks.updateOrganizationTimezone,
  updateReviewerAbsence: dbMocks.updateReviewerAbsence,
}));

import { createWebRuntimeServices } from "../src/runtime-services";
import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";

describe("web runtime services", () => {
  it("delegates review policy acceptance to the database service", async () => {
    const db = new NoAccessDb();
    const services = createWebRuntimeServices(runtimeInput(db as never, () => new Date()));
    const delivery = {
      deliveryId: "delivery-review-1",
      eventName: "pull_request_review",
      installation: { githubInstallationId: "99", accountLogin: "acme" },
      repository: { githubRepositoryId: "101", owner: "acme", name: "api" },
      payload: {
        kind: "evaluate_human_review_policy" as const,
        deliveryId: "delivery-review-1",
        installationId: "99",
        repositoryId: "101",
        owner: "acme",
        repo: "api",
        pullNumber: 7,
      },
    };
    dbMocks.acceptHumanReviewPolicyDelivery.mockResolvedValueOnce({ inserted: true, jobId: "job-review-1" });

    await expect(services.acceptHumanReviewPolicyDelivery(delivery)).resolves.toEqual({
      inserted: true,
      jobId: "job-review-1",
    });
    expect(dbMocks.acceptHumanReviewPolicyDelivery).toHaveBeenCalledWith(db, delivery);
  });

  it("uses configured in-memory credentials without reading removed setup state", async () => {
    const db = new NoAccessDb();
    const services = createWebRuntimeServices(runtimeInput(db as never, () => new Date()));

    expect(await services.getWebhookSecret()).toBe("hook-secret");
    expect(services.githubOrganization).toBe("acme");
    expect(db.accessedTables).toEqual([]);
  });

  it("delegates reviewer availability reads and mutations to the database service", async () => {
    const db = new NoAccessDb();
    const services = createWebRuntimeServices(runtimeInput(db as never, () => new Date()));
    const now = new Date("2026-08-18T10:00:00.000Z");
    const overview = { timezone: "UTC", absences: [] };
    const absence = {
      reviewerHandle: "@user-d82a5f",
      startAt: new Date("2026-08-19T08:00:00.000Z"),
      endAt: new Date("2026-08-19T16:00:00.000Z"),
      now,
    };
    dbMocks.readAvailabilityOverview.mockResolvedValueOnce(overview);
    dbMocks.updateOrganizationTimezone.mockResolvedValueOnce(undefined);
    dbMocks.createReviewerAbsence.mockResolvedValueOnce(undefined);
    dbMocks.updateReviewerAbsence.mockResolvedValueOnce(undefined);
    dbMocks.cancelReviewerAbsence.mockResolvedValueOnce(undefined);

    await expect(services.readAvailabilityOverview({ now })).resolves.toEqual(overview);
    await services.updateOrganizationTimezone({ timezone: "Europe/Bratislava", now });
    await services.createReviewerAbsence(absence);
    await services.updateReviewerAbsence({ ...absence, absenceId: "absence-1", expectedRevision: 2 });
    await services.cancelReviewerAbsence({ absenceId: "absence-1", expectedRevision: 2, now });

    expect(dbMocks.readAvailabilityOverview).toHaveBeenCalledWith(db, { now });
    expect(dbMocks.updateOrganizationTimezone).toHaveBeenCalledWith(db, { timezone: "Europe/Bratislava", now });
    expect(dbMocks.createReviewerAbsence).toHaveBeenCalledWith(db, absence);
    expect(dbMocks.updateReviewerAbsence).toHaveBeenCalledWith(db, {
      ...absence,
      absenceId: "absence-1",
      expectedRevision: 2,
    });
    expect(dbMocks.cancelReviewerAbsence).toHaveBeenCalledWith(db, { absenceId: "absence-1", expectedRevision: 2, now });
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    "returns a secret-free overview and uses the 30-second heartbeat boundary",
    async () => {
      await withPostgresTestDatabase(async (db) => {
        const installation = await db
          .insertInto("installations")
          .values({
            github_installation_id: "9007199254740993",
            account_login: "acme",
            account_type: "Organization",
            status: "active",
            permissions: {},
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const repository = await db
          .insertInto("repositories")
          .values({
            installation_id: installation.id,
            github_repository_id: "101",
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
            created_at: new Date("2026-08-18T10:00:00.000Z"),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const job = await db
          .insertInto("jobs")
          .values({
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
        const services = createWebRuntimeServices(runtimeInput(db, () => currentTime));
        await expect(services.checkDatabase()).resolves.toBeUndefined();
        const overview = await services.listOperationsOverview();

        expect(overview).toEqual({
          organization: "acme",
          githubApp: { appId: "123", configured: true, installationId: "9007199254740993" },
          repositories: [
            { id: repository.id, owner: "acme", name: "api", configState: "valid", mode: "shadow" },
          ],
          decisions: [
            {
              id: decision.id,
              repository: "acme/api",
              pullNumber: 7,
              mode: "shadow",
              action: "request_human_review",
              actionStatus: "not_applied",
              actionError: null,
              policyCheckState: "in_progress",
              riskScore: 55,
              riskBreakdown: null,
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
) {
  return {
    db,
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
  };
}

class NoAccessDb {
  accessedTables: string[] = [];

  selectFrom(table: string): never {
    this.accessedTables.push(table);
    throw new Error(`unexpected read from ${table}`);
  }
}
