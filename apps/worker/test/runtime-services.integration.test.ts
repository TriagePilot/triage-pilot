import { describe, expect, it, vi } from "vitest";

import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import {
  createWorkerHumanReviewPolicyServiceFactory,
  createWorkerReviewerAvailabilityServiceFactory,
  createWorkerRoutingServiceFactory,
} from "../src/runtime-services";
import { processReviewerAbsenceActivationJob } from "../src/availability-processor";
import type { RoutingJobMessage } from "../src/processor";

const message: RoutingJobMessage = {
  kind: "process_pull_request",
  deliveryId: "delivery-1",
  installationId: "99",
  repositoryId: "101",
  owner: "acme",
  repo: "api",
  pullNumber: 7,
  headSha: "abc123",
  eventName: "pull_request.opened",
};

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("worker routing runtime services", () => {
  it("persists one enforce replacement and one cohort mutation after response-loss retry", async () => {
    await withPostgresTestDatabase(async (db) => {
      const installation = await db.insertInto("installations").values({
        github_installation_id: "99",
        account_login: "acme",
        account_type: "Organization",
        status: "active",
        permissions: {},
      }).returning("id").executeTakeFirstOrThrow();
      const repository = await db.insertInto("repositories").values({
        installation_id: installation.id,
        github_repository_id: "101",
        owner: "acme",
        name: "api",
        default_branch: "main",
        config_state: "valid",
      }).returning("id").executeTakeFirstOrThrow();
      const absence = await db.insertInto("reviewer_absences").values({
        reviewer_handle: "@user-d82a5f",
        start_at: new Date(Date.now() - 86_400_000),
        end_at: new Date(Date.now() + 86_400_000),
      }).returning(["id", "revision"]).executeTakeFirstOrThrow();
      const decision = await db.insertInto("routing_decisions").values({
        repository_id: repository.id,
        delivery_id: "delivery-enforce-availability",
        routing_key: "routing-enforce-availability",
        pull_number: 7,
        head_sha: "enforce-head",
        mode: "enforce",
        action: "request_human_review",
        action_status: "pending",
        risk_score: 50,
        selected_reviewer: "@user-d82a5f",
        selected_reviewers: JSON.stringify(["@user-d82a5f"]),
        details: {
          ownership: { eligibleReviewers: ["@user-d82a5f", "@user-f30c8a"] },
          routing: { requestedReviewerCount: 1 },
        },
        policy_check_run_id: "71",
        policy_check_state: "in_progress",
      }).returning("id").executeTakeFirstOrThrow();
      await executeRaw(db, "create table cohort_update_audit (id bigserial primary key)");
      await executeRaw(db, `
        create function audit_cohort_update() returns trigger language plpgsql as $$
        begin
          insert into cohort_update_audit default values;
          return new;
        end;
        $$
      `);
      await executeRaw(db, `
        create trigger audit_cohort_update
        after update on routing_decisions
        for each row
        when (old.selected_reviewers is distinct from new.selected_reviewers)
        execute function audit_cohort_update()
      `);

      const requested = new Set(["@user-d82a5f"]);
      let losePostResponse = true;
      const request = vi.fn(async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return { data: { state: "open", head: { sha: "enforce-head" }, user: { login: "user-author" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data: [] };
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
          return { data: { users: [...requested].map((reviewer) => ({ login: reviewer.slice(1) })) } };
        }
        if (route === "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
          requested.delete("@user-d82a5f");
          return { data: {} };
        }
        if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
          requested.add("@user-f30c8a");
          if (losePostResponse) {
            losePostResponse = false;
            throw new Error("replacement response lost");
          }
          return { data: {} };
        }
        if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
          return { data: { check_runs: [{
            id: 71,
            name: "triagepilot/human-review-policy",
            external_id: decision.id,
            status: "in_progress",
            conclusion: null,
            app: { id: 123 },
          }] } };
        }
        throw new Error(`unexpected GitHub route: ${route}`);
      });
      const message = {
        kind: "activate_reviewer_absence" as const,
        absenceId: absence.id,
        expectedRevision: absence.revision,
      };
      const services = createWorkerReviewerAvailabilityServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
        createRequester: vi.fn(async () => ({ request })) as never,
      })(message);

      await expect(processReviewerAbsenceActivationJob(message, services)).rejects.toThrow(
        "replacement response lost",
      );
      await expect(processReviewerAbsenceActivationJob(message, services)).resolves.toBeUndefined();

      expect(request.mock.calls.filter(([route]) => route.startsWith("DELETE "))).toHaveLength(1);
      expect(request.mock.calls.filter(([route]) => route.startsWith("POST "))).toHaveLength(1);
      await expect(db.selectFrom("reviewer_replacements").select([
        "decision_id",
        "outcome",
        "replacement_reviewer",
      ]).execute()).resolves.toEqual([{
        decision_id: decision.id,
        outcome: "replaced",
        replacement_reviewer: "@user-f30c8a",
      }]);
      await expect(db.selectFrom("routing_decisions").select([
        "selected_reviewer",
        "selected_reviewers",
      ]).where("id", "=", decision.id).executeTakeFirstOrThrow()).resolves.toEqual({
        selected_reviewer: "@user-f30c8a",
        selected_reviewers: ["@user-f30c8a"],
      });
      await expect(executeRaw<{ count: number }>(db, "select count(*)::integer as count from cohort_update_audit"))
        .resolves.toMatchObject({ rows: [{ count: 1 }] });
    });
  });

  it("keeps shadow reviewer-availability activation GitHub-read-only while persisting its simulation", async () => {
    await withPostgresTestDatabase(async (db) => {
      const installation = await db.insertInto("installations").values({
        github_installation_id: "99",
        account_login: "acme",
        account_type: "Organization",
        status: "active",
        permissions: {},
      }).returning("id").executeTakeFirstOrThrow();
      const repository = await db.insertInto("repositories").values({
        installation_id: installation.id,
        github_repository_id: "101",
        owner: "acme",
        name: "api",
        default_branch: "main",
        config_state: "valid",
      }).returning("id").executeTakeFirstOrThrow();
      const absence = await db.insertInto("reviewer_absences").values({
        reviewer_handle: "@user-d82a5f",
        start_at: new Date(Date.now() - 86_400_000),
        end_at: new Date(Date.now() + 86_400_000),
      }).returning(["id", "revision"]).executeTakeFirstOrThrow();
      const decision = await db.insertInto("routing_decisions").values({
        repository_id: repository.id,
        delivery_id: "delivery-shadow-availability",
        routing_key: "routing-shadow-availability",
        pull_number: 7,
        head_sha: "shadow-head",
        mode: "shadow",
        action: "request_human_review",
        action_status: "not_applied",
        risk_score: 50,
        selected_reviewer: "@user-d82a5f",
        selected_reviewers: JSON.stringify(["@user-d82a5f"]),
        details: {
          ownership: { eligibleReviewers: ["@user-d82a5f", "@user-f30c8a"] },
          routing: { requestedReviewerCount: 1 },
        },
        policy_check_state: "not_started",
      }).returning("id").executeTakeFirstOrThrow();
      const request = vi.fn(async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return { data: { state: "open", head: { sha: "shadow-head" }, user: { login: "user-author" } } };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data: [] };
        throw new Error(`unexpected GitHub route: ${route}`);
      });
      const message = {
        kind: "activate_reviewer_absence" as const,
        absenceId: absence.id,
        expectedRevision: absence.revision,
      };
      const services = createWorkerReviewerAvailabilityServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
        createRequester: vi.fn(async () => ({ request })) as never,
      })(message);

      await processReviewerAbsenceActivationJob(message, services);

      expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
      expect(request.mock.calls.map(([route]) => route)).toEqual([
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      ]);
      await expect(db.selectFrom("reviewer_replacements").select([
        "decision_id",
        "outcome",
        "replacement_reviewer",
      ]).execute()).resolves.toEqual([{
        decision_id: decision.id,
        outcome: "simulated_replacement",
        replacement_reviewer: "@user-f30c8a",
      }]);
      await expect(db.selectFrom("routing_decisions").select([
        "selected_reviewer",
        "selected_reviewers",
      ]).where("id", "=", decision.id).executeTakeFirstOrThrow()).resolves.toEqual({
        selected_reviewer: "@user-f30c8a",
        selected_reviewers: ["@user-f30c8a"],
      });
    });
  });

  it("rejects decisions for repositories absent from the configured projection", async () => {
    await withPostgresTestDatabase(async (db) => {
      const buildServices = createWorkerRoutingServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
      });
      const services = buildServices(message);

      await expect(services.fetchConfig(message)).rejects.toThrow("repository 101 is not known");
      await expect(
        services.persistDecision({
          deliveryId: "delivery-1",
          routingKey: "routing:101:7:base:abc123",
          pullNumber: 7,
          headSha: "abc123",
          mode: "shadow",
          action: "policy_approval",
          actionStatus: "not_applied",
          riskScore: 5,
          details: {},
        }),
      ).rejects.toThrow("repository 101 is not known");

      await expect(db.selectFrom("installations").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("repositories").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("routing_decisions").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("reads scheduled absence windows through the routing service", async () => {
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
      await db.insertInto("repositories").values({
        installation_id: installation.id,
        github_repository_id: "101",
        owner: "acme",
        name: "api",
        default_branch: "main",
        config_state: "unknown",
      }).execute();
      await db.insertInto("reviewer_absences").values({
        reviewer_handle: "@user-d82a5f",
        start_at: new Date("2026-10-01T08:00:00.000Z"),
        end_at: new Date("2026-10-08T08:00:00.000Z"),
      }).execute();
      const services = createWorkerRoutingServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
      })(message);

      expect(services.now()).toEqual(expect.any(Date));
      await expect(services.listReviewerAbsences({
        reviewers: ["@user-d82a5f", "@user-b4e82d"],
        endingAfter: new Date("2026-10-01T08:00:00.000Z"),
      })).resolves.toEqual([{
        reviewerHandle: "@user-d82a5f",
        startAt: new Date("2026-10-01T08:00:00.000Z"),
        endAt: new Date("2026-10-08T08:00:00.000Z"),
      }]);
    });
  });

  it("projects configuration and persists policy-check lifecycle for a known repository", async () => {
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
      const repository = await db
        .insertInto("repositories")
        .values({
          installation_id: installation.id,
          github_repository_id: "101",
          owner: "acme",
          name: "api",
          default_branch: "main",
          config_state: "unknown",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const services = createWorkerRoutingServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
        createRequester: async () => ({ request: policyCheckRequester }) as never,
      })(message);

      await services.updateRepositoryConfigState({ configState: "valid", mode: "enforce" });
      const decision = await services.persistDecision({
        deliveryId: "delivery-1",
        routingKey: "routing:101:7:base:abc123",
        pullNumber: 7,
        headSha: "abc123",
        mode: "enforce",
        action: "request_human_review",
        actionStatus: "pending",
        riskScore: 5,
        selectedReviewers: ["@user-d82a5f"],
        details: { pullNumber: 7 },
      });
      const failedAt = new Date("2026-08-18T12:03:00.000Z");
      await services.markActionFailed(decision.decisionId, "GitHub denied the action", failedAt);
      await services.applyDecisionActions({
        action: "request_human_review",
        decisionId: decision.decisionId,
        expectedHeadSha: "abc123",
        riskTier: "medium",
        selectedReviewers: ["@user-d82a5f"],
      });

      const policyServices = createWorkerHumanReviewPolicyServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
        createRequester: async () => ({ request: policyCheckRequester }) as never,
      })({
        kind: "evaluate_human_review_policy",
        deliveryId: "review-delivery-1",
        installationId: "99",
        repositoryId: "101",
        owner: "acme",
        repo: "api",
        pullNumber: 7,
      });
      await expect(policyServices.findDecision({ repositoryId: "101", pullNumber: 7 })).resolves.toEqual(
        expect.objectContaining({
          decisionId: decision.decisionId,
          policyCheckRunId: "71",
          policyCheckState: "in_progress",
        }),
      );
      await policyServices.persistState({ decisionId: decision.decisionId, state: "success" });

      await expect(
        db
          .selectFrom("repositories")
          .select(["config_state", "last_config_mode"])
          .where("id", "=", repository.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ config_state: "valid", last_config_mode: "enforce" });
      await expect(
        db
          .selectFrom("routing_decisions")
          .select([
            "repository_id",
            "mode",
            "action_status",
            "action_error",
            "action_failed_at",
            "details",
            "pull_number",
            "head_sha",
            "policy_check_run_id",
            "policy_check_state",
          ])
          .where("id", "=", decision.decisionId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        repository_id: repository.id,
        mode: "enforce",
        action_status: "failed",
        action_error: "GitHub denied the action",
        action_failed_at: failedAt,
        details: { pullNumber: 7 },
        pull_number: 7,
        head_sha: "abc123",
        policy_check_run_id: "71",
        policy_check_state: "success",
      });
    });
  });
});

const policyCheckRequester = async (route: string, parameters: Record<string, unknown>) => {
  if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
    return { data: { state: "open", head: { sha: "abc123" } } };
  }
  if (route === "POST /repos/{owner}/{repo}/check-runs" && parameters.name === "triagepilot/human-review-policy") {
    return { data: { id: 71 } };
  }
  if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
    return { data: { check_runs: [] } };
  }
  if (
    route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments" ||
    route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels" ||
    route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
  ) return { data: [] };
  if (route.startsWith("POST ")) return { data: {} };
  throw new Error(`unexpected GitHub route: ${route}`);
};

async function executeRaw<Row>(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  statement: string,
) {
  return await db.executeQuery<Row>({
    sql: statement,
    parameters: [],
    query: { kind: "RawNode", sqlFragments: [statement], parameters: [] },
    queryId: { queryId: "reviewer-availability-runtime-test" },
  } as never);
}
