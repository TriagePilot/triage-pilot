import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { ensureLocalWorkspace, runMigrations } from "../src";
import { withPostgresTestDatabase, withPostgresTestDatabaseUrl } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("workspace schema", () => {
  it("upgrades the previous release into one persisted self-hosted workspace", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      const setup = new pg.Pool({ connectionString: databaseUrl });
      await setup.query(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      for (const name of [
        "0001_initial.sql",
        "0002_selected_reviewers.sql",
        "0003_human_review_policy.sql",
        "0004_semantic_routing_deduplication.sql",
      ]) {
        await setup.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
        await setup.query("insert into schema_migrations (name) values ($1)", [name]);
      }

      const connection = await setup.query<{ id: string }>(`
        insert into installations (
          github_installation_id, account_login, account_type, status, permissions
        ) values (99, 'acme', 'Organization', 'active', '{}') returning id
      `);
      const repository = await setup.query<{ id: string }>(`
        insert into repositories (
          installation_id, github_repository_id, owner, name, default_branch, config_state
        ) values ($1, 200, 'acme', 'api', 'main', 'valid') returning id
      `, [connection.rows[0]!.id]);
      await setup.query(`
        insert into webhook_receipts (delivery_id, event_name, installation_id)
        values ('delivery-1', 'pull_request', 99)
      `);
      await setup.query(`
        insert into jobs (kind, payload, idempotency_key)
        values (
          'process_pull_request',
          '{"providerConnectionId":"99","changeRequest":{"repository":{"provider":"github"}}}',
          'job-1'
        )
      `);
      await setup.query(`
        insert into routing_decisions (
          repository_id, delivery_id, routing_key, action, risk_score, details
        ) values ($1, 'delivery-1', 'routing-1', 'policy_approval', 5, '{"legacy":true}')
      `, [repository.rows[0]!.id]);
      await setup.end();

      await runMigrations(databaseUrl);

      const verification = new pg.Pool({ connectionString: databaseUrl });
      const workspaces = await verification.query<{ id: string; external_key: string }>(
        "select id, external_key from workspaces",
      );
      expect(workspaces.rows).toHaveLength(1);
      expect(workspaces.rows[0]).toMatchObject({ external_key: "self-hosted" });
      expect(workspaces.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);

      await expect(verification.query(`
        select
          workspace_id, provider, external_connection_id, workspace_login
        from provider_connections
      `)).resolves.toMatchObject({
        rows: [{
          workspace_id: workspaces.rows[0]!.id,
          provider: "github",
          external_connection_id: "99",
          workspace_login: "acme",
        }],
      });
      await expect(verification.query(`
        select workspace_id, provider, external_repository_id, provider_connection_id
        from repositories
      `)).resolves.toMatchObject({
        rows: [{
          workspace_id: workspaces.rows[0]!.id,
          provider: "github",
          external_repository_id: "200",
          provider_connection_id: connection.rows[0]!.id,
        }],
      });
      await expect(verification.query(`
        select workspace_id, provider, external_connection_id from webhook_receipts
      `)).resolves.toMatchObject({
        rows: [{ workspace_id: workspaces.rows[0]!.id, provider: "github", external_connection_id: "99" }],
      });
      await expect(verification.query(`
        select workspace_id, provider, provider_connection_id from jobs
      `)).resolves.toMatchObject({
        rows: [{ workspace_id: workspaces.rows[0]!.id, provider: "github", provider_connection_id: connection.rows[0]!.id }],
      });
      await expect(verification.query(`
        select workspace_id, effective_config_hash, inheritance_mode, config_diagnostics, config_sources
        from routing_decisions
      `)).resolves.toMatchObject({
        rows: [{
          workspace_id: workspaces.rows[0]!.id,
          effective_config_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          inheritance_mode: "legacy",
          config_diagnostics: [],
          config_sources: {},
        }],
      });
      await verification.end();
    });
  });

  it("reuses the opaque local workspace identity", async () => {
    await withPostgresTestDatabase(async (db) => {
      const first = await ensureLocalWorkspace(db);
      const second = await ensureLocalWorkspace(db);

      expect(second).toBe(first);
      expect(first).not.toBe("self-hosted");
      await expect(
        db.selectFrom("workspaces").select(["id", "external_key"]).execute(),
      ).resolves.toEqual([{ id: first, external_key: "self-hosted" }]);
    });
  });
});
