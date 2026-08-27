import type { Kysely, Selectable, Transaction } from "kysely";
import type { DecisionEventSink, DecisionEventV1, WorkspaceId } from "@triagepilot/contracts";

import { buildNextRunAt } from "./jobs";
import type { Database, DecisionOutboxTable } from "./kysely";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;
const DECISION_OUTBOX_LEASE_MS = 15 * 60 * 1000;

export interface DecisionOutboxRecord {
  id: string;
  workspaceId: WorkspaceId;
  decisionId: string;
  schemaVersion: number;
  payload: DecisionEventV1;
  occurredAt: Date;
  availableAt: Date;
  publishedAt: Date | null;
  attemptCount: number;
  lastError: string | null;
}

export interface DecisionOutboxRepository {
  claim(input: { limit: number; now: Date }): Promise<DecisionOutboxRecord[]>;
  markPublished(input: { id: string; attemptCount: number; now: Date }): Promise<boolean>;
  markFailed(input: { id: string; attemptCount: number; error: unknown; now: Date }): Promise<boolean>;
  listUnpublished(): Promise<DecisionOutboxRecord[]>;
}

export async function stageDecisionEvent(
  db: DatabaseExecutor,
  workspaceId: WorkspaceId,
  decisionId: string,
  event: DecisionEventV1,
): Promise<void> {
  if (event.workspaceId !== workspaceId) throw new Error("decision event workspace does not match persistence scope");
  if (event.decisionId !== decisionId) throw new Error("decision event id does not match persisted decision");

  await db
    .insertInto("decision_outbox")
    .values({
      workspace_id: workspaceId,
      decision_id: decisionId,
      schema_version: event.schemaVersion,
      payload: event,
      occurred_at: event.occurredAt,
      available_at: event.occurredAt,
    })
    .onConflict((conflict) =>
      conflict.columns(["workspace_id", "decision_id", "schema_version"]).doNothing(),
    )
    .execute();
}

export async function claimDecisionEvents(input: {
  db: Kysely<Database>;
  workspaceId: WorkspaceId;
  limit: number;
  now?: Date;
}): Promise<DecisionOutboxRecord[]> {
  return await createDecisionOutboxRepository(input.db, input.workspaceId).claim({
    limit: input.limit,
    now: input.now ?? new Date(),
  });
}

export async function markDecisionEventPublished(input: {
  db: Kysely<Database>;
  workspaceId: WorkspaceId;
  id: string;
  attemptCount: number;
  now?: Date;
}): Promise<boolean> {
  return await createDecisionOutboxRepository(input.db, input.workspaceId).markPublished({
    id: input.id,
    attemptCount: input.attemptCount,
    now: input.now ?? new Date(),
  });
}

export function createDecisionOutboxRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): DecisionOutboxRepository {
  return {
    async claim(input) {
      if (input.limit <= 0) return [];

      return await db.transaction().execute(async (trx) => {
        const candidates = await trx
          .selectFrom("decision_outbox")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("published_at", "is", null)
          .where("available_at", "<=", input.now)
          .orderBy("available_at", "asc")
          .orderBy("occurred_at", "asc")
          .orderBy("id", "asc")
          .limit(input.limit)
          .forUpdate()
          .skipLocked()
          .execute();

        const claimed: DecisionOutboxRecord[] = [];
        for (const candidate of candidates) {
          const nextAttemptCount = candidate.attempt_count + 1;
          const updated = await trx
            .updateTable("decision_outbox")
            .set({
              attempt_count: nextAttemptCount,
              available_at: buildLeaseExpiresAt(input.now),
            })
            .where("workspace_id", "=", workspaceId)
            .where("id", "=", candidate.id)
            .where("published_at", "is", null)
            .returningAll()
            .executeTakeFirst();
          if (updated) claimed.push(toDecisionOutboxRecord(updated));
        }
        return claimed;
      });
    },

    async markPublished(input) {
      const updated = await db
        .updateTable("decision_outbox")
        .set({ published_at: input.now, last_error: null })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", input.id)
        .where("attempt_count", "=", input.attemptCount)
        .where("published_at", "is", null)
        .returning("id")
        .execute();
      return updated.length > 0;
    },

    async markFailed(input) {
      const updated = await db
        .updateTable("decision_outbox")
        .set({
          last_error: sanitizeError(input.error),
          available_at: buildNextRunAt(input.now, input.attemptCount),
        })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", input.id)
        .where("attempt_count", "=", input.attemptCount)
        .where("published_at", "is", null)
        .returning("id")
        .execute();
      return updated.length > 0;
    },

    async listUnpublished() {
      const rows = await db
        .selectFrom("decision_outbox")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("published_at", "is", null)
        .orderBy("occurred_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(toDecisionOutboxRecord);
    },
  };
}

export async function publishDecisionOutbox(input: {
  repository: DecisionOutboxRepository;
  sink: DecisionEventSink;
  limit: number;
  now?: Date;
}): Promise<{ published: number }> {
  const now = input.now ?? new Date();
  const events = await input.repository.claim({ limit: input.limit, now });
  let published = 0;

  for (const event of events) {
    try {
      await input.sink.emit(event.payload);
      if (await input.repository.markPublished({ id: event.id, attemptCount: event.attemptCount, now })) {
        published += 1;
      }
    } catch (error) {
      await input.repository.markFailed({
        id: event.id,
        attemptCount: event.attemptCount,
        error,
        now,
      });
      throw error;
    }
  }

  return { published };
}

function toDecisionOutboxRecord(row: Selectable<DecisionOutboxTable>): DecisionOutboxRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    decisionId: row.decision_id,
    schemaVersion: row.schema_version,
    payload: row.payload as DecisionEventV1,
    occurredAt: row.occurred_at,
    availableAt: row.available_at,
    publishedAt: row.published_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
  };
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 1_000) || "decision event sink failed";
}

function buildLeaseExpiresAt(now: Date): Date {
  return new Date(now.getTime() + DECISION_OUTBOX_LEASE_MS);
}
