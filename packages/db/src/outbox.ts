import { isDeepStrictEqual } from "node:util";
import type { Kysely, Selectable, Transaction } from "kysely";
import type { PlatformEventSink, PlatformEventV1, WorkspaceId } from "@triagepilot/contracts";

import { buildNextRunAt } from "./jobs.js";
import type { Database, DecisionOutboxTable } from "./kysely.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;
const PLATFORM_OUTBOX_LEASE_MS = 15 * 60 * 1000;

export interface PlatformOutboxRecord {
  id: string;
  workspaceId: WorkspaceId;
  decisionId: string | null;
  reviewerReplacementId: string | null;
  eventId: string;
  eventType: PlatformEventV1["eventType"];
  schemaVersion: number;
  payload: PlatformEventV1;
  occurredAt: Date;
  availableAt: Date;
  publishedAt: Date | null;
  attemptCount: number;
  lastError: string | null;
}

export interface PlatformOutboxRepository {
  claim(input: { limit: number; now: Date }): Promise<PlatformOutboxRecord[]>;
  markPublished(input: { id: string; attemptCount: number; now: Date }): Promise<boolean>;
  markFailed(input: { id: string; attemptCount: number; error: unknown; now: Date }): Promise<boolean>;
  listUnpublished(): Promise<PlatformOutboxRecord[]>;
}

export async function stagePlatformEvent(
  db: DatabaseExecutor,
  workspaceId: WorkspaceId,
  sourceId: string,
  event: PlatformEventV1,
): Promise<void> {
  if (db.isTransaction) {
    await stagePlatformEventInTransaction(db, workspaceId, sourceId, event);
    return;
  }

  await db.transaction().execute(async (trx) => {
    await stagePlatformEventInTransaction(trx, workspaceId, sourceId, event);
  });
}

async function stagePlatformEventInTransaction(
  db: DatabaseExecutor,
  workspaceId: WorkspaceId,
  sourceId: string,
  event: PlatformEventV1,
): Promise<void> {
  if (event.workspaceId !== workspaceId) throw new Error("platform event workspace does not match persistence scope");
  if (event.eventType === "routing_decision" && event.decisionId !== sourceId) {
    throw new Error("platform event decision id does not match persisted decision");
  }
  if (event.eventType === "reviewer_replacement") {
    const replacement = await db
      .selectFrom("reviewer_replacements")
      .select([
        "provider",
        "provider_connection_id",
        "absence_id",
        "absence_revision",
        "decision_id",
        "unavailable_actor_id",
        "replacement_actor_id",
        "outcome",
      ])
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", sourceId)
      .forUpdate()
      .executeTakeFirst();
    if (
      replacement === undefined
      || replacement.provider !== event.provider
      || replacement.provider_connection_id !== event.providerConnectionId
      || replacement.absence_id !== event.absenceId
      || replacement.absence_revision !== event.absenceRevision
      || replacement.decision_id !== event.decisionId
      || replacement.unavailable_actor_id !== event.unavailableActor
      || replacement.replacement_actor_id !== event.replacementActor
      || replacement.outcome !== event.outcome
    ) {
      throw new Error("reviewer replacement event does not match persisted source");
    }
  }

  const source = event.eventType === "routing_decision"
    ? { decision_id: sourceId, reviewer_replacement_id: null }
    : { decision_id: null, reviewer_replacement_id: sourceId };

  const inserted = await db
    .insertInto("decision_outbox")
    .values({
      workspace_id: workspaceId,
      ...source,
      event_id: event.eventId,
      event_type: event.eventType,
      schema_version: event.schemaVersion,
      payload: event,
      occurred_at: event.occurredAt,
      available_at: event.occurredAt,
    })
    .onConflict((conflict) =>
      conflict.columns(["workspace_id", "event_id"]).doNothing(),
    )
    .returning("id")
    .executeTakeFirst();
  if (inserted !== undefined) return;

  const existing = await db
    .selectFrom("decision_outbox")
    .select([
      "decision_id",
      "reviewer_replacement_id",
      "event_type",
      "schema_version",
      "payload",
      "occurred_at",
    ])
    .where("workspace_id", "=", workspaceId)
    .where("event_id", "=", event.eventId)
    .forUpdate()
    .executeTakeFirst();
  if (
    existing === undefined
    || existing.decision_id !== source.decision_id
    || existing.reviewer_replacement_id !== source.reviewer_replacement_id
    || existing.event_type !== event.eventType
    || existing.schema_version !== event.schemaVersion
    || existing.occurred_at.getTime() !== new Date(event.occurredAt).getTime()
    || !isDeepStrictEqual(existing.payload, event)
  ) {
    throw new Error("platform event id conflicts with a different persisted event");
  }
}

export async function claimPlatformEvents(input: {
  db: Kysely<Database>;
  workspaceId: WorkspaceId;
  limit: number;
  now?: Date;
}): Promise<PlatformOutboxRecord[]> {
  return await createPlatformOutboxRepository(input.db, input.workspaceId).claim({
    limit: input.limit,
    now: input.now ?? new Date(),
  });
}

export async function markPlatformEventPublished(input: {
  db: Kysely<Database>;
  workspaceId: WorkspaceId;
  id: string;
  attemptCount: number;
  now?: Date;
}): Promise<boolean> {
  return await createPlatformOutboxRepository(input.db, input.workspaceId).markPublished({
    id: input.id,
    attemptCount: input.attemptCount,
    now: input.now ?? new Date(),
  });
}

export function createPlatformOutboxRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): PlatformOutboxRepository {
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

        const claimed: PlatformOutboxRecord[] = [];
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
          if (updated) claimed.push(toPlatformOutboxRecord(updated));
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
      return rows.map(toPlatformOutboxRecord);
    },
  };
}

export async function publishPlatformOutbox(input: {
  repository: PlatformOutboxRepository;
  sink: PlatformEventSink;
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

function toPlatformOutboxRecord(row: Selectable<DecisionOutboxTable>): PlatformOutboxRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    decisionId: row.decision_id,
    reviewerReplacementId: row.reviewer_replacement_id,
    eventId: row.event_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    payload: row.payload as PlatformEventV1,
    occurredAt: row.occurred_at,
    availableAt: row.available_at,
    publishedAt: row.published_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
  };
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 1_000) || "platform event sink failed";
}

function buildLeaseExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PLATFORM_OUTBOX_LEASE_MS);
}
