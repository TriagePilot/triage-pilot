import { describe, expect, it } from "vitest";

import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import { ensureLocalWorkspace } from "@triagepilot/db";
import {
  createWorkerHumanReviewPolicyServiceFactory,
  createWorkerRoutingServiceFactory,
} from "../src/runtime-services";
import type { RoutingJobMessage } from "../src/processor";

const message: RoutingJobMessage = {
  kind: "process_change_request",
  deliveryId: "delivery-1",
  eventName: "change_request.opened",
  workspaceId: "ws_local",
  providerConnectionId: "99",
  changeRequest: {
    repository: { provider: "github", externalId: "101", owner: "acme", name: "api" },
    externalId: "7",
    number: 7,
    baseRevision: "base-123",
    headRevision: "abc123",
  },
  isDraft: false,
  routingKey: "routing:ws_local:github:101:7:base-123:abc123",
};

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("worker routing runtime services", () => {
  it("rejects decisions for repositories absent from the configured projection", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const scopedMessage = {
        ...message,
        workspaceId,
        providerConnectionId: "00000000-0000-4000-8000-000000000099",
      };
      const buildServices = createWorkerRoutingServiceFactory({
        db,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
      });
      const services = buildServices(scopedMessage);

      await expect(services.fetchConfig(scopedMessage)).rejects.toThrow("repository 101 is not known");
      await expect(
        services.decisions.persistWithEvent({
          workspaceId,
          repository: scopedMessage.changeRequest.repository,
          deliveryId: "delivery-1",
          routingKey: "routing:101:7:base:abc123",
          changeRequestId: "7",
          changeRequestNumber: 7,
          headRevision: "abc123",
          mode: "shadow",
          action: "policy_approval",
          actionStatus: "not_applied",
          riskScore: 5,
          details: {},
          organizationConfigVersion: null,
          repositoryConfigPath: null,
          repositoryConfigRevision: null,
          effectiveConfigHash: "effective-hash",
          inheritanceMode: "defaults",
          configDiagnostics: [],
          configSources: {},
        }, () => {
          throw new Error("event factory must not run");
        }),
      ).rejects.toThrow("repository 101 is not known");

      await expect(db.selectFrom("provider_connections").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("repositories").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("routing_decisions").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("projects configuration and persists policy-check lifecycle for a known repository", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const connection = await db
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
          config_state: "unknown",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const scopedMessage = { ...message, workspaceId, providerConnectionId: connection.id };
      const scopedDb = db.withPlugin({
        transformQuery(args) {
          const query = JSON.stringify(args.node);
          if (
            args.node.kind === "UpdateQueryNode" &&
            query.includes('"name":"repositories"') &&
            !query.includes('"name":"workspace_id"')
          ) throw new Error("repository update omitted workspace scope");
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      });
      const services = createWorkerRoutingServiceFactory({
        db: scopedDb,
        github: {
          appId: "123",
          privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        },
        createRequester: async () => ({ request: policyCheckRequester }) as never,
      })(scopedMessage);

      await services.updateRepositoryConfigState({ configState: "valid", mode: "enforce" });
      const decision = await services.decisions.persistWithEvent(
        {
          workspaceId,
          repository: scopedMessage.changeRequest.repository,
          deliveryId: "delivery-1",
          routingKey: "routing:101:7:base:abc123",
          changeRequestId: "7",
          changeRequestNumber: 7,
          headRevision: "abc123",
          mode: "enforce",
          action: "request_human_review",
          actionStatus: "pending",
          riskScore: 5,
          selectedActors: ["@user-d82a5f"],
          details: { pullNumber: 7 },
          organizationConfigVersion: null,
          repositoryConfigPath: null,
          repositoryConfigRevision: null,
          effectiveConfigHash: "effective-hash",
          inheritanceMode: "defaults",
          configDiagnostics: [],
          configSources: {},
        },
        ({ decisionId }) => ({
          schemaVersion: 1,
          eventId: `decision:${decisionId}:v1`,
          occurredAt: "2026-08-18T12:02:00.000Z",
          workspaceId,
          provider: "github",
          decisionId,
          repositoryId: "101",
          changeRequestId: "7",
          routingKey: "routing:101:7:base:abc123",
          mode: "enforce",
          action: "request_human_review",
          riskScore: 5,
          selectedActors: ["@user-d82a5f"],
          effectiveConfigurationHash: "effective-hash",
        }),
      );
      const failedAt = new Date("2026-08-18T12:03:00.000Z");
      await services.decisions.markActionFailed(decision.decisionId, "GitHub denied the action", failedAt);
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
        workspaceId,
        providerConnectionId: connection.id,
        changeRequest: {
          repository: { provider: "github", externalId: "101", owner: "acme", name: "api" },
          externalId: "7",
          number: 7,
        },
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
