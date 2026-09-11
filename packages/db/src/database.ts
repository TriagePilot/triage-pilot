import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

import type { Database } from "./kysely.js";

export function createDatabase(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: databaseUrl }),
    }),
  });
}
