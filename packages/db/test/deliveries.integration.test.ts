import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import { createWorkspaceRepositories, ensureLocalWorkspace, materializeQueueRepository, createJobClaimer, replayDeferredPullRequestDelivery, recoverDeferredPullRequestDelivery } from "../src";
import { withPostgresTestDatabase } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("delivery ingestion", () => {
  it.each(["routing", "review"] as const)("durably defers an unmaterialized repository and replays the %s event after selection", async kind => withPostgresTestDatabase(async db => {
    const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
    await repositories.activateConfiguredProviderConnection(connection("99", "acme"));
    const source = kind === "routing" ? deliveryInput() : humanReviewPolicyDeliveryInput();
    const invalidation = { externalInstallationId: "99", repository: source.payload.changeRequest.repository, pullNumber: 7 };
    const delivery = kind === "routing" ? { ...deliveryInput(), invalidation, routingPayload: deliveryInput().payload } : { ...humanReviewPolicyDeliveryInput(), invalidation, policyPayload: humanReviewPolicyDeliveryInput().payload };
    expect(await repositories.acceptPullRequestDelivery(delivery)).toEqual({ inserted: false, routingJobId: null, policyJobId: null, deferred: true });
    await expectCounts(db, { repositories: 0, webhook_receipts: 0, jobs: 1 });
    expect(await createJobClaimer(db).claimNext("worker", new Date())).toBeNull();
    await repositories.updateProviderConnectionRepositories({ ...connection("99", "acme"), repositoriesAdded: [repository("101", "api")], repositoryIdsRemoved: [] });
    expect(await replayOne(db)).toBe(true);
    expect(await repositories.acceptPullRequestDelivery(delivery)).toMatchObject({ inserted: false });
    expect(await db.selectFrom("jobs").select("id").where("kind", "=", kind === "routing" ? "process_pull_request" : "evaluate_human_review_policy").execute()).toHaveLength(1);
    expect(await db.selectFrom("deferred_pull_request_deliveries").selectAll().execute()).toHaveLength(0);
    await expectCounts(db, { repositories: 1, webhook_receipts: 1, jobs: 3 });
  }));

  it("recovers exhausted deferred work with a fresh dispatch after authority is restored", async () => withPostgresTestDatabase(async db => {
    const workspaceId = await ensureLocalWorkspace(db);
    const repositories = createWorkspaceRepositories(db, workspaceId);
    await repositories.activateConfiguredProviderConnection(connection("99", "acme"));
    const source = deliveryInput();
    const delivery = { ...source, invalidation: { externalInstallationId: "99", repository: source.payload.changeRequest.repository, pullNumber: 7 }, routingPayload: source.payload };
    await repositories.acceptPullRequestDelivery(delivery);
    await db.updateTable("jobs").set({ status: "failed", updated_at: new Date(0) }).where("kind", "=", "replay_deferred_delivery").execute();
    expect(await recoverDeferredPullRequestDelivery(db, workspaceId, new Date())).toBe(false);
    await repositories.updateProviderConnectionRepositories({ ...connection("99", "acme"), repositoriesAdded: [repository("101", "api")], repositoryIdsRemoved: [] });
    expect(await recoverDeferredPullRequestDelivery(db, workspaceId, new Date())).toBe(true);
    expect(await recoverDeferredPullRequestDelivery(db, workspaceId, new Date())).toBe(false);
    expect((await db.selectFrom("deferred_pull_request_deliveries").select("dispatch_epoch").executeTakeFirstOrThrow()).dispatch_epoch).toBe(2);
    expect(await replayOne(db)).toBe(true);
    expect(await db.selectFrom("deferred_pull_request_deliveries").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("webhook_receipts").selectAll().execute()).toHaveLength(1);
  }));

  it("does not alter selected repository metadata on duplicate delivery", async () => withPostgresTestDatabase(async db => {
    const workspaceId = await ensureLocalWorkspace(db);
    const repositories = createWorkspaceRepositories(db, workspaceId);
    await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
    await repositories.acceptRoutingDelivery(deliveryInput());
    await repositories.updateProviderConnectionRepositories({ ...connection("99", "acme"), repositoriesAdded: [repository("101", "renamed")], repositoryIdsRemoved: [] });
    const before = await db.selectFrom("provider_connections").select("queue_selection_revision").executeTakeFirstOrThrow();
    await repositories.acceptRoutingDelivery(deliveryInput());
    expect((await db.selectFrom("repositories").select("name").executeTakeFirstOrThrow()).name).toBe("renamed");
    expect(await db.selectFrom("provider_connections").select("queue_selection_revision").executeTakeFirstOrThrow()).toEqual(before);
  }));

  it("replays a backlog one delivery at a time and lets routing run first", async () => withPostgresTestDatabase(async db => {
    const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
    await repositories.activateConfiguredProviderConnection(connection("99", "acme"));
    for (const deliveryId of ["first", "second"]) {
      const source = deliveryInput();
      await repositories.acceptPullRequestDelivery({ ...source, deliveryId, invalidation: { externalInstallationId: "99", repository: source.payload.changeRequest.repository, pullNumber: 7 }, routingPayload: { ...source.payload, deliveryId } });
    }
    await repositories.updateProviderConnectionRepositories({ ...connection("99", "acme"), repositoriesAdded: [repository("101", "api")], repositoryIdsRemoved: [] });
    expect(await db.selectFrom("webhook_receipts").selectAll().execute()).toHaveLength(0);
    expect(await replayOne(db)).toBe(true);
    expect(await db.selectFrom("deferred_pull_request_deliveries").selectAll().execute()).toHaveLength(1);
    const routing = await createJobClaimer(db).claimNext("worker", new Date());
    expect(routing?.kind).toBe("process_pull_request");
    expect(await replayOne(db)).toBe(true);
    expect(await db.selectFrom("deferred_pull_request_deliveries").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("webhook_receipts").selectAll().execute()).toHaveLength(2);
  }));

  it("replays a deferred delivery when authoritative inventory materializes its repository", async () => withPostgresTestDatabase(async db => {
    const workspaceId = await ensureLocalWorkspace(db);
    const repositories = createWorkspaceRepositories(db, workspaceId);
    await repositories.activateConfiguredProviderConnection(connection("99", "acme"));
    const current = await db.selectFrom("provider_connections").select("id").executeTakeFirstOrThrow();
    const source = deliveryInput();
    await repositories.acceptPullRequestDelivery({ ...source, invalidation: { externalInstallationId: "99", repository: source.payload.changeRequest.repository, pullNumber: 7 }, routingPayload: source.payload });
    await materializeQueueRepository(db, { workspaceId, providerConnectionId: current.id, externalInstallationId: "99" }, repository("101", "api"));
    expect(await replayOne(db)).toBe(true);
    await expectCounts(db, { repositories: 1, webhook_receipts: 1, jobs: 3 });
    expect(await db.selectFrom("deferred_pull_request_deliveries").selectAll().execute()).toHaveLength(0);
  }));

  it("rolls replay effects back and retains the deferred delivery if replay fails", async () => withPostgresTestDatabase(async db => {
    const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
    await repositories.activateConfiguredProviderConnection(connection("99", "acme"));
    const source = deliveryInput();
    await repositories.acceptPullRequestDelivery({ ...source, invalidation: { externalInstallationId: "99", repository: source.payload.changeRequest.repository, pullNumber: 7 }, routingPayload: source.payload });
    await sql`alter table jobs add constraint reject_deferred_routing check (kind <> 'process_pull_request')`.execute(db);
    await repositories.updateProviderConnectionRepositories({ ...connection("99", "acme"), repositoriesAdded: [repository("101", "api")], repositoryIdsRemoved: [] });
    await expect(replayOne(db)).rejects.toThrow();
    await expectCounts(db, { repositories: 1, webhook_receipts: 0, jobs: 1 });
    expect(await db.selectFrom("deferred_pull_request_deliveries").selectAll().execute()).toHaveLength(1);
  }));

  it("rejects a delayed delivery after a repository is deselected", async () => withPostgresTestDatabase(async db => {
    const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
    await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
    await repositories.updateProviderConnectionRepositories({ ...connection("99", "acme"), repositoriesAdded: [], repositoryIdsRemoved: ["101"] });
    expect(await repositories.acceptRoutingDelivery(deliveryInput())).toEqual({ inserted: false, jobId: null });
    await expectCounts(db, { repositories: 0, webhook_receipts: 0, jobs: 1 });
  }));

  it("does not reclaim a repository reassigned to another connection", async () => withPostgresTestDatabase(async db => {
    const workspaceId = await ensureLocalWorkspace(db);
    const repositories = createWorkspaceRepositories(db, workspaceId);
    await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
    const other = await db.insertInto("provider_connections").values({ workspace_id: workspaceId, provider: "github", external_connection_id: "other", workspace_login: "acme", account_type: "Organization", status: "suspended" }).returning("id").executeTakeFirstOrThrow();
    await db.updateTable("repositories").set({ provider_connection_id: other.id }).where("external_repository_id", "=", "101").execute();
    expect(await repositories.acceptRoutingDelivery(deliveryInput())).toEqual({ inserted: false, jobId: null });
    expect((await db.selectFrom("repositories").select("provider_connection_id").executeTakeFirstOrThrow()).provider_connection_id).toBe(other.id);
    await expectCounts(db, { webhook_receipts: 0, jobs: 1 });
  }));

  it.each([["99", "101", true], ["old", "101", false], [null, null, false], ["99", "other", false]] as const)("legacy routing dedup requires matching proven scope (%s, %s)", async (installation, repo, matches) => withPostgresTestDatabase(async db => {
    const workspaceId = await ensureLocalWorkspace(db);
    const repositories = createWorkspaceRepositories(db, workspaceId);
    await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
    const connectionRow = await db.selectFrom("provider_connections").select("id").executeTakeFirstOrThrow();
    const input = deliveryInput();
    await db.insertInto("jobs").values({ workspace_id: workspaceId, provider: "github", provider_connection_id: connectionRow.id, external_installation_id: installation, external_repository_id: repo, kind: "process_pull_request", idempotency_key: input.payload.routingKey, payload: input.payload }).execute();
    const result = await repositories.acceptRoutingDelivery(input);
    expect(result.inserted).toBe(true);
    expect(result.jobId === null).toBe(matches);
    expect(await db.selectFrom("jobs").select("id").where("kind", "=", "process_pull_request").execute()).toHaveLength(matches ? 1 : 2);
    expect((await db.selectFrom("queue_pull_work").select("desired_generation").executeTakeFirstOrThrow()).desired_generation).toBe(1);
  }));

  it("does not establish a connection from an ordinary delivery", async () => withPostgresTestDatabase(async db => {
    const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
    expect(await repositories.acceptRoutingDelivery(deliveryInput())).toEqual({ inserted: false, jobId: null });
    await expectCounts(db, { provider_connections: 0, repositories: 0, webhook_receipts: 0, jobs: 0 });
  }));

  it.each(["refresh_queue_pull", "process_pull_request"])("rolls back all effects when %s insertion fails", async kind => withPostgresTestDatabase(async db => {
    const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
    await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
    await sql`alter table jobs add constraint reject_injected_job check (kind <> ${sql.lit(kind)})`.execute(db);
    await expect(repositories.acceptRoutingDelivery(deliveryInput())).rejects.toThrow();
    await expectCounts(db, { provider_connections: 1, repositories: 1, webhook_receipts: 0, jobs: 0 });
    expect(await db.selectFrom("queue_pull_work").selectAll().execute()).toHaveLength(0);
  }));

  it("rolls back a routing job when a later policy job insertion fails", async () => withPostgresTestDatabase(async db => {
    const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
    await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
    await sql`alter table jobs add constraint reject_policy_job check (kind <> 'evaluate_human_review_policy')`.execute(db);
    const routing = deliveryInput();
    await expect(repositories.acceptPullRequestDelivery({ ...routing, invalidation: { externalInstallationId: "99", repository: routing.payload.changeRequest.repository, pullNumber: 7 }, routingPayload: routing.payload, policyPayload: humanReviewPolicyDeliveryInput().payload })).rejects.toThrow();
    await expectCounts(db, { provider_connections: 1, repositories: 1, webhook_receipts: 0, jobs: 0 });
    expect(await db.selectFrom("queue_pull_work").selectAll().execute()).toHaveLength(0);
  }));

  it("keeps one invalidation for duplicate deliveries and preserves routing and policy effects", async () => withPostgresTestDatabase(async db => {
    const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
    await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
    await repositories.acceptRoutingDelivery(deliveryInput());
    await repositories.acceptRoutingDelivery(deliveryInput());
    expect((await db.selectFrom("queue_pull_work").select("desired_generation").executeTakeFirstOrThrow()).desired_generation).toBe(1);
    await repositories.acceptHumanReviewPolicyDelivery(humanReviewPolicyDeliveryInput());
    expect((await db.selectFrom("queue_pull_work").select("desired_generation").executeTakeFirstOrThrow()).desired_generation).toBe(2);
    expect((await db.selectFrom("jobs").select("kind").execute()).map(row => row.kind).sort()).toEqual(["evaluate_human_review_policy", "process_pull_request", "refresh_queue_pull"]);
  }));

  it("rejects a delayed event after installation replacement", async () => withPostgresTestDatabase(async db => {
    const workspaceId = await ensureLocalWorkspace(db);
    const repositories = createWorkspaceRepositories(db, workspaceId);
    await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
    const old = deliveryInput();
    await repositories.acceptRoutingDelivery(old);
    await db.updateTable("provider_connections").set({ external_connection_id: "replacement" }).where("workspace_id", "=", workspaceId).execute();
    const result = await repositories.acceptRoutingDelivery({ ...old, deliveryId: "delayed", payload: { ...old.payload, deliveryId: "delayed" } });
    expect(result).toEqual({ inserted: false, jobId: null });
    expect((await db.selectFrom("provider_connections").select("external_connection_id").executeTakeFirstOrThrow()).external_connection_id).toBe("replacement");
  }));

  it("creates one receipt and job for concurrent duplicate deliveries", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
      const input = deliveryInput();

      const results = await Promise.all([
        repositories.acceptRoutingDelivery(input),
        repositories.acceptRoutingDelivery(input),
      ]);

      expect(results.map((result) => result.inserted).sort()).toEqual([false, true]);
      expect(results.filter((result) => result.jobId !== null)).toHaveLength(1);
      await expectCounts(db, {
        webhook_receipts: 1,
        jobs: 2,
        provider_connections: 1,
        repositories: 1,
      });
      await expect(
        db.selectFrom("webhook_receipts").select(["event_action", "hook_id"]).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ event_action: "opened", hook_id: "hook-1" });
    });
  });

  it("records distinct deliveries for one change-request state but queues only one routing job", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
      const first = deliveryInput();
      const second = {
        ...deliveryInput(),
        deliveryId: "delivery-2",
        payload: { ...first.payload, deliveryId: "delivery-2" },
      };

      const results = await Promise.all([
        repositories.acceptRoutingDelivery(first),
        repositories.acceptRoutingDelivery(second),
      ]);
      expect(results.map((result) => result.inserted)).toEqual([true, true]);
      expect(results.filter((result) => result.jobId !== null)).toHaveLength(1);
      await expectCounts(db, { webhook_receipts: 2, jobs: 2, provider_connections: 1, repositories: 1 });
    });
  });

  it("rolls back the receipt and projection when job insertion fails", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
      await sql`alter table jobs add constraint reject_routing_job check (kind <> 'process_pull_request')`.execute(db);

      await expect(repositories.acceptRoutingDelivery(deliveryInput())).rejects.toThrow();

      await expectCounts(db, { webhook_receipts: 0, jobs: 0, provider_connections: 1, repositories: 1 });
    });
  });

  it("rejects a repository whose provider differs from its connection", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
      const input = deliveryInput();

      await expect(repositories.acceptRoutingDelivery({
        ...input,
        repository: { ...input.repository, provider: "gitlab" },
      })).rejects.toThrow("delivery scope mismatch");

      await expectCounts(db, {
        webhook_receipts: 0,
        jobs: 0,
        provider_connections: 1,
        repositories: 1,
      });
    });
  });

  it("creates one receipt and policy-evaluation job for concurrent duplicate review deliveries", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.replaceProviderConnectionRepositories({ ...connection("99", "acme"), repositories: [repository("101", "api")] });
      const input = humanReviewPolicyDeliveryInput();

      const results = await Promise.all([
        repositories.acceptHumanReviewPolicyDelivery(input),
        repositories.acceptHumanReviewPolicyDelivery(input),
      ]);

      expect(results.map((result) => result.inserted).sort()).toEqual([false, true]);
      expect(results.filter((result) => result.jobId !== null)).toHaveLength(1);
      await expect(
        db.selectFrom("jobs").select(["kind", "idempotency_key"]).where("kind", "=", "evaluate_human_review_policy").executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        kind: "evaluate_human_review_policy",
        idempotency_key: expect.stringContaining("delivery-review-1"),
      });
    });
  });

  it("replaces and incrementally updates the selected repository projection", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.upsertConfiguredProviderConnection({
        ...connection("99", "acme"),
        repositories: [repository("101", "api"), repository("102", "web")],
      });
      await repositories.replaceProviderConnectionRepositories({
        ...connection("99", "ACME"),
        repositories: [repository("102", "frontend")],
      });
      await repositories.updateProviderConnectionRepositories({
        ...connection("99", "acme"),
        repositoriesAdded: [repository("103", "docs")],
        repositoryIdsRemoved: ["102"],
      });

      await expect(db.selectFrom("provider_connections")
        .select(["external_connection_id", "workspace_login", "account_type", "status"])
        .execute()).resolves.toEqual([{
        external_connection_id: "99",
        workspace_login: "acme",
        account_type: "Organization",
        status: "active",
      }]);
      await expect(db.selectFrom("repositories")
        .select(["external_repository_id", "owner", "name"])
        .orderBy("external_repository_id")
        .execute()).resolves.toEqual([{ external_repository_id: "103", owner: "acme", name: "docs" }]);
    });
  });

  it("preserves repositories when a suspended provider connection is reactivated without a snapshot", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.upsertConfiguredProviderConnection({
        ...connection("99", "acme"),
        repositories: [repository("101", "api")],
      });
      await repositories.suspendConfiguredProviderConnection(connection("99", "acme"));
      await repositories.activateConfiguredProviderConnection(connection("99", "ACME"));

      await expect(db.selectFrom("provider_connections")
        .select(["external_connection_id", "workspace_login", "status"])
        .executeTakeFirstOrThrow()).resolves.toEqual({
        external_connection_id: "99",
        workspace_login: "ACME",
        status: "active",
      });
      await expect(db.selectFrom("repositories").select(["external_repository_id", "name"]).execute())
        .resolves.toEqual([{ external_repository_id: "101", name: "api" }]);
    });
  });

  it("ignores a delayed incremental event for a replaced external connection ID", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.upsertConfiguredProviderConnection({
        ...connection("99", "acme"),
        repositories: [repository("101", "old")],
      });
      await repositories.replaceProviderConnectionRepositories({
        ...connection("100", "acme"),
        repositories: [repository("200", "current")],
      });
      await repositories.updateProviderConnectionRepositories({
        ...connection("99", "acme"),
        repositoriesAdded: [repository("103", "stale-added")],
        repositoryIdsRemoved: ["200"],
      });

      await expect(db.selectFrom("provider_connections")
        .select(["external_connection_id", "workspace_login", "status"])
        .execute()).resolves.toEqual([{ external_connection_id: "100", workspace_login: "acme", status: "active" }]);
      await expect(db.selectFrom("repositories").select(["external_repository_id", "name"]).execute())
        .resolves.toEqual([{ external_repository_id: "200", name: "current" }]);
    });
  });

  it("suspends then durably revokes a provider connection before deferred cleanup", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.upsertConfiguredProviderConnection({
        ...connection("99", "acme"),
        repositories: [repository("101", "api")],
      });

      await repositories.suspendConfiguredProviderConnection(connection("99", "acme"));
      await expect(db.selectFrom("provider_connections").select("status").executeTakeFirstOrThrow())
        .resolves.toEqual({ status: "suspended" });

      await repositories.revokeConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" });
      await expect(db.selectFrom("provider_connections")
        .select("status").executeTakeFirstOrThrow()).resolves.toEqual({ status: "revoked" });
      await expectCounts(db, { provider_connections: 1, repositories: 1 });
      await expect(db.selectFrom("provider_connection_revocations")
        .select(["external_connection_id", "cleanup_completed_at"])
        .executeTakeFirstOrThrow()).resolves.toEqual({
        external_connection_id: "99",
        cleanup_completed_at: null,
      });

      await repositories.activateConfiguredProviderConnection(connection("99", "stale-unsuspend"));
      await repositories.suspendConfiguredProviderConnection(connection("99", "stale-suspend"));
      await expect(db.selectFrom("provider_connections")
        .select(["workspace_login", "status"]).executeTakeFirstOrThrow()).resolves.toEqual({
        workspace_login: "acme",
        status: "revoked",
      });
    });
  });

  it("keeps installation creation fail closed when deletion arrives first", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));

      await repositories.revokeConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" });

      await expect(db.selectFrom("provider_connection_revocations")
        .select(["external_connection_id", "revoked_connection_id", "cleanup_completed_at"])
        .execute()).resolves.toEqual([{
        external_connection_id: "99",
        revoked_connection_id: expect.any(String),
        cleanup_completed_at: null,
      }]);
      await expect(db.selectFrom("provider_connection_revocations")
        .select("physical_connection_id").executeTakeFirstOrThrow()).resolves.toEqual({
        physical_connection_id: null,
      });

      await repositories.replaceProviderConnectionRepositories({
        ...connection("99", "delayed-create"),
        repositories: [repository("101", "api")],
      });
      await expectCounts(db, { provider_connections: 0, repositories: 0 });
    });
  });

  it("fails closed for a reused external ID and preserves a reconnect with a new external ID", async () => {
    await withPostgresTestDatabase(async (db) => {
      const repositories = createWorkspaceRepositories(db, await ensureLocalWorkspace(db));
      await repositories.upsertConfiguredProviderConnection({
        ...connection("99", "old-generation"),
        repositories: [repository("101", "old-api")],
      });
      const oldConnection = await db.selectFrom("provider_connections").select("id").executeTakeFirstOrThrow();
      await repositories.jobs.enqueue({
        provider: "github",
        providerConnectionId: oldConnection.id,
        kind: "process_pull_request",
        payload: { staleGeneration: true },
        idempotencyKey: "stale-generation-job",
        runAt: new Date("2100-01-01T00:00:00.000Z"),
      });
      await repositories.revokeConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" });

      await repositories.replaceProviderConnectionRepositories({
        ...connection("99", "new-generation"),
        repositories: [repository("201", "new-api")],
      });

      await expect(db.selectFrom("provider_connections")
        .select(["id", "workspace_login", "status"]).execute()).resolves.toEqual([
        { id: oldConnection.id, workspace_login: "old-generation", status: "revoked" },
      ]);
      await expect(db.selectFrom("repositories")
        .select("external_repository_id").execute()).resolves.toEqual([
        { external_repository_id: "101" },
      ]);

      await repositories.replaceProviderConnectionRepositories({
        ...connection("100", "new-generation"),
        repositories: [repository("201", "new-api")],
      });
      const newConnection = await db.selectFrom("provider_connections").select("id")
        .where("external_connection_id", "=", "100").executeTakeFirstOrThrow();
      expect(newConnection.id).not.toBe(oldConnection.id);

      await expect(db.selectFrom("provider_connections")
        .select(["id", "workspace_login", "status"])
        .orderBy("external_connection_id", "desc").execute()).resolves.toEqual([
        { id: oldConnection.id, workspace_login: "old-generation", status: "revoked" },
        { id: newConnection.id, workspace_login: "new-generation", status: "active" },
      ]);
      await expect(repositories.cleanupRevokedProviderConnections(new Date("2100-01-01T00:00:00.000Z")))
        .resolves.toBe(0);
      await db.updateTable("jobs").set({ status: "failed" })
        .where("provider_connection_id", "=", oldConnection.id).execute();
      await expect(repositories.cleanupRevokedProviderConnections(new Date("2100-01-01T00:00:00.000Z")))
        .resolves.toBe(1);
      await expect(repositories.cleanupRevokedProviderConnections(new Date("2100-01-01T00:00:00.000Z")))
        .resolves.toBe(0);
      await repositories.activateConfiguredProviderConnection(connection("99", "late-stale-created"));
      await expect(db.selectFrom("provider_connections")
        .select(["id", "workspace_login", "status"]).execute()).resolves.toEqual([
        { id: newConnection.id, workspace_login: "new-generation", status: "active" },
      ]);
      await expect(db.selectFrom("repositories")
        .select(["provider_connection_id", "external_repository_id"]).execute()).resolves.toEqual([
        { provider_connection_id: newConnection.id, external_repository_id: "201" },
      ]);
      await expect(db.selectFrom("provider_connection_revocations")
        .select("cleanup_completed_at").executeTakeFirstOrThrow()).resolves.toEqual({
        cleanup_completed_at: expect.any(Date),
      });
    });
  });
});

