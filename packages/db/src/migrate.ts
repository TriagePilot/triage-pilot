import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const migrationDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
    const files = (await fs.readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const existing = await client.query("select name from schema_migrations where name = $1", [file]);
      if (existing.rowCount && existing.rowCount > 0) continue;

      const sql = await fs.readFile(path.join(migrationDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        console.log(`applied: ${file}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await runMigrations(databaseUrl);
}
