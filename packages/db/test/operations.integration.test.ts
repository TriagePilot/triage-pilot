import { describe, expect, it } from "vitest";

import { ensureLocalWorkspace, readOperationsOverview } from "../src";
import { withPostgresTestDatabase } from "./postgres";

const now = new Date("2026-08-18T12:00:00.000Z");

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("operations overview", () => {
  it("maps mixed-case organization data with bounded ordering and decimal GitHub IDs", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const providerConnection = await db
        .insertInto("provider_connections")
        .values({
          workspace_id: workspaceId,
          provider: "github",
          external_connection_id: "9007199254740993",
          workspace_login: "AcMe",
          account_type: "Organization",
          status: "active",
          permissions: { privateKey: "db-private-key" },
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const zeta = await seedRepository(db, workspaceId, providerConnection.id, "201", "zeta", "enforce", "invalid");
      const api = await seedRepository(db, workspaceId, providerConnection.id, "101", "api", "shadow", "valid");

      const decisionIds: string[] = [];
      for (let index = 0; index < 52; index += 1) {
        const createdAt = new Date(now.getTime() - (52 - index) * 60_000);
        const actionFailedAt = new Date(now.getTime() - index * 60_000);
        const row = await db
          .insertInto("routing_decisions")
          .values({
            workspace_id: workspaceId,
            repository_id: index % 2 === 0 ? api : zeta,
            delivery_id: `delivery-${index}`,
            routing_key: `legacy:delivery-${index}`,
            mode: index % 2 === 0 ? "shadow" : "enforce",
            action: index % 2 === 0 ? "request_human_review" : "policy_approval",
            action_status: "failed",
            action_error: `action error ${index}`,
            action_applied_at: null,
            action_failed_at: actionFailedAt,
            policy_check_state: index === 51 ? "in_progress" : "not_started",
            risk_score: index,
            selected_reviewer: index % 2 === 0 ? "@team-a7f19c/reviewers" : null,
            selected_reviewers: JSON.stringify(index % 2 === 0 ? ["@team-a7f19c/reviewers", "@user-b4e82d"] : []),
            no_human_reason: null,
            details:
              index === 51
                ? {
                    pullNumber: 100 + index,
                    rawSecret: "decision-payload-secret",
                    risk: {
                      classifierVersion: "risk-v1",
                      score: 51,
                      tier: "medium",
                      components: [
                        {
                          reason: "high_risk_path:infrastructure",
                          score: 20,
                          detail: "3 files matched infrastructure/**",
                        },
                      ],
                    },
                    routing: {
                      requestedReviewerCount: 2,
                      reviewerShortfall: 1,
                    },
                  }
                : { pullNumber: 100 + index, rawSecret: "decision-payload-secret" },
            effective_config_hash: `legacy-${index}`,
            inheritance_mode: "legacy",
            created_at: createdAt,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        decisionIds.push(row.id);
      }

      const jobIds: string[] = [];
      for (let index = 0; index < 27; index += 1) {
        const failedAt = new Date(now.getTime() - (27 - index) * 60_000);
        const row = await db
          .insertInto("jobs")
          .values({
            workspace_id: workspaceId,
            provider: "github",
            provider_connection_id: providerConnection.id,
            kind: "process_pull_request",
            status: "failed",
            payload: { webhookSecret: "job-payload-secret" },
            idempotency_key: `job-${index}`,
            last_error: `job error ${index}`,
            run_at: failedAt,
            updated_at: failedAt,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        jobIds.push(row.id);
      }

      await db
        .insertInto("worker_heartbeat")
        .values({ worker_id: "worker-1", heartbeat_at: new Date(now.getTime() - 30_000) })
        .execute();

      const overview = await readOperationsOverview(db, workspaceId, {
        githubOrganization: "aCmE",
        githubAppId: "123",
        now,
        heartbeatStaleAfterMs: 30_000,
      });

      expect(overview.organization).toBe("aCmE");
      expect(overview.githubApp).toEqual({
        appId: "123",
        configured: true,
        installationId: "9007199254740993",
      });
      expect(overview.repositories).toEqual([
        { id: api, owner: "acme", name: "api", configState: "valid", mode: "shadow" },
        { id: zeta, owner: "acme", name: "zeta", configState: "invalid", mode: "enforce" },
      ]);
      expect(overview.decisions).toHaveLength(50);
      expect(overview.decisions.map((decision) => decision.id)).toEqual(
        decisionIds.slice(2).reverse(),
      );
      expect(overview.decisions[0]).toEqual({
        id: decisionIds[51],
        repository: "acme/zeta",
        pullNumber: 151,
        mode: "enforce",
        action: "policy_approval",
        actionStatus: "failed",
        actionError: "action error 51",
        policyCheckState: "in_progress",
        riskScore: 51,
        requestedReviewerCount: 2,
        reviewerShortfall: 1,
        selectedReviewer: null,
        selectedReviewers: [],
        riskBreakdown: {
          classifierVersion: "risk-v1",
          tier: "medium",
          components: [
            {
              reason: "high_risk_path:infrastructure",
              score: 20,
              detail: "3 files matched infrastructure/**",
            },
          ],
        },
        createdAt: "2026-08-18T11:59:00.000Z",
      });
      expect(overview.decisions[1]).toMatchObject({
        requestedReviewerCount: null,
        reviewerShortfall: null,
      });
      expect(overview.failures.jobs).toHaveLength(25);
      expect(overview.failures.jobs.map((failure) => failure.id)).toEqual(jobIds.slice(2).reverse());
      expect(overview.failures.jobs[0]).toEqual({
        id: jobIds[26],
        error: "job error 26",
        failedAt: "2026-08-18T11:59:00.000Z",
      });
      expect(overview.failures.actions).toHaveLength(25);
      expect(overview.failures.actions.map((failure) => failure.decisionId)).toEqual(
        decisionIds.slice(0, 25),
      );
      expect(overview.failures.actions[0]).toEqual({
        decisionId: decisionIds[0],
        repository: "acme/api",
        error: "action error 0",
        failedAt: "2026-08-18T12:00:00.000Z",
      });
      expect(overview.worker).toEqual({
        available: true,
        workerId: "worker-1",
        lastHeartbeatAt: "2026-08-18T11:59:30.000Z",
      });

      const serialized = JSON.stringify(overview);
      expect(serialized).not.toContain("db-private-key");
      expect(serialized).not.toContain("decision-payload-secret");
      expect(serialized).not.toContain("rawSecret");
      expect(serialized).not.toContain("job-payload-secret");
      expect(serialized).not.toContain("details");
      expect(serialized).not.toContain("payload");
    });
  });

  it("returns null pull numbers for missing, malformed, fractional, and out-of-range legacy JSON", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const providerConnection = await db
        .insertInto("provider_connections")
        .values({
          workspace_id: workspaceId,
          provider: "github",
          external_connection_id: "99",
          workspace_login: "acme",
          account_type: "Organization",
          status: "active",
          permissions: {},
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const repositoryId = await seedRepository(
        db,
        workspaceId,
        providerConnection.id,
        "101",
        "api",
        "shadow",
        "valid",
      );
      const fixtures = [
        {
          details: { pullNumber: 7, routing: { requestedReviewerCount: 1, reviewerShortfall: 1 } },
          expected: 7,
          quota: { requestedReviewerCount: 1, reviewerShortfall: 1 },
        },
        {
          details: {},
          expected: null,
          quota: { requestedReviewerCount: null, reviewerShortfall: null },
        },
        {
          details: { pullNumber: "7", routing: { requestedReviewerCount: 3, reviewerShortfall: 0 } },
          expected: null,
          quota: { requestedReviewerCount: null, reviewerShortfall: null },
        },
        {
          details: { pullNumber: 1.5, routing: { requestedReviewerCount: 2 } },
          expected: null,
          quota: { requestedReviewerCount: 2, reviewerShortfall: 2 },
        },
        {
          details: { pullNumber: 2_147_483_648 },
          expected: null,
          quota: { requestedReviewerCount: null, reviewerShortfall: null },
        },
      ];

      for (const [index, fixture] of fixtures.entries()) {
        await db
          .insertInto("routing_decisions")
          .values({
            workspace_id: workspaceId,
            repository_id: repositoryId,
            delivery_id: `legacy-${index}`,
            routing_key: `legacy:legacy-${index}`,
            mode: "shadow",
            action: index === 0 ? "configuration_failure" : "policy_approval",
            action_status: "not_applied",
            action_error: null,
            action_applied_at: null,
            action_failed_at: null,
            risk_score: 0,
            selected_reviewer: null,
            selected_reviewers: JSON.stringify([]),
            no_human_reason: null,
            details: fixture.details,
            effective_config_hash: `legacy-${index}`,
            inheritance_mode: "legacy",
            created_at: new Date(now.getTime() + index * 1_000),
          })
          .execute();
      }

      const overview = await readOperationsOverview(db, workspaceId, {
        githubOrganization: "ACME",
        githubAppId: "123",
        now,
        heartbeatStaleAfterMs: 30_000,
      });

      expect(overview.decisions.map((decision) => decision.pullNumber)).toEqual(
        fixtures.map((fixture) => fixture.expected).reverse(),
      );
      expect(overview.decisions.map(({ requestedReviewerCount, reviewerShortfall }) => ({
        requestedReviewerCount,
        reviewerShortfall,
      }))).toEqual(fixtures.map((fixture) => fixture.quota).reverse());
      expect(overview.decisions.at(-1)).toMatchObject({
        action: "configuration_failure",
        pullNumber: 7,
      });
    });
  });

  it("keeps a stale heartbeat visible while marking the worker unavailable", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      await db
        .insertInto("worker_heartbeat")
        .values({ worker_id: "worker-1", heartbeat_at: new Date(now.getTime() - 30_001) })
        .execute();

      const overview = await readOperationsOverview(db, workspaceId, {
        githubOrganization: "acme",
        githubAppId: "123",
        now,
        heartbeatStaleAfterMs: 30_000,
      });

      expect(overview.githubApp).toEqual({ appId: "123", configured: true, installationId: null });
      expect(overview.worker).toEqual({
        available: false,
        workerId: "worker-1",
        lastHeartbeatAt: "2026-08-18T11:59:29.999Z",
      });
    });
  });
});

async function seedRepository(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  workspaceId: string,
  providerConnectionId: string,
  externalRepositoryId: string,
  name: string,
  mode: "shadow" | "enforce",
  configState: string,
): Promise<string> {
  const repository = await db
    .insertInto("repositories")
    .values({
      workspace_id: workspaceId,
      provider: "github",
      provider_connection_id: providerConnectionId,
      external_repository_id: externalRepositoryId,
      owner: "acme",
      name,
      default_branch: "main",
      last_config_mode: mode,
      config_state: configState,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return repository.id;
}
