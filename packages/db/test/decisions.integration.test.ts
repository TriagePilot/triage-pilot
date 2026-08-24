import { describe, expect, it } from "vitest";

import {
  findLatestHumanReviewPolicyDecision,
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
      const first = await persistDecision(db, {
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
      const retried = await persistDecision(db, {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "request_human_review",
        actionStatus: "pending",
        riskScore: 35,
        selectedReviewers: ["@devon", "@sam"],
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
          selected_reviewer: "@devon",
          selected_reviewers: ["@devon", "@sam"],
          no_human_reason: null,
          details: { attempt: 2 },
        }),
      ]);
    });
  });

  it("returns a terminal succeeded outcome without rewriting the completed decision", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositoryId = await seedRepository(db);
      const first = await persistDecision(db, {
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
      await markActionSucceeded(db, first.decisionId, appliedAt);

      const retried = await persistDecision(db, {
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
      const first = await persistDecision(db, {
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
      await markActionSucceeded(db, first.decisionId, appliedAt);

      const retried = await persistDecision(db, {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "shadow",
        action: "request_human_review",
        actionStatus: "not_applied",
        riskScore: 35,
        selectedReviewers: ["@devon", "@sam"],
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
      const decision = await persistDecision(db, {
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
      const untouched = await persistDecision(db, {
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
      await markActionFailed(db, decision.decisionId, "GitHub denied the action", failedAt);
      await expect(readOutcome(db, decision.decisionId)).resolves.toEqual({
        action_status: "failed",
        action_error: "GitHub denied the action",
        action_applied_at: null,
        action_failed_at: failedAt,
      });

      const appliedAt = new Date("2026-08-18T12:00:00.000Z");
      await markActionSucceeded(db, decision.decisionId, appliedAt);
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
      const decision = await persistDecision(db, {
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
      await markActionSucceeded(db, decision.decisionId, firstAppliedAt);

      await markActionFailed(
        db,
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

      await markActionSucceeded(db, decision.decisionId, new Date("2026-08-18T12:05:00.000Z"));
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
      const first = await persistDecision(db, {
        repositoryId,
        deliveryId: "delivery-1",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "request_human_review",
        actionStatus: "pending",
        riskScore: 35,
        selectedReviewers: ["@alice", "@bob"],
        details: {},
      });
      await recordPolicyCheck(db, {
        decisionId: first.decisionId,
        checkRunId: "42",
        state: "in_progress",
      });

      await expect(
        findLatestHumanReviewPolicyDecision(db, { repositoryId, pullNumber: 7 }),
      ).resolves.toEqual({
        decisionId: first.decisionId,
        owner: "acme",
        repo: "api",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "request_human_review",
        selectedReviewers: ["@alice", "@bob"],
        policyCheckRunId: "42",
        policyCheckState: "in_progress",
      });

      const latest = await persistDecision(db, {
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
      await updatePolicyCheckState(db, { decisionId: latest.decisionId, state: "failure" });
      await updatePolicyCheckState(db, { decisionId: latest.decisionId, state: "success" });
      await recordPolicyCheck(db, {
        decisionId: latest.decisionId,
        checkRunId: "99",
        state: "in_progress",
      });

      await expect(
        findLatestHumanReviewPolicyDecision(db, { repositoryId, pullNumber: 7 }),
      ).resolves.toEqual({
        decisionId: latest.decisionId,
        owner: "acme",
        repo: "api",
        pullNumber: 7,
        headSha: "head-2",
        mode: "enforce",
        action: "no_eligible_reviewer",
        selectedReviewers: [],
        policyCheckRunId: null,
        policyCheckState: "failure",
      });
    });
  });

  it("does not return a latest shadow decision for policy evaluation", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositoryId = await seedRepository(db);
      await persistDecision(db, {
        repositoryId,
        deliveryId: "delivery-enforce",
        pullNumber: 7,
        headSha: "head-1",
        mode: "enforce",
        action: "request_human_review",
        actionStatus: "pending",
        riskScore: 35,
        selectedReviewers: ["@alice"],
        details: {},
      });
      await persistDecision(db, {
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
        findLatestHumanReviewPolicyDecision(db, { repositoryId, pullNumber: 7 }),
      ).resolves.toBeNull();
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
  return repository.id;
}
