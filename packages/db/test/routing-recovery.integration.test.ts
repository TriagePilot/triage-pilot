import { describe, expect, it } from "vitest";

import { findRoutingRecoveryTarget } from "../src";
import { withPostgresTestDatabase } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("routing recovery target", () => {
  it("resolves active configured pull requests by decision and repository identity", async () => {
    await withPostgresTestDatabase(async (db) => {
      const installation = await db.insertInto("installations").values({
        github_installation_id: "9007199254740993",
        account_login: "AcMe",
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
      const decision = await db.insertInto("routing_decisions").values({
        repository_id: repository.id,
        delivery_id: "delivery-1",
        routing_key: "routing-1",
        pull_number: null,
        head_sha: "head-1",
        action: "request_human_review",
        risk_score: 40,
        selected_reviewer: null,
        selected_reviewers: JSON.stringify([]),
        no_human_reason: null,
        details: { pullNumber: 2674 },
      }).returning("id").executeTakeFirstOrThrow();
      const expected = {
        githubInstallationId: "9007199254740993",
        githubRepositoryId: "101",
        owner: "acme",
        repo: "api",
        pullNumber: 2674,
      };

      await expect(findRoutingRecoveryTarget(db, {
        githubOrganization: "ACME",
        decisionId: decision.id,
      })).resolves.toEqual(expected);
      await expect(findRoutingRecoveryTarget(db, {
        githubOrganization: "acme",
        owner: "ACME",
        repo: "API",
        pullNumber: 2674,
      })).resolves.toEqual(expected);
      await expect(findRoutingRecoveryTarget(db, {
        githubOrganization: "different-org",
        decisionId: decision.id,
      })).resolves.toBeNull();
    });
  });
});
