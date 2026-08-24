import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";

import { createDatabase, runMigrations } from "../src";
import type { Database } from "../src";

export async function withPostgresTestDatabase(run: (db: Kysely<Database>) => Promise<void>): Promise<void> {
  await withPostgresTestDatabaseUrl(async (databaseUrl) => {
    await runMigrations(databaseUrl);
    const db = createDatabase(databaseUrl);
    try {
      await run(db);
    } finally {
      await db.destroy();
    }
  });
}

export async function withPostgresTestDatabaseUrl(run: (databaseUrl: string) => Promise<void>): Promise<void> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL is required");
  const name = `triagepilot_test_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(base);
  testUrl.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  await admin.query(`create database "${name}"`);
  try {
    await run(testUrl.toString());
  } finally {
    const closedGracefully = await waitForDatabaseConnectionsToClose(admin, name);
    if (!closedGracefully) {
      await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [name]);
      await waitForDatabaseConnectionsToClose(admin, name);
    }
    await admin.query(`drop database if exists "${name}"`);
    await admin.end();
  }
}

async function waitForDatabaseConnectionsToClose(admin: pg.Pool, databaseName: string): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const result = await admin.query<{ connected: boolean }>(
      "select exists(select 1 from pg_stat_activity where datname = $1) as connected",
      [databaseName],
    );
    if (!result.rows[0]?.connected) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
