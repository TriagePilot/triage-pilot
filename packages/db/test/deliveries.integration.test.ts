import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  acceptRoutingDelivery,
  acceptHumanReviewPolicyDelivery,
  activateConfiguredInstallation,
  deleteConfiguredInstallation,
  replaceInstallationRepositories,
  suspendConfiguredInstallation,
  updateInstallationRepositories,
  upsertConfiguredInstallation,
} from "../src";
import { withPostgresTestDatabase } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("delivery ingestion", () => {
  it("creates one receipt and job for concurrent duplicate deliveries", async () => {
    await withPostgresTestDatabase(async (db) => {
      const input = deliveryInput();

      const results = await Promise.all([
        acceptRoutingDelivery(db, input),
        acceptRoutingDelivery(db, input),
      ]);

      expect(results.map((result) => result.inserted).sort()).toEqual([false, true]);
      expect(results.filter((result) => result.jobId !== null)).toHaveLength(1);
      await expectCounts(db, {
        webhook_receipts: 1,
        jobs: 1,
        installations: 1,
        repositories: 1,
      });
      await expect(
        db.selectFrom("webhook_receipts").select(["event_action", "hook_id"]).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ event_action: "opened", hook_id: "hook-1" });
    });
  });

  it("records distinct deliveries for one pull-request state but queues only one routing job", async () => {
    await withPostgresTestDatabase(async (db) => {
      const first = deliveryInput();
      const second = {
        ...deliveryInput(),
        deliveryId: "delivery-2",
        payload: { ...first.payload, deliveryId: "delivery-2" },
      };

      const results = await Promise.all([acceptRoutingDelivery(db, first), acceptRoutingDelivery(db, second)]);
      expect(results.map((result) => result.inserted)).toEqual([true, true]);
      expect(results.filter((result) => result.jobId !== null)).toHaveLength(1);
      await expectCounts(db, {
        webhook_receipts: 2,
        jobs: 1,
        installations: 1,
        repositories: 1,
      });
    });
  });

  it("rolls back the receipt and projection when job insertion fails", async () => {
    await withPostgresTestDatabase(async (db) => {
      await sql`alter table jobs add constraint reject_routing_job check (kind <> 'process_pull_request')`.execute(db);

      await expect(acceptRoutingDelivery(db, deliveryInput())).rejects.toThrow();

      await expectCounts(db, {
        webhook_receipts: 0,
        jobs: 0,
        installations: 0,
        repositories: 0,
      });
    });
  });

  it("creates one receipt and policy-evaluation job for concurrent duplicate review deliveries", async () => {
    await withPostgresTestDatabase(async (db) => {
      const input = humanReviewPolicyDeliveryInput();

      const results = await Promise.all([
        acceptHumanReviewPolicyDelivery(db, input),
        acceptHumanReviewPolicyDelivery(db, input),
      ]);

      expect(results.map((result) => result.inserted).sort()).toEqual([false, true]);
      expect(results.filter((result) => result.jobId !== null)).toHaveLength(1);
      await expectCounts(db, {
        webhook_receipts: 1,
        jobs: 1,
        installations: 1,
        repositories: 1,
      });
      await expect(
        db.selectFrom("jobs").select(["kind", "idempotency_key"]).executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        kind: "evaluate_human_review_policy",
        idempotency_key: "review-policy:delivery-review-1",
      });
    });
  });

  it("replaces and incrementally updates the selected repository projection", async () => {
    await withPostgresTestDatabase(async (db) => {
      await upsertConfiguredInstallation(db, {
        githubInstallationId: "99",
        accountLogin: "acme",
        repositories: [
          repository("101", "api"),
          repository("102", "web"),
        ],
      });
      await replaceInstallationRepositories(db, {
        githubInstallationId: "99",
        accountLogin: "ACME",
        repositories: [repository("102", "frontend")],
      });
      await updateInstallationRepositories(db, {
        githubInstallationId: "99",
        accountLogin: "acme",
        repositoriesAdded: [repository("103", "docs")],
        repositoryIdsRemoved: ["102"],
      });

      const installations = await db
        .selectFrom("installations")
        .select(["github_installation_id", "account_login", "account_type", "status"])
        .execute();
      const repositories = await db
        .selectFrom("repositories")
        .select(["github_repository_id", "owner", "name"])
        .orderBy("github_repository_id")
        .execute();

      expect(installations).toEqual([
        {
          github_installation_id: "99",
          account_login: "acme",
          account_type: "Organization",
          status: "active",
        },
      ]);
      expect(repositories).toEqual([
        { github_repository_id: "103", owner: "acme", name: "docs" },
      ]);
    });
  });

  it.each(["unsuspend", "new_permissions_accepted"])(
    "preserves repositories when %s reactivates without a snapshot",
    async () => {
      await withPostgresTestDatabase(async (db) => {
        await upsertConfiguredInstallation(db, {
          githubInstallationId: "99",
          accountLogin: "acme",
          repositories: [repository("101", "api")],
        });
        await suspendConfiguredInstallation(db, {
          githubInstallationId: "99",
          accountLogin: "acme",
        });

        await activateConfiguredInstallation(db, {
          githubInstallationId: "99",
          accountLogin: "ACME",
        });

        expect(
          await db
            .selectFrom("installations")
            .select(["github_installation_id", "account_login", "status"])
            .executeTakeFirstOrThrow(),
        ).toEqual({ github_installation_id: "99", account_login: "ACME", status: "active" });
        expect(
          await db.selectFrom("repositories").select(["github_repository_id", "name"]).execute(),
        ).toEqual([{ github_repository_id: "101", name: "api" }]);
      });
    },
  );

  it("ignores a delayed incremental event for a replaced installation ID", async () => {
    await withPostgresTestDatabase(async (db) => {
      await upsertConfiguredInstallation(db, {
        githubInstallationId: "99",
        accountLogin: "acme",
        repositories: [repository("101", "old")],
      });
      await replaceInstallationRepositories(db, {
        githubInstallationId: "100",
        accountLogin: "acme",
        repositories: [repository("200", "current")],
      });

      await updateInstallationRepositories(db, {
        githubInstallationId: "99",
        accountLogin: "acme",
        repositoriesAdded: [repository("103", "stale-added")],
        repositoryIdsRemoved: ["200"],
      });

      expect(
        await db
          .selectFrom("installations")
          .select(["github_installation_id", "account_login", "status"])
          .execute(),
      ).toEqual([{ github_installation_id: "100", account_login: "acme", status: "active" }]);
      expect(
        await db.selectFrom("repositories").select(["github_repository_id", "name"]).execute(),
      ).toEqual([{ github_repository_id: "200", name: "current" }]);
    });
  });

  it("suspends and deletes only the configured installation", async () => {
    await withPostgresTestDatabase(async (db) => {
      await upsertConfiguredInstallation(db, {
        githubInstallationId: "99",
        accountLogin: "acme",
        repositories: [repository("101", "api")],
      });

      await suspendConfiguredInstallation(db, {
        githubInstallationId: "99",
        accountLogin: "acme",
      });
      expect(
        await db.selectFrom("installations").select("status").executeTakeFirstOrThrow(),
      ).toEqual({ status: "suspended" });

      await deleteConfiguredInstallation(db, { githubInstallationId: "99" });
      await expectCounts(db, { installations: 0, repositories: 0 });
    });
  });
});

