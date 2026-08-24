import type { Kysely } from "kysely";

import type { Database } from "./kysely";

export interface WorkerHeartbeat {
  workerId: string;
  heartbeatAt: Date;
}

export async function updateWorkerHeartbeat(
  db: Kysely<Database>,
  input: { workerId: string; now: Date },
): Promise<void> {
  await db
    .insertInto("worker_heartbeat")
    .values({ worker_id: input.workerId, heartbeat_at: input.now })
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({ worker_id: input.workerId, heartbeat_at: input.now }),
    )
    .execute();
}

export async function readWorkerHeartbeat(db: Kysely<Database>): Promise<WorkerHeartbeat | null> {
  const row = await db.selectFrom("worker_heartbeat").select(["worker_id", "heartbeat_at"]).executeTakeFirst();
  return row ? { workerId: row.worker_id, heartbeatAt: row.heartbeat_at } : null;
}
