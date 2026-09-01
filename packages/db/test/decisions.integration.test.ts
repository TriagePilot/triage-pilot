import { describe, expect, it } from "vitest";

import {
  findReviewerReplacementCandidates,
  findLatestHumanReviewPolicyDecision,
  ensureLocalWorkspace,
  markActionFailed,
  markActionSucceeded,
  persistDecision,
  recordPolicyCheck,
  updatePolicyCheckState,
} from "../src";
import { withPostgresTestDatabase } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("routing decisions", () => {
  it("uses the delivery ID as a stable retry key while refreshing the decision", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositoryId = await seedRepository(db);
      const first = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "shadow",
        action: "policy_approval",
        actionStatus: "not_applied",
        riskScore: 5,
        noHumanReason: "risk_at_or_below_low_threshold",
        details: { attempt: 1 },
      });
      const retried = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "request_human_review",
        actionStatus: "pending",
        riskScore: 35,
        selectedReviewers: ["@user-b4e82d", "@user-9e3c71"],
        details: { attempt: 2 },
      });

      expect(retried.decisionId).toBe(first.decisionId);
      await expect(
        db.selectFrom("routing_decisions").selectAll().where("delivery_id", "=", "delivery-1").execute(),
      ).resolves.toEqual([
        expect.objectContaining({
          id: first.decisionId,
          repository_id: repositoryId,
          mode: "enforce",
          action: "request_human_review",
          action_status: "pending",
          risk_score: 35,
          selected_reviewer: "@user-b4e82d",
          selected_reviewers: ["@user-b4e82d", "@user-9e3c71"],
          no_human_reason: null,
          details: { attempt: 2 },
        }),
      ]);
    });
  });

  it("returns a terminal succeeded outcome without rewriting the completed decision", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositoryId = await seedRepository(db);
      const first = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "policy_approval",
        actionStatus: "pending",
        riskScore: 5,
        noHumanReason: "risk_at_or_below_low_threshold",
        details: { attempt: 1 },
      });
      const appliedAt = new Date("2026-08-18T12:00:00.000Z");
      await markActionSucceeded(db, await ensureLocalWorkspace(db), first.decisionId, appliedAt);

      const retried = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "policy_approval",
        actionStatus: "pending",
        riskScore: 6,
        details: { attempt: 2 },
      });

      expect(retried).toEqual({
        decisionId: first.decisionId,
        actionStatus: "succeeded",
        actionError: null,
        actionAppliedAt: appliedAt,
      });
      await expect(
        db
          .selectFrom("routing_decisions")
          .select([
            "mode",
            "action",
            "action_status",
            "action_error",
            "action_applied_at",
            "risk_score",
            "selected_reviewer",
            "selected_reviewers",
            "no_human_reason",
            "details",
          ])
          .where("id", "=", first.decisionId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        mode: "enforce",
        action: "policy_approval",
        action_status: "succeeded",
        action_error: null,
        action_applied_at: appliedAt,
        risk_score: 5,
        selected_reviewer: null,
        selected_reviewers: [],
        no_human_reason: "risk_at_or_below_low_threshold",
        details: { attempt: 1 },
      });
    });
  });

  it("preserves the completed action identity when a retry calculates a different mode and action", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositoryId = await seedRepository(db);
      const first = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "policy_approval",
        actionStatus: "pending",
        riskScore: 5,
        noHumanReason: "risk_at_or_below_low_threshold",
        details: { routing: "original" },
      });
      const appliedAt = new Date("2026-08-18T12:00:00.000Z");
      await markActionSucceeded(db, await ensureLocalWorkspace(db), first.decisionId, appliedAt);

      const retried = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "shadow",
        action: "request_human_review",
        actionStatus: "not_applied",
        riskScore: 35,
        selectedReviewers: ["@user-b4e82d", "@user-9e3c71"],
        details: { routing: "retry" },
      });

      expect(retried).toEqual({
        decisionId: first.decisionId,
        actionStatus: "succeeded",
        actionError: null,
        actionAppliedAt: appliedAt,
      });
      await expect(
        db
          .selectFrom("routing_decisions")
          .select([
            "mode",
            "action",
            "action_status",
            "action_applied_at",
            "risk_score",
            "selected_reviewer",
            "selected_reviewers",
            "no_human_reason",
            "details",
          ])
          .where("id", "=", first.decisionId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        mode: "enforce",
        action: "policy_approval",
        action_status: "succeeded",
        action_applied_at: appliedAt,
        risk_score: 5,
        selected_reviewer: null,
        selected_reviewers: [],
        no_human_reason: "risk_at_or_below_low_threshold",
        details: { routing: "original" },
      });
    });
  });

  it("records failure and success outcomes only for the named decision", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositoryId = await seedRepository(db);
      const decision = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "policy_approval",
        actionStatus: "pending",
        riskScore: 5,
        details: {},
      });
      const untouched = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-2",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "policy_approval",
        actionStatus: "pending",
        riskScore: 5,
        details: {},
      });

      const failedAt = new Date("2026-08-18T11:59:00.000Z");
      await markActionFailed(db, await ensureLocalWorkspace(db), decision.decisionId, "GitHub denied the action", failedAt);
      await expect(readOutcome(db, decision.decisionId)).resolves.toEqual({
        action_status: "failed",
        action_error: "GitHub denied the action",
        action_applied_at: null,
        action_failed_at: failedAt,
      });

      const appliedAt = new Date("2026-08-18T12:00:00.000Z");
      await markActionSucceeded(db, await ensureLocalWorkspace(db), decision.decisionId, appliedAt);
      await expect(readOutcome(db, decision.decisionId)).resolves.toEqual({
        action_status: "succeeded",
        action_error: null,
        action_applied_at: appliedAt,
        action_failed_at: null,
      });
      await expect(readOutcome(db, untouched.decisionId)).resolves.toEqual({
        action_status: "pending",
        action_error: null,
        action_applied_at: null,
        action_failed_at: null,
      });
    });
  });

  it("keeps the first success terminal across late failure and repeated success updates", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositoryId = await seedRepository(db);
      const decision = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "policy_approval",
        actionStatus: "pending",
        riskScore: 5,
        details: {},
      });
      const firstAppliedAt = new Date("2026-08-18T12:00:00.000Z");
      await markActionSucceeded(db, await ensureLocalWorkspace(db), decision.decisionId, firstAppliedAt);

      await markActionFailed(
        db,
        await ensureLocalWorkspace(db),
        decision.decisionId,
        "late failure",
        new Date("2026-08-18T12:01:00.000Z"),
      );
      await expect(readOutcome(db, decision.decisionId)).resolves.toEqual({
        action_status: "succeeded",
        action_error: null,
        action_applied_at: firstAppliedAt,
        action_failed_at: null,
      });

      await markActionSucceeded(db, await ensureLocalWorkspace(db), decision.decisionId, new Date("2026-08-18T12:05:00.000Z"));
      await expect(readOutcome(db, decision.decisionId)).resolves.toEqual({
        action_status: "succeeded",
        action_error: null,
        action_applied_at: firstAppliedAt,
        action_failed_at: null,
      });
    });
  });

  it("finds the latest policy decision for a pull request and updates its durable check state", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositoryId = await seedRepository(db);
      const first = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "request_human_review",
        actionStatus: "pending",
        riskScore: 35,
        selectedReviewers: ["@user-d82a5f"],
        details: { routing: { requestedReviewerCount: 2 } },
      });
      await recordPolicyCheck(db, await ensureLocalWorkspace(db), {
        decisionId: first.decisionId,
        checkRunId: "42",
        state: "in_progress",
      });

      await expect(
        findLatestHumanReviewPolicyDecision(db, await ensureLocalWorkspace(db), { repositoryId, pullNumber: 7 }),
      ).resolves.toEqual({
        decisionId: first.decisionId,
        owner: "acme",
        repo: "api",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "request_human_review",
        selectedReviewers: ["@user-d82a5f"],
        requiredApprovalCount: 2,
        policyCheckRunId: "42",
        policyCheckState: "in_progress",
      });

      const latest = await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-2",
        pullNumber: 7,
        headSha: "head-2",
        mode: "enforce",
        action: "no_eligible_reviewer",
        actionStatus: "not_applied",
        riskScore: 35,
        details: {},
      });
      await updatePolicyCheckState(db, await ensureLocalWorkspace(db), { decisionId: latest.decisionId, state: "failure" });
      await updatePolicyCheckState(db, await ensureLocalWorkspace(db), { decisionId: latest.decisionId, state: "success" });
      await recordPolicyCheck(db, await ensureLocalWorkspace(db), {
        decisionId: latest.decisionId,
        checkRunId: "99",
        state: "in_progress",
      });

      await expect(
        findLatestHumanReviewPolicyDecision(db, await ensureLocalWorkspace(db), { repositoryId, pullNumber: 7 }),
      ).resolves.toEqual({
        decisionId: latest.decisionId,
        owner: "acme",
        repo: "api",
        pullNumber: 7,
        headSha: "head-2",
        mode: "enforce",
        action: "no_eligible_reviewer",
        selectedReviewers: [],
        requiredApprovalCount: 0,
        policyCheckRunId: null,
        policyCheckState: "failure",
      });
    });
  });

  it("does not return a latest shadow decision for policy evaluation", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositoryId = await seedRepository(db);
      await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-enforce",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "request_human_review",
        actionStatus: "pending",
        riskScore: 35,
        selectedReviewers: ["@user-d82a5f"],
        details: {},
      });
      await persistDecision(db, await ensureLocalWorkspace(db), {
        repositoryId,
        deliveryId: "delivery-shadow",
        pullNumber: 7,
        headSha: "head-2",
        mode: "shadow",
        action: "no_eligible_reviewer",
        actionStatus: "not_applied",
        riskScore: 35,
        details: {},
      });

      await expect(
        findLatestHumanReviewPolicyDecision(db, await ensureLocalWorkspace(db), { repositoryId, pullNumber: 7 }),
      ).resolves.toBeNull();
    });
  });

  it("discovers only latest scoped cohorts and derives immutable replacement inputs from decision details", async () => {
    await withPostgresTestDatabase(async (db) => {
      const workspaceId = await ensureLocalWorkspace(db);
      const repositoryId = await seedRepository(db);
      const repository = await db.selectFrom("repositories")
        .select(["provider", "provider_connection_id", "external_repository_id"])
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", repositoryId)
        .executeTakeFirstOrThrow();
      const common = {
        workspace_id: workspaceId,
        repository_id: repositoryId,
        mode: "enforce" as const,
        action: "request_human_review",
        action_status: "pending" as const,
        risk_score: 50,
        no_human_reason: null,
        organization_config_version: null,
        repository_config_path: null,
        repository_config_revision: null,
        effective_config_hash: "candidate-config",
        inheritance_mode: "legacy" as const,
        config_diagnostics: [],
        config_sources: {},
      };
      await db.insertInto("routing_decisions").values([
        {
          ...common,
          id: "00000000-0000-0000-0000-000000000061",
          delivery_id: "candidate-old",
          routing_key: "candidate-old",
          pull_number: 7,
          head_sha: "head-old",
          selected_reviewer: "@user-absent",
          selected_reviewers: JSON.stringify(["@user-absent"]),
          details: {
            ownership: { preferredReviewers: ["@user-old"], eligibleReviewers: ["@user-absent", "@user-old"] },
            routing: { requestedReviewerCount: 1 },
          },
          created_at: new Date("2026-09-01T10:00:00.000Z"),
        },
        {
          ...common,
          id: "00000000-0000-0000-0000-000000000062",
          delivery_id: "candidate-current",
          routing_key: "candidate-current",
          pull_number: 7,
          head_sha: "head-current",
          selected_reviewer: "@user-absent",
          selected_reviewers: JSON.stringify([" @USER-ABSENT ", "@user-existing"]),
          details: {
            ownership: {
              preferredReviewers: [" @USER-ABSENT ", "@user-preferred"],
              eligibleReviewers: ["@user-absent", "@user-preferred", "@user-fallback"],
            },
            routing: { requestedReviewerCount: 2 },
          },
          policy_check_run_id: "42",
          policy_check_state: "in_progress" as const,
          created_at: new Date("2026-09-01T11:00:00.000Z"),
        },
        {
          ...common,
          id: "00000000-0000-0000-0000-000000000063",
          delivery_id: "candidate-legacy",
          routing_key: "candidate-legacy",
          pull_number: 8,
          head_sha: "head-legacy",
          selected_reviewer: "@user-absent",
          selected_reviewers: JSON.stringify(["@user-absent"]),
          details: {
            ownership: { eligibleReviewers: ["@user-absent", "@user-legacy"] },
            routing: { requestedReviewerCount: 1 },
          },
          created_at: new Date("2026-09-01T11:10:00.000Z"),
        },
        {
          ...common,
          id: "00000000-0000-0000-0000-000000000064",
          delivery_id: "candidate-superseded",
          routing_key: "candidate-superseded",
          pull_number: 9,
          head_sha: "head-superseded",
          selected_reviewer: "@user-absent",
          selected_reviewers: JSON.stringify(["@user-absent"]),
          details: {
            ownership: { eligibleReviewers: ["@user-absent", "@user-spare"] },
            routing: { requestedReviewerCount: 1 },
          },
          created_at: new Date("2026-09-01T11:20:00.000Z"),
        },
        {
          ...common,
          id: "00000000-0000-0000-0000-000000000065",
          delivery_id: "candidate-superseding",
          routing_key: "candidate-superseding",
          pull_number: 9,
          head_sha: "head-superseding",
          selected_reviewer: "@user-current",
          selected_reviewers: JSON.stringify(["@user-current"]),
          details: {
            ownership: { eligibleReviewers: ["@user-absent", "@user-current"] },
            routing: { requestedReviewerCount: 1 },
          },
          created_at: new Date("2026-09-01T11:30:00.000Z"),
        },
        {
          ...common,
          id: "00000000-0000-0000-0000-000000000066",
          delivery_id: "candidate-malformed",
          routing_key: "candidate-malformed",
          pull_number: 10,
          head_sha: "head-malformed",
          selected_reviewer: "@user-absent",
          selected_reviewers: JSON.stringify(["@user-absent"]),
          details: {
            ownership: { eligibleReviewers: "@user-absent" },
            routing: { requestedReviewerCount: 2 },
          },
          created_at: new Date("2026-09-01T11:40:00.000Z"),
        },
      ]).execute();

      await expect(findReviewerReplacementCandidates(db, workspaceId, {
        provider: repository.provider,
        providerConnectionId: repository.provider_connection_id,
        unavailableActorId: " @USER-ABSENT ",
      })).resolves.toEqual([
        {
          decisionId: "00000000-0000-0000-0000-000000000062",
          provider: "github",
          providerConnectionId: repository.provider_connection_id,
          repositoryRecordId: repositoryId,
          repositoryId: repository.external_repository_id,
          owner: "acme",
          repositoryName: "api",
          changeRequestNumber: 7,
          routedHeadRevision: "head-current",
          mode: "enforce",
          selectedActors: ["@user-absent", "@user-existing"],
          originalPreferredActors: ["@user-absent", "@user-preferred"],
          originalEligibleActors: ["@user-absent", "@user-preferred", "@user-fallback"],
          requestedReviewerCount: 2,
          policyCheckRunId: "42",
          policyCheckState: "in_progress",
        },
        {
          decisionId: "00000000-0000-0000-0000-000000000063",
          provider: "github",
          providerConnectionId: repository.provider_connection_id,
          repositoryRecordId: repositoryId,
          repositoryId: repository.external_repository_id,
          owner: "acme",
          repositoryName: "api",
          changeRequestNumber: 8,
          routedHeadRevision: "head-legacy",
          mode: "enforce",
          selectedActors: ["@user-absent"],
          originalPreferredActors: ["@user-absent", "@user-legacy"],
          originalEligibleActors: ["@user-absent", "@user-legacy"],
          requestedReviewerCount: 1,
          policyCheckRunId: null,
          policyCheckState: "not_started",
        },
      ]);
    });
  });
});

async function readOutcome(db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0], decisionId: string) {
  return await db
    .selectFrom("routing_decisions")
    .select(["action_status", "action_error", "action_applied_at", "action_failed_at"])
    .where("id", "=", decisionId)
    .executeTakeFirstOrThrow();
}

async function seedRepository(db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]): Promise<string> {
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
  return repository.id;
}
