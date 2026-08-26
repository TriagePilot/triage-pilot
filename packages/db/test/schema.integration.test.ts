import { readFile } from "node:fs/promises";
import pg from "pg";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../src";
import { withPostgresTestDatabase, withPostgresTestDatabaseUrl } from "./postgres";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("reduced schema", () => {
  it("contains only the reduced operational tables", async () => {
    await withPostgresTestDatabase(async (db) => {
      const result = await sql<{ table_name: string }>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name
      `.execute(db);
      expect(result.rows.map((row) => row.table_name)).toEqual([
        "installations",
        "jobs",
        "repositories",
        "routing_decisions",
        "schema_migrations",
        "webhook_receipts",
        "worker_heartbeat",
      ]);
      const repositories = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_name = 'repositories'
        order by ordinal_position
      `.execute(db);
      expect(repositories.rows.map((row) => row.column_name)).toEqual([
        "id",
        "installation_id",
        "github_repository_id",
        "owner",
        "name",
        "default_branch",
        "config_state",
        "created_at",
        "updated_at",
        "last_config_mode",
      ]);
      const decision = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_name = 'routing_decisions'
      `.execute(db);
      expect(decision.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining([
          "mode",
          "action_status",
          "action_error",
          "action_applied_at",
          "action_failed_at",
          "selected_reviewers",
          "pull_number",
          "head_sha",
          "routing_key",
          "policy_check_run_id",
          "policy_check_state",
        ]),
      );
      const migrations = await sql<{ name: string }>`select name from schema_migrations order by name`.execute(db);
      expect(migrations.rows).toEqual([
        { name: "0001_initial.sql" },
        { name: "0002_selected_reviewers.sql" },
        { name: "0003_human_review_policy.sql" },
        { name: "0004_semantic_routing_deduplication.sql" },
      ]);
    });
  });

  it("backfills the plural reviewer list and enforces the two-reviewer database cap", async () => {
    await withPostgresTestDatabaseUrl(async (databaseUrl) => {
      const setup = new pg.Pool({ connectionString: databaseUrl });
      const initialMigration = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
      await setup.query(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await setup.query(initialMigration);
      await setup.query("insert into schema_migrations (name) values ('0001_initial.sql')");
      await setup.query(`
        insert into routing_decisions (
          delivery_id, action, risk_score, selected_reviewer, details
        ) values ('legacy-delivery', 'request_human_review', 50, '@user-1f9c4a', '{}')
      `);
      await setup.end();

      await runMigrations(databaseUrl);

      const verification = new pg.Pool({ connectionString: databaseUrl });
      await expect(
        verification.query<{ selected_reviewers: string[] }>(
          "select selected_reviewers from routing_decisions where delivery_id = 'legacy-delivery'",
        ),
      ).resolves.toMatchObject({ rows: [{ selected_reviewers: ["@user-1f9c4a"] }] });
      await expect(
        verification.query(
          "update routing_decisions set selected_reviewers = $1::jsonb where delivery_id = 'legacy-delivery'",
          [JSON.stringify(["@one", "@two", "@three"])],
        ),
      ).rejects.toMatchObject({ constraint: "routing_decisions_selected_reviewers_limit" });
      await verification.end();
    });
  });
});
