import { describe, expect, it } from "vitest";

import { readOperationsOverview } from "../src";
import { withPostgresTestDatabase } from "./postgres";

const now = new Date("2026-08-18T12:00:00.000Z");

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("operations overview", () => {
  it("returns the latest 50 pull request groups with at most 10 revisions per group", async () => {
    await withPostgresTestDatabase(async (db) => {
      const installation = await db.insertInto("installations").values({
        github_installation_id: "99", account_login: "acme", account_type: "Organization", status: "active", permissions: {},
      }).returning("id").executeTakeFirstOrThrow();
      const repositoryId = await seedRepository(db, installation.id, "101", "api", "shadow", "valid");

      for (let revision = 1; revision <= 12; revision += 1) {
        await db.insertInto("routing_decisions").values({
          repository_id: repositoryId,
          delivery_id: `grouped-${revision}`,
          routing_key: `grouped-${revision}`,
          pull_number: 7,
          head_sha: `head-${revision}`,
          mode: "shadow",
          action: "request_human_review",
          action_status: "not_applied",
          risk_score: revision,
          selected_reviewer: null,
          selected_reviewers: JSON.stringify([]),
          no_human_reason: null,
          details: { pullNumber: 7 },
          created_at: new Date(now.getTime() + revision * 1_000),
        }).execute();
      }
      await db.insertInto("routing_decisions").values({
        repository_id: repositoryId,
        delivery_id: "other-pr",
        routing_key: "other-pr",
        pull_number: 8,
        head_sha: "other-head",
        mode: "shadow",
        action: "policy_approval",
        action_status: "not_applied",
        risk_score: 1,
        selected_reviewer: null,
        selected_reviewers: JSON.stringify([]),
        no_human_reason: null,
        details: { pullNumber: 8 },
        created_at: new Date(now.getTime() + 500),
      }).execute();

      const overview = await readOperationsOverview(db, {
        githubOrganization: "acme", githubAppId: "123", now, heartbeatStaleAfterMs: 30_000,
      });

      expect(overview.decisions).toHaveLength(11);
      expect(overview.decisions.slice(0, 10).map((decision) => decision.headSha)).toEqual([
        "head-12", "head-11", "head-10", "head-9", "head-8", "head-7", "head-6", "head-5", "head-4", "head-3",
      ]);
      expect(overview.decisions.slice(0, 10).every((decision) => decision.runCount === 12)).toBe(true);
      expect(overview.decisions[10]).toMatchObject({ pullNumber: 8, headSha: "other-head", runCount: 1 });
    });
  });

  it("maps mixed-case organization data with bounded ordering and decimal GitHub IDs", async () => {
    await withPostgresTestDatabase(async (db) => {
      const installation = await db
        .insertInto("installations")
        .values({
          github_installation_id: "9007199254740993",
          account_login: "AcMe",
          account_type: "Organization",
          status: "active",
          permissions: { privateKey: "db-private-key" },
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const zeta = await seedRepository(db, installation.id, "201", "zeta", "enforce", "invalid");
      const api = await seedRepository(db, installation.id, "101", "api", "shadow", "valid");

      const decisionIds: string[] = [];
      for (let index = 0; index < 52; index += 1) {
        const createdAt = new Date(now.getTime() - (52 - index) * 60_000);
        const actionFailedAt = new Date(now.getTime() - index * 60_000);
        const row = await db
          .insertInto("routing_decisions")
          .values({
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
                  }
                : { pullNumber: 100 + index, rawSecret: "decision-payload-secret" },
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

      const overview = await readOperationsOverview(db, {
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
        headSha: null,
        runCount: 1,
        mode: "enforce",
        action: "policy_approval",
        actionStatus: "failed",
        actionError: "action error 51",
        policyCheckState: "in_progress",
        riskScore: 51,
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
      const installation = await db
        .insertInto("installations")
        .values({
          github_installation_id: "99",
          account_login: "acme",
          account_type: "Organization",
          status: "active",
          permissions: {},
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const repositoryId = await seedRepository(
        db,
        installation.id,
        "101",
        "api",
        "shadow",
        "valid",
      );
      const fixtures = [
        { details: { pullNumber: 7 }, expected: 7 },
        { details: {}, expected: null },
        { details: { pullNumber: "7" }, expected: null },
        { details: { pullNumber: 1.5 }, expected: null },
        { details: { pullNumber: 2_147_483_648 }, expected: null },
      ];

      for (const [index, fixture] of fixtures.entries()) {
        await db
          .insertInto("routing_decisions")
          .values({
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
            created_at: new Date(now.getTime() + index * 1_000),
          })
          .execute();
      }

      const overview = await readOperationsOverview(db, {
        githubOrganization: "ACME",
        githubAppId: "123",
        now,
        heartbeatStaleAfterMs: 30_000,
      });

      expect(overview.decisions.map((decision) => decision.pullNumber)).toEqual(
        fixtures.map((fixture) => fixture.expected).reverse(),
      );
      expect(overview.decisions.at(-1)).toMatchObject({
        action: "configuration_failure",
        pullNumber: 7,
      });
    });
  });

  it("keeps a stale heartbeat visible while marking the worker unavailable", async () => {
    await withPostgresTestDatabase(async (db) => {
      await db
        .insertInto("worker_heartbeat")
        .values({ worker_id: "worker-1", heartbeat_at: new Date(now.getTime() - 30_001) })
        .execute();

      const overview = await readOperationsOverview(db, {
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
  installationId: string,
  githubRepositoryId: string,
  name: string,
  mode: "shadow" | "enforce",
  configState: string,
): Promise<string> {
  const repository = await db
    .insertInto("repositories")
    .values({
      installation_id: installationId,
      github_repository_id: githubRepositoryId,
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