function deliveryInput() {
  return {
    deliveryId: "delivery-1",
    eventName: "pull_request",
    eventAction: "opened",
    hookId: "hook-1",
    connection: connection("99", "acme"),
    repository: repository("101", "api"),
    payload: {
      kind: "process_change_request" as const,
      deliveryId: "delivery-1",
      eventName: "change_request.opened",
      changeRequest: {
        repository: { provider: "github" as const, externalId: "101", owner: "acme", name: "api" },
        externalId: "7",
        number: 7,
        baseRevision: "base-123",
        headRevision: "abc123",
      },
      isDraft: false,
      routingKey: "routing:workspace:github:101:7:base-123:abc123",
    },
  };
}

function humanReviewPolicyDeliveryInput() {
  return {
    deliveryId: "delivery-review-1",
    eventName: "pull_request_review",
    connection: connection("99", "acme"),
    repository: repository("101", "api"),
    payload: {
      kind: "evaluate_human_review_policy" as const,
      deliveryId: "delivery-review-1",
      changeRequest: {
        repository: { provider: "github" as const, externalId: "101", owner: "acme", name: "api" },
        externalId: "7",
        number: 7,
      },
    },
  };
}

function connection(externalConnectionId: string, workspaceLogin: string) {
  return { provider: "github" as const, externalConnectionId, workspaceLogin, accountType: "Organization" };
}

function repository(externalRepositoryId: string, name: string) {
  return { provider: "github" as const, externalRepositoryId, owner: "acme", name };
}

async function expectCounts(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  expected: Partial<Record<"webhook_receipts" | "jobs" | "provider_connections" | "repositories", number>>,
) {
  for (const [table, count] of Object.entries(expected)) {
    const result = await sql<{ count: string }>`select count(*)::text as count from ${sql.table(table)}`.execute(db);
    expect(Number(result.rows[0]?.count)).toBe(count);
  }
}

async function replayOne(db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]) {
  const job = await createJobClaimer(db).claimNext("worker", new Date());
  if (!job || !job.lockedAt || !job.lockedBy) throw new Error("no deferred job claimed");
  expect(job.kind).toBe("replay_deferred_delivery");
  return replayDeferredPullRequestDelivery(db, { jobId: job.id, workspaceId: job.workspaceId, provider: job.provider, providerConnectionId: job.providerConnectionId, lockedAt: job.lockedAt, lockedBy: job.lockedBy, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts });
}