function deliveryInput() {
  return {
    deliveryId: "delivery-1",
    eventName: "pull_request",
    eventAction: "opened",
    hookId: "hook-1",
    installation: { githubInstallationId: "99", accountLogin: "acme" },
    repository: repository("101", "api"),
    payload: {
      kind: "process_pull_request" as const,
      deliveryId: "delivery-1",
      installationId: "99",
      repositoryId: "101",
      owner: "acme",
      repo: "api",
      pullNumber: 7,
      baseSha: "base-123",
      headSha: "abc123",
      eventName: "pull_request.opened",
      routingKey: "routing:101:7:base-123:abc123",
    },
  };
}

function humanReviewPolicyDeliveryInput() {
  return {
    deliveryId: "delivery-review-1",
    eventName: "pull_request_review",
    installation: { githubInstallationId: "99", accountLogin: "acme" },
    repository: repository("101", "api"),
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
}

function repository(githubRepositoryId: string, name: string) {
  return { githubRepositoryId, owner: "acme", name };
}

async function expectCounts(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  expected: Partial<Record<"webhook_receipts" | "jobs" | "installations" | "repositories", number>>,
) {
  for (const [table, count] of Object.entries(expected)) {
    const result = await sql<{ count: string }>`select count(*)::text as count from ${sql.table(table)}`.execute(db);
    expect(Number(result.rows[0]?.count)).toBe(count);
  }
}
