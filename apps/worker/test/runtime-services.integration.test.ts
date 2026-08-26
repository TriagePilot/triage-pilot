import { describe, expect, it } from "vitest";

import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import {
  createWorkerHumanReviewPolicyServiceFactory,
  createWorkerRoutingServiceFactory,
} from "../src/runtime-services";
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
