import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { ProviderKind, ReviewerReplacementEventV1 } from "@triagepilot/contracts";

import {
  applyFixedRetention,
  ProviderConnectionUnavailableError,
  ReviewerAbsenceRevisionError,
  ReviewerAvailabilityValidationError,
  createWorkspaceReviewerAvailability,
  createJobClaimer,
  createWorkspaceJobQueue,
  persistDecision,
  recoverStaleJobs,
} from "../src";
import { withPostgresTestDatabase } from "./postgres";

const now = new Date("2026-09-01T12:00:00.000Z");
const unavailableActor = "Actor:Unavailable/Case";
const replacementActor = "9007199254740993";
const alternateReplacementActor = "Actor:Alternate/73";
const changeRequestId = "change:Request/A17";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("workspace reviewer availability", () => {
  it("atomically audits ordinary-scope intents and fails only the exact claimed lease", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-ordinary-exhaustion");
      const claimer = createJobClaimer(db);
      const queue = createWorkspaceJobQueue(db, fixture.scope.workspaceId);
      const claimed = await claimer.claimNext("worker-exact", now);
      expect(claimed).not.toBeNull();
      const lease = {
        jobId: claimed!.id,
        workspaceId: claimed!.workspaceId,
        provider: claimed!.provider,
        providerConnectionId: claimed!.providerConnectionId,
        lockedBy: claimed!.lockedBy!,
        attemptCount: claimed!.attemptCount,
        maxAttempts: claimed!.maxAttempts,
      };

      await expect(queue.exhaustReviewerAbsenceActivation(
        { ...lease, lockedBy: "stale-worker" }, "provider state unknown", now,
      )).resolves.toEqual({ updated: false, reason: "stale_lease" });
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);

      await expect(queue.exhaustReviewerAbsenceActivation(lease, "provider state unknown", now))
        .resolves.toEqual({ updated: true });
      await expect(db.selectFrom("reviewer_replacements")
        .select(["outcome", "state", "last_error", "mutation_intent_id"])
        .executeTakeFirstOrThrow()).resolves.toEqual({
          outcome: "permanent_failure",
          state: "permanent_failure",
          last_error: "provider state unknown",
          mutation_intent_id: fixture.mutationIntentId,
        });
      await expect(db.selectFrom("jobs").select(["status", "last_error"])
        .where("id", "=", claimed!.id).executeTakeFirstOrThrow()).resolves.toEqual({
          status: "failed",
          last_error: "provider state unknown",
        });
    });
  });

  it("atomically creates or loads one immutable reviewer mutation intent", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-mutation-intent");
      await db.updateTable("routing_decisions")
        .set({
          details: {
            ownership: {
              preferredReviewers: [unavailableActor, replacementActor, alternateReplacementActor],
              eligibleReviewers: [unavailableActor, replacementActor, alternateReplacementActor],
            },
            routing: { requestedReviewerCount: 1 },
          },
        })
        .where("workspace_id", "=", fixture.scope.workspaceId)
        .where("id", "=", fixture.decisionId)
        .execute();
      const common = {
        workspaceId: fixture.scope.workspaceId,
        provider: fixture.scope.provider,
        providerConnectionId: fixture.scope.providerConnectionId,
        absenceId: fixture.absence.id,
        absenceRevision: fixture.absence.revision,
        decisionId: fixture.decisionId,
        repositoryId: fixture.externalRepositoryId,
        changeRequestId,
        expectedHeadRevision: "head-1",
        unavailableActorId: unavailableActor,
      };

      const attempts = await Promise.allSettled([
        fixture.availability.prepareMutationIntent({ ...common, replacementActorId: replacementActor }),
        fixture.availability.prepareMutationIntent({ ...common, replacementActorId: alternateReplacementActor }),
      ]);
      const prepared = attempts.filter((attempt) => attempt.status === "fulfilled");
      const rejected = attempts.filter((attempt) => attempt.status === "rejected");

      expect(prepared).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const winner = prepared[0]!.value;
      expect(winner.id.trim()).not.toBe("");
      await expect(fixture.availability.loadMutationIntent(common)).resolves.toEqual(winner);
      await expect(fixture.availability.prepareMutationIntent({
        ...common,
        replacementActorId: winner.replacementActorId,
      })).resolves.toEqual(winner);
      await expect(fixture.availability.prepareMutationIntent({
        ...common,
        expectedHeadRevision: "different-head",
        replacementActorId: winner.replacementActorId,
      })).rejects.toBeInstanceOf(ReviewerAvailabilityValidationError);

      const other = await seedReplacementFixture(db, "availability-mutation-intent-other");
      await expect(other.availability.loadMutationIntent({
        workspaceId: other.scope.workspaceId,
        providerConnectionId: fixture.scope.providerConnectionId,
        absenceId: fixture.absence.id,
        absenceRevision: fixture.absence.revision,
        decisionId: fixture.decisionId,
      })).resolves.toBeNull();
    });
  });

  it("rejects direct mutation of an immutable reviewer mutation intent", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-intent-immutable");

      await expect(db.updateTable("reviewer_mutation_intents")
        .set({ replacement_actor_id: alternateReplacementActor })
        .where("id", "=", fixture.mutationIntentId)
        .execute()).rejects.toThrow(/immutable/i);

      await expect(fixture.availability.loadMutationIntent({
        workspaceId: fixture.scope.workspaceId,
        providerConnectionId: fixture.scope.providerConnectionId,
        absenceId: fixture.absence.id,
        absenceRevision: fixture.absence.revision,
        decisionId: fixture.decisionId,
      })).resolves.toMatchObject({ replacementActorId: replacementActor });
    });
  });

  it("rejects direct intent inserts that mix connection, repository, decision, or absence revision", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-intent-source-a");
      const connectionB = await db.insertInto("provider_connections").values({
        workspace_id: fixture.scope.workspaceId,
        provider: "github",
        external_connection_id: "availability-intent-source-b",
        workspace_login: "source-b",
        account_type: "organization",
        status: "suspended",
        permissions: {},
      }).returning("id").executeTakeFirstOrThrow();
      const repositoryB = await db.insertInto("repositories").values({
        workspace_id: fixture.scope.workspaceId,
        provider: "github",
        provider_connection_id: connectionB.id,
        external_repository_id: "source-b-repository",
        owner: "example",
        name: "source-b",
        config_state: "valid",
      }).returning("id").executeTakeFirstOrThrow();
      const decisionB = await persistDecision(db, fixture.scope.workspaceId, {
        repositoryId: repositoryB.id,
        deliveryId: "source-b-delivery",
        routingKey: "source-b-routing",
        changeRequestId: "source-b-change",
        pullNumber: 18,
        headSha: "source-b-head",
        mode: "enforce",
        action: "request_human_review",
        actionStatus: "pending",
        riskScore: 50,
        selectedReviewers: [unavailableActor],
        details: {
          ownership: { preferredReviewers: [unavailableActor, replacementActor], eligibleReviewers: [unavailableActor, replacementActor] },
          routing: { requestedReviewerCount: 1 },
        },
      });
      const repositoryA = await db.selectFrom("repositories").select("id")
        .where("workspace_id", "=", fixture.scope.workspaceId)
        .where("external_repository_id", "=", fixture.externalRepositoryId)
        .executeTakeFirstOrThrow();
      await db.deleteFrom("reviewer_mutation_intents").where("id", "=", fixture.mutationIntentId).execute();

      const insertMixed = (repositoryRecordId: string, repositoryId: string, decisionId: string, absenceRevision: number) => sql`
        insert into reviewer_mutation_intents (
          workspace_id, provider, provider_connection_id, absence_id, absence_revision,
          decision_id, repository_record_id, repository_id, change_request_id, expected_head_revision,
          unavailable_actor_id, replacement_actor_id
        ) values (
          ${fixture.scope.workspaceId}::uuid, 'github', ${fixture.scope.providerConnectionId}::uuid,
          ${fixture.absence.id}::uuid, ${absenceRevision}, ${decisionId}::uuid, ${repositoryRecordId}::uuid, ${repositoryId},
          ${changeRequestId}, 'head-1', ${unavailableActor}, ${alternateReplacementActor}
        )
      `.execute(db);

      await expect(insertMixed(repositoryB.id, "source-b-repository", fixture.decisionId, fixture.absence.revision))
        .rejects.toThrow();
      await expect(insertMixed(repositoryA.id, fixture.externalRepositoryId, decisionB.decisionId, fixture.absence.revision))
        .rejects.toThrow();
      await expect(insertMixed(repositoryA.id, fixture.externalRepositoryId, fixture.decisionId, fixture.absence.revision + 1))
        .rejects.toThrow(/revision/i);
    });
  });

  it.each([
    ["permanent_failure", "completed", "provider failed"],
    ["permanent_failure", "finalizer_pending", "provider failed"],
    ["no_replacement_available", "completed", null],
  ] as const)("rejects invalid replacement state/outcome %s/%s before writing", async (outcome, state, lastError) => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, `availability-invalid-${outcome}-${state}`);
      const input = nonMutatingReplacementInput(fixture, outcome === "no_replacement_available" ? outcome : "permanent_failure");

      await expect(fixture.availability.persistReplacement({
        ...input,
        outcome,
        state,
        lastError,
        event: { ...input.event, outcome },
      } as never)).rejects.toBeInstanceOf(ReviewerAvailabilityValidationError);
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("retains cutoff-crossing decisions needed by an intent or pending finalizer without blocking unrelated deletion", async () => {
    await withPostgresTestDatabase(async (db) => {
      const prepared = await seedReplacementFixture(db, "availability-retention-intent");
      const pending = await seedReplacementFixture(db, "availability-retention-finalizer");
      await pending.availability.persistReplacement(replacementInput(pending));
      const old = new Date("2026-05-01T00:00:00.000Z");
      const unprotected = await db.insertInto("routing_decisions").values({
        workspace_id: prepared.scope.workspaceId,
        delivery_id: "retention-unprotected",
        routing_key: "retention-unprotected",
        action: "no_eligible_reviewer",
        risk_score: 1,
        details: {},
        effective_config_hash: "retention-hash",
        inheritance_mode: "legacy",
        created_at: old,
      }).returning("id").executeTakeFirstOrThrow();
      await db.updateTable("routing_decisions").set({ created_at: old })
        .where("id", "in", [prepared.decisionId, pending.decisionId]).execute();

      await applyFixedRetention(db, prepared.scope.workspaceId, new Date("2026-09-01T00:00:00.000Z"));
      await applyFixedRetention(db, pending.scope.workspaceId, new Date("2026-09-01T00:00:00.000Z"));

      await expect(db.selectFrom("routing_decisions").select("id")
        .where("id", "in", [prepared.decisionId, pending.decisionId]).execute()).resolves.toHaveLength(2);
      await expect(db.selectFrom("routing_decisions").select("id").where("id", "=", unprotected.id).executeTakeFirst())
        .resolves.toBeUndefined();
      await expect(db.selectFrom("reviewer_mutation_intents").select("id").execute()).resolves.toHaveLength(2);
      await expect(db.selectFrom("reviewer_replacements").select("state").executeTakeFirstOrThrow())
        .resolves.toMatchObject({ state: "finalizer_pending" });
    });
  });

  it("atomically marks a stale last-attempt finalizer and its job permanently failed", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-stale-finalizer");
      const persisted = await fixture.availability.persistReplacement(replacementInput(fixture));
      const replacementId = persisted.replacement!.id;
      const recovery = {
        kind: "reviewer_replacement_finalizer",
        phase: "run_finalizer",
        provider: fixture.scope.provider,
        unavailableActorId: unavailableActor,
        job: {
          kind: "activate_reviewer_absence",
          workspaceId: fixture.scope.workspaceId,
          providerConnectionId: fixture.scope.providerConnectionId,
          absenceId: fixture.absence.id,
          absenceRevision: fixture.absence.revision,
        },
        finalizer: { action: "reevaluate_policy", decisionId: fixture.decisionId, summary: null },
        replacementId,
        outcome: "replaced",
        replacementActorId: replacementActor,
        mutationIntentId: fixture.mutationIntentId,
        providerEffectsApplied: true,
        persistence: null,
        retryable: true,
        lastError: "finalizer unavailable",
      };
      const lockedAt = new Date("2026-09-01T10:00:00.000Z");
      await db.updateTable("jobs").set({
        status: "running",
        attempt_count: 4,
        max_attempts: 4,
        locked_at: lockedAt,
        locked_by: "dead-worker",
        payload: {
          kind: "activate_reviewer_absence",
          workspaceId: fixture.scope.workspaceId,
          providerConnectionId: fixture.scope.providerConnectionId,
          absenceId: fixture.absence.id,
          absenceRevision: fixture.absence.revision,
          reviewerReplacementFinalizerRecovery: recovery,
        },
      }).where("workspace_id", "=", fixture.scope.workspaceId)
        .where("kind", "=", "activate_reviewer_absence").execute();

      await recoverStaleJobs(db, fixture.scope.workspaceId, new Date("2026-09-01T10:16:00.000Z"));

      await expect(db.selectFrom("reviewer_replacements").select(["state", "last_error"])
        .where("id", "=", replacementId).executeTakeFirstOrThrow()).resolves.toEqual({
        state: "permanent_failure",
        last_error: "job lease expired after maximum attempts",
      });
      await expect(db.selectFrom("jobs").select(["status", "last_error"])
        .where("workspace_id", "=", fixture.scope.workspaceId).where("kind", "=", "activate_reviewer_absence")
        .executeTakeFirstOrThrow()).resolves.toEqual({
        status: "failed",
        last_error: "job lease expired after maximum attempts",
      });
    });
  });

  it("atomically audits a stale last-attempt provider-persistence recovery before failing its job", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-stale-persistence");
      const persistence = replacementInput(fixture);
      const lockedAt = new Date("2026-09-01T10:00:00.000Z");
      await db.updateTable("jobs").set({
        status: "running",
        attempt_count: 4,
        max_attempts: 4,
        locked_at: lockedAt,
        locked_by: "dead-worker",
        payload: {
          kind: "activate_reviewer_absence",
          workspaceId: fixture.scope.workspaceId,
          providerConnectionId: fixture.scope.providerConnectionId,
          absenceId: fixture.absence.id,
          absenceRevision: fixture.absence.revision,
          reviewerReplacementFinalizerRecovery: {
            kind: "reviewer_replacement_finalizer",
            phase: "persist_replacement",
            provider: fixture.scope.provider,
            unavailableActorId: unavailableActor,
            job: {
              kind: "activate_reviewer_absence",
              workspaceId: fixture.scope.workspaceId,
              providerConnectionId: fixture.scope.providerConnectionId,
              absenceId: fixture.absence.id,
              absenceRevision: fixture.absence.revision,
            },
            finalizer: { action: "reevaluate_policy", decisionId: fixture.decisionId, summary: null },
            replacementId: null,
            outcome: "replaced",
            replacementActorId: replacementActor,
            mutationIntentId: fixture.mutationIntentId,
            providerEffectsApplied: true,
            persistence,
            retryable: true,
            lastError: "replacement persistence unavailable",
          },
        },
      }).where("workspace_id", "=", fixture.scope.workspaceId)
        .where("kind", "=", "activate_reviewer_absence").execute();

      await recoverStaleJobs(db, fixture.scope.workspaceId, new Date("2026-09-01T10:16:00.000Z"));

      await expect(db.selectFrom("reviewer_replacements")
        .select(["outcome", "state", "last_error", "mutation_intent_id"])
        .executeTakeFirstOrThrow()).resolves.toEqual({
        outcome: "permanent_failure",
        state: "permanent_failure",
        last_error: "job lease expired after maximum attempts",
        mutation_intent_id: fixture.mutationIntentId,
      });
      await expect(readSelectedActors(db, fixture.decisionId)).resolves.toEqual([unavailableActor]);
      await expect(db.selectFrom("jobs").select("status")
        .where("workspace_id", "=", fixture.scope.workspaceId).where("kind", "=", "activate_reviewer_absence")
        .executeTakeFirstOrThrow()).resolves.toEqual({ status: "failed" });
    });
  });

  it("does not mutate a pending replacement for a malformed stale recovery payload", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-stale-malformed");
      const persisted = await fixture.availability.persistReplacement(replacementInput(fixture));
      const replacementId = persisted.replacement!.id;
      const lockedAt = new Date("2026-09-01T10:00:00.000Z");
      await db.updateTable("jobs").set({
        status: "running",
        attempt_count: 4,
        max_attempts: 4,
        locked_at: lockedAt,
        locked_by: "dead-worker",
        payload: {
          kind: "activate_reviewer_absence",
          workspaceId: fixture.scope.workspaceId,
          providerConnectionId: fixture.scope.providerConnectionId,
          absenceId: fixture.absence.id,
          absenceRevision: fixture.absence.revision,
          reviewerReplacementFinalizerRecovery: {
            kind: "reviewer_replacement_finalizer",
            phase: "run_finalizer",
            provider: fixture.scope.provider,
            unavailableActorId: unavailableActor,
            job: {
              kind: "activate_reviewer_absence",
              workspaceId: fixture.scope.workspaceId,
              providerConnectionId: fixture.scope.providerConnectionId,
              absenceId: fixture.absence.id,
              absenceRevision: fixture.absence.revision,
            },
            finalizer: { action: "reevaluate_policy", decisionId: fixture.decisionId, summary: null },
            replacementId,
            outcome: "replaced",
            replacementActorId: replacementActor,
            mutationIntentId: "intent-does-not-match",
            providerEffectsApplied: true,
            persistence: null,
            retryable: true,
            lastError: "finalizer unavailable",
          },
        },
      }).where("workspace_id", "=", fixture.scope.workspaceId)
        .where("kind", "=", "activate_reviewer_absence").execute();

      await recoverStaleJobs(db, fixture.scope.workspaceId, new Date("2026-09-01T10:16:00.000Z"));

      await expect(db.selectFrom("reviewer_replacements").select(["state", "last_error"])
        .where("id", "=", replacementId).executeTakeFirstOrThrow()).resolves.toEqual({
        state: "finalizer_pending",
        last_error: null,
      });
      await expect(db.selectFrom("jobs").select("status")
        .where("workspace_id", "=", fixture.scope.workspaceId).where("kind", "=", "activate_reviewer_absence")
        .executeTakeFirstOrThrow()).resolves.toEqual({ status: "failed" });
    });
  });

  it("isolates a source-invalid stale recovery while a valid exhausted job still commits", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-stale-batch-isolation");
      const replacement = (await fixture.availability.persistReplacement(replacementInput(fixture))).replacement!;
      const recovery = {
        kind: "reviewer_replacement_finalizer", phase: "run_finalizer",
        provider: fixture.scope.provider, unavailableActorId: unavailableActor,
        job: { kind: "activate_reviewer_absence", workspaceId: fixture.scope.workspaceId,
          providerConnectionId: fixture.scope.providerConnectionId, absenceId: fixture.absence.id,
          absenceRevision: fixture.absence.revision },
        finalizer: { action: "reevaluate_policy", decisionId: fixture.decisionId, summary: null },
        replacementId: replacement.id, outcome: "replaced", replacementActorId: replacementActor,
        mutationIntentId: fixture.mutationIntentId, providerEffectsApplied: true,
        persistence: null, retryable: true, lastError: "finalizer unavailable",
      };
      const queue = createWorkspaceJobQueue(db, fixture.scope.workspaceId);
      const bad = await queue.enqueue({
        provider: fixture.scope.provider, providerConnectionId: fixture.scope.providerConnectionId,
        kind: "activate_reviewer_absence", idempotencyKey: "availability:bad-stale-source",
        payload: {
          ...recovery.job,
          reviewerReplacementFinalizerRecovery: {
            ...recovery,
            replacementId: "00000000-0000-4000-8000-00000000dead",
          },
        },
      });
      const lockedAt = new Date("2026-09-01T10:00:00.000Z");
      await db.updateTable("jobs").set({ status: "running", attempt_count: 4, max_attempts: 4,
        locked_at: lockedAt, locked_by: "dead-worker" })
        .where("workspace_id", "=", fixture.scope.workspaceId).execute();
      await db.updateTable("jobs").set({ payload: {
        ...recovery.job, reviewerReplacementFinalizerRecovery: recovery,
      }}).where("workspace_id", "=", fixture.scope.workspaceId)
        .where("id", "!=", bad.jobId).execute();

      await recoverStaleJobs(db, fixture.scope.workspaceId, new Date("2026-09-01T10:16:00.000Z"));

      await expect(db.selectFrom("jobs").select("status")
        .where("workspace_id", "=", fixture.scope.workspaceId).execute()).resolves.toEqual([
          { status: "failed" }, { status: "failed" },
        ]);
      await expect(db.selectFrom("jobs").select("last_error").where("id", "=", bad.jobId)
        .executeTakeFirstOrThrow()).resolves.toEqual({
          last_error: "job lease expired after maximum attempts: reviewer activation recovery source is invalid",
        });
      await expect(db.selectFrom("reviewer_replacements").select(["id", "state", "last_error"]).execute())
        .resolves.toEqual([{ id: replacement.id, state: "permanent_failure",
          last_error: "job lease expired after maximum attempts" }]);
    });
  });

  it("persists an explicit IANA timezone for only the bound workspace", async () => {
    await withPostgresTestDatabase(async (db) => {
      const first = await seedWorkspace(db, "availability-settings-a", "github", "connection-a");
      const second = await seedWorkspace(db, "availability-settings-b", "gitlab", "connection-b");
      const availabilityA = createWorkspaceReviewerAvailability(db, first.workspaceId);
      const availabilityB = createWorkspaceReviewerAvailability(db, second.workspaceId);

      await expect(availabilityA.readSettings()).resolves.toMatchObject({
        workspaceId: first.workspaceId,
        timezone: "UTC",
      });
      await expect(availabilityB.updateTimezone("Europe/Bratislava", now)).resolves.toEqual({
        workspaceId: second.workspaceId,
        timezone: "Europe/Bratislava",
        updatedAt: now,
      });
      await expect(availabilityA.readSettings()).resolves.toMatchObject({ timezone: "UTC" });
      await expect(availabilityB.updateTimezone("Not/A_Timezone", now))
        .rejects.toBeInstanceOf(ReviewerAvailabilityValidationError);
      await expect(availabilityB.readSettings()).resolves.toMatchObject({ timezone: "Europe/Bratislava" });
    });
  });

  it("preserves opaque provider actor identity and enqueues the revision-specific activation transactionally", async () => {
    await withPostgresTestDatabase(async (db) => {
      const scope = await seedWorkspace(db, "availability-schedule", "github", "connection-schedule");
      const availability = createWorkspaceReviewerAvailability(db, scope.workspaceId);
      const startAt = new Date("2026-10-01T08:00:00.000Z");
      const endAt = new Date("2026-10-08T08:00:00.000Z");

      const absence = await availability.scheduleAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "Actor:CaseSensitive/42",
        startAt,
        endAt,
        now,
      });

      expect(absence).toMatchObject({
        workspaceId: scope.workspaceId,
        provider: "github",
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "Actor:CaseSensitive/42",
        status: "scheduled",
        revision: 1,
      });
      await expect(db.selectFrom("jobs")
        .select(["workspace_id", "provider", "provider_connection_id", "kind", "payload", "run_at", "idempotency_key"])
        .executeTakeFirstOrThrow()).resolves.toEqual({
        workspace_id: scope.workspaceId,
        provider: "github",
        provider_connection_id: scope.providerConnectionId,
        kind: "activate_reviewer_absence",
        payload: {
          kind: "activate_reviewer_absence",
          workspaceId: scope.workspaceId,
          providerConnectionId: scope.providerConnectionId,
          absenceId: absence.id,
          absenceRevision: 1,
        },
        run_at: startAt,
        idempotency_key: `reviewer-absence:${absence.id}:revision:1`,
      });

      await sql`create function reject_activation_job() returns trigger language plpgsql as $$ begin raise exception 'activation job rejected'; end; $$`.execute(db);
      await sql`create trigger reject_activation_job before insert on jobs for each row when (new.kind = 'activate_reviewer_absence') execute function reject_activation_job()`.execute(db);
      await expect(availability.scheduleAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "884211",
        startAt: new Date("2026-10-09T08:00:00.000Z"),
        endAt: new Date("2026-10-10T08:00:00.000Z"),
        now,
      })).rejects.toThrow("activation job rejected");
      await expect(db.selectFrom("reviewer_absences").select("external_actor_id").orderBy("external_actor_id").execute())
        .resolves.toEqual([{ external_actor_id: "Actor:CaseSensitive/42" }]);

      await sql`drop trigger reject_activation_job on jobs`.execute(db);
      await availability.scheduleAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "actor:casesensitive/42",
        startAt,
        endAt,
        now,
      });
      const active = await availability.findActiveAbsences({
        providerConnectionId: scope.providerConnectionId,
        actors: ["Actor:CaseSensitive/42", "actor:casesensitive/42"],
        at: startAt,
      });
      expect(active).toHaveLength(2);
      expect(active).toEqual(expect.arrayContaining([
        { externalActorId: "Actor:CaseSensitive/42", startAt, endAt },
        { externalActorId: "actor:casesensitive/42", startAt, endAt },
      ]));
    });
  });

  it("locks revisions for edits and cancellation while retaining stale activation jobs", async () => {
    await withPostgresTestDatabase(async (db) => {
      const scope = await seedWorkspace(db, "availability-revisions", "github", "connection-revisions");
      const availability = createWorkspaceReviewerAvailability(db, scope.workspaceId);
      const created = await availability.scheduleAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "RevisionActor:7",
        startAt: new Date("2026-10-01T08:00:00.000Z"),
        endAt: new Date("2026-10-08T08:00:00.000Z"),
        now,
      });
      const activeNow = new Date("2026-10-03T12:00:00.000Z");
      const revised = await availability.reviseAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        absenceId: created.id,
        expectedRevision: 1,
        externalActorId: "RevisionActor:7",
        startAt: new Date("2026-10-02T08:00:00.000Z"),
        endAt: new Date("2026-10-09T08:00:00.000Z"),
        now: activeNow,
      });

      expect(revised).toMatchObject({ revision: 2, status: "scheduled", externalActorId: "RevisionActor:7" });
      await expect(availability.reviseAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        absenceId: created.id,
        expectedRevision: 1,
        externalActorId: "RevisionActor:7",
        startAt: revised.startAt,
        endAt: revised.endAt,
        now: activeNow,
      })).rejects.toBeInstanceOf(ReviewerAbsenceRevisionError);

      const cancelledAt = new Date("2026-10-03T12:01:00.000Z");
      await expect(availability.cancelAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        absenceId: created.id,
        expectedRevision: 2,
        now: cancelledAt,
      })).resolves.toMatchObject({ revision: 3, status: "cancelled", cancelledAt });
      await expect(db.selectFrom("jobs")
        .select(["idempotency_key", "run_at"])
        .orderBy("idempotency_key")
        .execute()).resolves.toEqual([
        { idempotency_key: `reviewer-absence:${created.id}:revision:1`, run_at: new Date("2026-10-01T08:00:00.000Z") },
        { idempotency_key: `reviewer-absence:${created.id}:revision:2`, run_at: activeNow },
        { idempotency_key: `reviewer-absence:${created.id}:revision:3`, run_at: cancelledAt },
      ]);
      await expect(availability.listAbsences()).resolves.toEqual([
        expect.objectContaining({ id: created.id, revision: 3, status: "cancelled" }),
      ]);
    });
  });

  it("uses a half-open active lookup and rejects inactive or mismatched provider connections", async () => {
    await withPostgresTestDatabase(async (db) => {
      const scope = await seedWorkspace(db, "availability-active", "gitlab", "connection-active");
      const availability = createWorkspaceReviewerAvailability(db, scope.workspaceId);
      const startAt = new Date("2026-09-02T08:00:00.000Z");
      const endAt = new Date("2026-09-02T12:00:00.000Z");
      await availability.scheduleAbsence({
        provider: scope.provider,
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "884211",
        startAt,
        endAt,
        now,
      });

      await expect(availability.findActiveAbsences({
        providerConnectionId: scope.providerConnectionId,
        actors: ["884211", "884212"],
        at: startAt,
      })).resolves.toEqual([{ externalActorId: "884211", startAt, endAt }]);
      await expect(availability.findActiveAbsences({
        providerConnectionId: scope.providerConnectionId,
        actors: ["884211"],
        at: endAt,
      })).resolves.toEqual([]);
      await expect(availability.scheduleAbsence({
        provider: "github",
        providerConnectionId: scope.providerConnectionId,
        externalActorId: "wrong-provider:1",
        startAt,
        endAt,
        now,
      })).rejects.toBeInstanceOf(ProviderConnectionUnavailableError);

      await db.updateTable("provider_connections")
        .set({ status: "suspended" })
        .where("workspace_id", "=", scope.workspaceId)
        .where("id", "=", scope.providerConnectionId)
        .execute();
      await expect(availability.findActiveAbsences({
        providerConnectionId: scope.providerConnectionId,
        actors: ["884211"],
        at: startAt,
      })).resolves.toEqual([]);
    });
  });

  it.each(["revise", "cancel"] as const)(
    "rejects final persistence after an in-flight absence %s",
    async (mutation) => {
      await withPostgresTestDatabase(async (db) => {
        const fixture = await seedReplacementFixture(db, `availability-final-${mutation}`);
        const activation = await fixture.availability.loadActivation(fixture.absence.id, fixture.absence.revision);
        expect(activation?.candidates.map((candidate) => candidate.decisionId)).toEqual([fixture.decisionId]);

        if (mutation === "revise") {
          await fixture.availability.reviseAbsence({
            provider: fixture.scope.provider,
            providerConnectionId: fixture.scope.providerConnectionId,
            absenceId: fixture.absence.id,
            expectedRevision: fixture.absence.revision,
            externalActorId: fixture.absence.externalActorId,
            startAt: new Date("2026-08-30T12:00:00.000Z"),
            endAt: new Date("2026-09-03T12:00:00.000Z"),
            now,
          });
        } else {
          await fixture.availability.cancelAbsence({
            provider: fixture.scope.provider,
            providerConnectionId: fixture.scope.providerConnectionId,
            absenceId: fixture.absence.id,
            expectedRevision: fixture.absence.revision,
            now,
          });
        }

        await expect(fixture.availability.persistReplacement(replacementInput(fixture)))
          .resolves.toEqual({ inserted: false, activationCurrent: false, replacement: null });
        await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
        await expect(readSelectedActors(db, fixture.decisionId)).resolves.toEqual([unavailableActor]);
      });
    },
  );

  it("persists history, cohort mutation, explicit finalizer state, and the event idempotently", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-idempotency");
      const input = replacementInput(fixture);

      const first = await fixture.availability.persistReplacement(input);
      expect(first).toMatchObject({
        inserted: true,
        activationCurrent: true,
        replacement: {
          absenceId: fixture.absence.id,
          decisionId: fixture.decisionId,
          unavailableActorId: unavailableActor,
          replacementActorId: replacementActor,
          mutationIntentId: fixture.mutationIntentId,
          outcome: "replaced",
          state: "finalizer_pending",
          lastError: null,
        },
      });
      await expect(fixture.availability.persistReplacement(input)).resolves.toEqual({
        inserted: false,
        activationCurrent: true,
        replacement: first.replacement,
      });
      await expect(fixture.availability.persistReplacement({
        ...input,
        event: { ...input.event, eventId: `${input.event.eventId}:different` },
      })).rejects.toThrow("reviewer replacement retry conflicts with persisted platform event");
      await expect(readSelectedActors(db, fixture.decisionId)).resolves.toEqual([replacementActor]);
      await expect(db.selectFrom("decision_outbox")
        .select(["event_id", "event_type", "reviewer_replacement_id", "payload"])
        .execute()).resolves.toEqual([{
        event_id: input.event.eventId,
        event_type: "reviewer_replacement",
        reviewer_replacement_id: first.replacement?.id,
        payload: input.event,
      }]);

      const revised = await fixture.availability.reviseAbsence({
        provider: fixture.scope.provider,
        providerConnectionId: fixture.scope.providerConnectionId,
        absenceId: fixture.absence.id,
        expectedRevision: fixture.absence.revision,
        externalActorId: fixture.absence.externalActorId,
        startAt: new Date("2026-08-30T12:00:00.000Z"),
        endAt: new Date("2026-09-03T12:00:00.000Z"),
        now,
      });
      await expect(fixture.availability.loadActivation(revised.id, revised.revision))
        .resolves.toMatchObject({ candidates: [] });
      await expect(fixture.availability.listPendingFinalizers({
        absenceId: fixture.absence.id,
        absenceRevision: fixture.absence.revision,
      })).resolves.toEqual([
        expect.objectContaining({
          id: first.replacement!.id,
          state: "finalizer_pending",
          mutationIntentId: fixture.mutationIntentId,
        }),
      ]);

      const completed = await fixture.availability.updateReplacementState({
        replacementId: first.replacement!.id,
        expectedState: "finalizer_pending",
        state: "completed",
        lastError: null,
      });
      expect(completed).toMatchObject({ state: "completed", lastError: null });
      await expect(fixture.availability.updateReplacementState({
        replacementId: first.replacement!.id,
        expectedState: "finalizer_pending",
        state: "permanent_failure",
        lastError: "late failure",
      })).resolves.toBeNull();
      await expect(fixture.availability.listReplacementHistory(fixture.absence.id)).resolves.toEqual([
        expect.objectContaining({ id: first.replacement!.id, state: "completed", lastError: null }),
      ]);
    });
  });

  it("fails closed when replacement history does not match the durable intent actor", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-intent-linkage");
      await db.updateTable("routing_decisions")
        .set({
          details: {
            ownership: {
              preferredReviewers: [unavailableActor, replacementActor, alternateReplacementActor],
              eligibleReviewers: [unavailableActor, replacementActor, alternateReplacementActor],
            },
            routing: { requestedReviewerCount: 1 },
          },
        })
        .where("workspace_id", "=", fixture.scope.workspaceId)
        .where("id", "=", fixture.decisionId)
        .execute();
      const input = replacementInput(fixture);

      await expect(fixture.availability.persistReplacement({
        ...input,
        replacementActorId: alternateReplacementActor,
        event: { ...input.event, replacementActor: alternateReplacementActor },
      })).rejects.toBeInstanceOf(ReviewerAvailabilityValidationError);

      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
      await expect(readSelectedActors(db, fixture.decisionId)).resolves.toEqual([unavailableActor]);
    });
  });

  it("persists provider-effect history from durable intent after connection suspension", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-suspended-recovery");
      await db.updateTable("provider_connections")
        .set({ status: "suspended" })
        .where("workspace_id", "=", fixture.scope.workspaceId)
        .where("id", "=", fixture.scope.providerConnectionId)
        .execute();

      await expect(fixture.availability.persistReplacement(replacementInput(fixture))).resolves.toMatchObject({
        inserted: true,
        activationCurrent: true,
        replacement: {
          outcome: "replaced",
          mutationIntentId: fixture.mutationIntentId,
          state: "finalizer_pending",
        },
      });
    });
  });

  it.each(["revise", "cancel", "window_expired"] as const)(
    "persists and exactly replays a linked permanent-failure audit after %s rejects normal persistence",
    async (mutation) => {
      await withPostgresTestDatabase(async (db) => {
        const fixture = await seedReplacementFixture(db, `availability-intent-audit-${mutation}`);
        let completedAt = now;
        if (mutation === "revise") {
          await fixture.availability.reviseAbsence({
            provider: fixture.scope.provider,
            providerConnectionId: fixture.scope.providerConnectionId,
            absenceId: fixture.absence.id,
            expectedRevision: fixture.absence.revision,
            externalActorId: "@user-a81c73",
            startAt: new Date("2026-08-31T12:00:00.000Z"),
            endAt: new Date("2026-09-03T12:00:00.000Z"),
            now,
          });
        } else if (mutation === "cancel") {
          await fixture.availability.cancelAbsence({
            provider: fixture.scope.provider,
            providerConnectionId: fixture.scope.providerConnectionId,
            absenceId: fixture.absence.id,
            expectedRevision: fixture.absence.revision,
            now,
          });
        } else {
          completedAt = new Date("2026-09-03T12:00:00.000Z");
        }
        const normalInput = replacementInput(fixture);
        const normal = {
          ...normalInput,
          completedAt,
          event: { ...normalInput.event, occurredAt: completedAt.toISOString() },
        };
        await expect(fixture.availability.persistReplacement(normal)).resolves.toEqual({
          inserted: false,
          activationCurrent: false,
          replacement: null,
        });
        const audit = mutationIntentRecoveryInput(fixture, completedAt, `persistence exhausted after ${mutation}`);

        const first = await fixture.availability.persistMutationIntentRecovery(audit);
        await expect(fixture.availability.persistMutationIntentRecovery(audit)).resolves.toMatchObject({
          inserted: false,
          replacement: { id: first.replacement!.id },
        });
        await expect(fixture.availability.listReplacementHistory(fixture.absence.id)).resolves.toEqual([
          expect.objectContaining({
            id: first.replacement!.id,
            outcome: "permanent_failure",
            state: "permanent_failure",
            mutationIntentId: fixture.mutationIntentId,
          }),
        ]);
        await expect(readSelectedActors(db, fixture.decisionId)).resolves.toEqual([unavailableActor]);
      });
    },
  );

  it("serializes concurrent permanent audits and fails closed on a differing retry", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-concurrent-audit");
      const audit = mutationIntentRecoveryInput(fixture, now, "provider state is unknown");
      const [first, second] = await Promise.all([
        fixture.availability.persistMutationIntentRecovery(audit),
        fixture.availability.persistMutationIntentRecovery(audit),
      ]);
      expect([first.inserted, second.inserted].sort()).toEqual([false, true]);
      expect(first.replacement!.id).toBe(second.replacement!.id);
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toHaveLength(1);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toHaveLength(1);

      await expect(fixture.availability.persistMutationIntentRecovery({
        ...audit,
        reason: "different terminal reason",
        lastError: "different terminal reason",
      })).rejects.toThrow(/conflicts/i);
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toHaveLength(1);
    });
  });

  it("serializes prepare behind terminal history and never creates a hidden intent", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-terminal-before-prepare");
      const intent = await db.selectFrom("reviewer_mutation_intents").selectAll().executeTakeFirstOrThrow();
      await db.deleteFrom("reviewer_mutation_intents").where("id", "=", intent.id).execute();
      let signalLocked!: (id: string) => void;
      let releaseLock!: () => void;
      const locked = new Promise<string>((resolve) => { signalLocked = resolve; });
      const release = new Promise<void>((resolve) => { releaseLock = resolve; });
      const terminal = db.transaction().execute(async (trx) => {
        const transaction = await sql<{ id: string }>`select txid_current()::text as id`.execute(trx);
        await trx.selectFrom("reviewer_absences").select("id")
          .where("id", "=", fixture.absence.id).forUpdate().executeTakeFirstOrThrow();
        const input = nonMutatingReplacementInput(fixture, "skipped_closed");
        await trx.insertInto("reviewer_replacements").values({
          workspace_id: fixture.scope.workspaceId, provider: input.provider,
          provider_connection_id: input.providerConnectionId, absence_id: input.absenceId,
          absence_revision: input.absenceRevision, decision_id: input.decisionId,
          unavailable_actor_id: input.unavailableActorId, replacement_actor_id: null,
          mutation_intent_id: null, outcome: "skipped_closed", reason: input.reason,
          state: "completed", last_error: null, started_at: now, completed_at: now,
        }).execute();
        signalLocked(transaction.rows[0]!.id);
        await release;
      });
      const transactionId = await locked;
      const prepare = fixture.availability.prepareMutationIntent({
        workspaceId: fixture.scope.workspaceId, provider: fixture.scope.provider,
        providerConnectionId: fixture.scope.providerConnectionId, absenceId: fixture.absence.id,
        absenceRevision: fixture.absence.revision, decisionId: fixture.decisionId,
        repositoryId: fixture.externalRepositoryId, changeRequestId,
        expectedHeadRevision: "head-1", unavailableActorId: unavailableActor,
        replacementActorId: replacementActor,
      });
      expect(await waitForBlockedDatabaseLock(db, transactionId)).toBe(true);
      releaseLock();
      await terminal;
      await expect(prepare).rejects.toThrow(/already terminal/i);
      await expect(db.selectFrom("reviewer_mutation_intents").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("serializes both mutation-intent insert and absence-revision orderings", async () => {
    await withPostgresTestDatabase(async (db) => {
      const insertFirst = await seedReplacementFixture(db, "availability-insert-before-revise");
      const row = await db.selectFrom("reviewer_mutation_intents").selectAll()
        .where("id", "=", insertFirst.mutationIntentId).executeTakeFirstOrThrow();
      await db.deleteFrom("reviewer_mutation_intents").where("id", "=", row.id).execute();
      let signalInserted!: (id: string) => void;
      let releaseInsert!: () => void;
      const inserted = new Promise<string>((resolve) => { signalInserted = resolve; });
      const release = new Promise<void>((resolve) => { releaseInsert = resolve; });
      const insertion = db.transaction().execute(async (trx) => {
        const transaction = await sql<{ id: string }>`select txid_current()::text as id`.execute(trx);
        await trx.insertInto("reviewer_mutation_intents").values(row).execute();
        signalInserted(transaction.rows[0]!.id);
        await release;
      });
      const insertTx = await inserted;
      const revise = insertFirst.availability.reviseAbsence({
        provider: insertFirst.scope.provider, providerConnectionId: insertFirst.scope.providerConnectionId,
        absenceId: insertFirst.absence.id, expectedRevision: 1, externalActorId: unavailableActor,
        startAt: insertFirst.absence.startAt, endAt: new Date("2026-09-03T12:00:00.000Z"), now,
      });
      expect(await waitForBlockedDatabaseLock(db, insertTx)).toBe(true);
      releaseInsert();
      await insertion;
      await expect(revise).resolves.toMatchObject({ revision: 2 });
      await expect(db.selectFrom("reviewer_mutation_intents").select("absence_revision")
        .where("id", "=", row.id).executeTakeFirstOrThrow()).resolves.toEqual({ absence_revision: 1 });

      const reviseFirst = await seedReplacementFixture(db, "availability-revise-before-insert");
      const stale = await db.selectFrom("reviewer_mutation_intents").selectAll()
        .where("id", "=", reviseFirst.mutationIntentId).executeTakeFirstOrThrow();
      await db.deleteFrom("reviewer_mutation_intents").where("id", "=", stale.id).execute();
      let signalRevised!: (id: string) => void;
      let releaseRevision!: () => void;
      const revised = new Promise<string>((resolve) => { signalRevised = resolve; });
      const releaseRevise = new Promise<void>((resolve) => { releaseRevision = resolve; });
      const revision = db.transaction().execute(async (trx) => {
        const transaction = await sql<{ id: string }>`select txid_current()::text as id`.execute(trx);
        await trx.updateTable("reviewer_absences").set({ revision: 2, updated_at: now })
          .where("id", "=", reviseFirst.absence.id).executeTakeFirstOrThrow();
        signalRevised(transaction.rows[0]!.id);
        await releaseRevise;
      });
      const revisionTx = await revised;
      const staleInsert = db.insertInto("reviewer_mutation_intents").values(stale).execute();
      expect(await waitForBlockedDatabaseLock(db, revisionTx)).toBe(true);
      releaseRevision();
      await revision;
      await expect(staleInsert).rejects.toThrow(/revision/i);
      await expect(db.selectFrom("reviewer_mutation_intents").select("id")
        .where("id", "=", stale.id).execute()).resolves.toEqual([]);
    });
  });

  it.each(["revise", "cancel", "suspend"] as const)(
    "keeps revision-specific pending finalizers recoverable after absence %s",
    async (mutation) => {
      await withPostgresTestDatabase(async (db) => {
        const fixture = await seedReplacementFixture(db, `availability-recovery-${mutation}`);
        const persisted = await fixture.availability.persistReplacement(replacementInput(fixture));

        if (mutation === "revise") {
          const revised = await fixture.availability.reviseAbsence({
            provider: fixture.scope.provider,
            providerConnectionId: fixture.scope.providerConnectionId,
            absenceId: fixture.absence.id,
            expectedRevision: fixture.absence.revision,
            externalActorId: fixture.absence.externalActorId,
            startAt: new Date("2026-08-30T12:00:00.000Z"),
            endAt: new Date("2026-09-03T12:00:00.000Z"),
            now,
          });
          await expect(fixture.availability.loadActivation(revised.id, revised.revision))
            .resolves.toMatchObject({ revision: 2, candidates: [] });
        } else if (mutation === "cancel") {
          await fixture.availability.cancelAbsence({
            provider: fixture.scope.provider,
            providerConnectionId: fixture.scope.providerConnectionId,
            absenceId: fixture.absence.id,
            expectedRevision: fixture.absence.revision,
            now,
          });
          await expect(fixture.availability.loadActivation(fixture.absence.id, 1)).resolves.toBeNull();
        } else {
          await db.updateTable("provider_connections")
            .set({ status: "suspended" })
            .where("workspace_id", "=", fixture.scope.workspaceId)
            .where("id", "=", fixture.scope.providerConnectionId)
            .execute();
          await expect(fixture.availability.loadActivation(fixture.absence.id, 1)).resolves.toBeNull();
        }

        await expect(fixture.availability.listPendingFinalizers({
          absenceId: fixture.absence.id,
          absenceRevision: 1,
        })).resolves.toEqual([
          expect.objectContaining({
            id: persisted.replacement!.id,
            state: "finalizer_pending",
            mutationIntentId: fixture.mutationIntentId,
          }),
        ]);
        await expect(fixture.availability.updateReplacementState({
          replacementId: persisted.replacement!.id,
          expectedState: "finalizer_pending",
          state: "permanent_failure",
          lastError: `finalizer failed after ${mutation}`,
        })).resolves.toMatchObject({ state: "permanent_failure", lastError: `finalizer failed after ${mutation}` });
        await expect(fixture.availability.listPendingFinalizers({
          absenceId: fixture.absence.id,
          absenceRevision: 1,
        })).resolves.toEqual([]);
        await expect(fixture.availability.listReplacementHistory(fixture.absence.id)).resolves.toEqual([
          expect.objectContaining({ id: persisted.replacement!.id, state: "permanent_failure" }),
        ]);
      });
    },
  );

  it.each(["no_replacement_available", "skipped_closed", "permanent_failure"] as const)(
    "does not rediscover a decision after recording %s for the same absence revision",
    async (outcome) => {
      await withPostgresTestDatabase(async (db) => {
        const fixture = await seedReplacementFixture(db, `availability-processed-${outcome}`);
        await expect(fixture.availability.loadActivation(fixture.absence.id, 1))
          .resolves.toMatchObject({ candidates: [expect.objectContaining({ decisionId: fixture.decisionId })] });
        const input = nonMutatingReplacementInput(fixture, outcome);
        const first = await fixture.availability.persistReplacement(input);
        await expect(fixture.availability.persistReplacement(input)).resolves.toMatchObject({
          inserted: false,
          replacement: { id: first.replacement!.id },
        });
        await expect(fixture.availability.loadActivation(fixture.absence.id, 1))
          .resolves.toMatchObject({ candidates: [] });
        await expect(fixture.availability.listReplacementHistory(fixture.absence.id)).resolves.toEqual([
          expect.objectContaining({ id: first.replacement!.id, outcome }),
        ]);
      });
    },
  );

  it("binds final persistence to the locked absence actor and rolls back a mismatched attempt", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-absence-actor-binding");
      const differentActor = "Actor:Different/Case";
      await db.updateTable("routing_decisions").set({
        selected_reviewer: differentActor,
        selected_reviewers: JSON.stringify([differentActor]),
        details: {
          ownership: { preferredReviewers: [differentActor, replacementActor], eligibleReviewers: [differentActor, replacementActor] },
          routing: { requestedReviewerCount: 1 },
        },
      }).where("id", "=", fixture.decisionId).execute();
      const input = replacementInput(fixture);

      await expect(fixture.availability.persistReplacement({
        ...input,
        unavailableActorId: differentActor,
        event: { ...input.event, unavailableActor: differentActor },
      })).resolves.toEqual({ inserted: false, activationCurrent: false, replacement: null });
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toEqual([]);
      await expect(readSelectedActors(db, fixture.decisionId)).resolves.toEqual([differentActor]);
    });
  });

  it("binds the replacement event change request identity to the persisted decision", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-change-request-binding");
      const input = replacementInput(fixture);

      await expect(fixture.availability.persistReplacement({
        ...input,
        event: { ...input.event, changeRequestId: "different:Change/Request" },
      })).resolves.toEqual({ inserted: false, activationCurrent: false, replacement: null });
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("keeps historical replacement history without an outbox event eventless on retry", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-historical-eventless");
      const input = replacementInput(fixture);
      const historical = await db.insertInto("reviewer_replacements").values({
        workspace_id: fixture.scope.workspaceId,
        provider: input.provider,
        provider_connection_id: input.providerConnectionId,
        absence_id: input.absenceId,
        absence_revision: input.absenceRevision,
        decision_id: input.decisionId,
        unavailable_actor_id: input.unavailableActorId,
        replacement_actor_id: input.replacementActorId,
        mutation_intent_id: input.mutationIntentId,
        outcome: input.outcome,
        reason: input.reason,
        state: input.state,
        last_error: input.lastError,
        started_at: input.startedAt,
        completed_at: input.completedAt,
      }).returning("id").executeTakeFirstOrThrow();

      await expect(fixture.availability.persistReplacement({
        ...input,
        event: {
          ...input.event,
          repositoryId: "forged-repository",
          changeRequestId: "forged-change-request",
        },
      })).resolves.toMatchObject({
        inserted: false,
        activationCurrent: true,
        replacement: { id: historical.id },
      });
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([historical]);
    });
  });

  it("blocks final persistence behind a concurrent absence revision and then rejects the stale revision", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-concurrent-revision");
      let signalUpdated: ((transactionId: string) => void) | undefined;
      let releaseRevision: (() => void) | undefined;
      const updated = new Promise<string>((resolve) => { signalUpdated = resolve; });
      const release = new Promise<void>((resolve) => { releaseRevision = resolve; });
      const revision = db.transaction().execute(async (trx) => {
        const transaction = await sql<{ id: string }>`select txid_current()::text as id`.execute(trx);
        await trx.updateTable("reviewer_absences")
          .set({ revision: 2, updated_at: now })
          .where("workspace_id", "=", fixture.scope.workspaceId)
          .where("id", "=", fixture.absence.id)
          .executeTakeFirstOrThrow();
        signalUpdated?.(transaction.rows[0]!.id);
        await release;
      });
      const revisionTransactionId = await updated;

      const persistence = fixture.availability.persistReplacement(replacementInput(fixture));
      const blocked = await waitForBlockedDatabaseLock(db, revisionTransactionId);
      releaseRevision?.();
      await revision;

      expect(blocked).toBe(true);
      await expect(persistence).resolves.toEqual({ inserted: false, activationCurrent: false, replacement: null });
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("revalidates the decision head and replacement availability under the final transaction", async () => {
    await withPostgresTestDatabase(async (db) => {
      const changedHead = await seedReplacementFixture(db, "availability-changed-head");
      await db.updateTable("routing_decisions")
        .set({ head_sha: "head-2" })
        .where("workspace_id", "=", changedHead.scope.workspaceId)
        .where("id", "=", changedHead.decisionId)
        .execute();
      await expect(changedHead.availability.persistReplacement(replacementInput(changedHead)))
        .resolves.toEqual({ inserted: false, activationCurrent: false, replacement: null });

      const absentReplacement = await seedReplacementFixture(db, "availability-absent-replacement");
      await absentReplacement.availability.scheduleAbsence({
        provider: absentReplacement.scope.provider,
        providerConnectionId: absentReplacement.scope.providerConnectionId,
        externalActorId: replacementActor,
        startAt: new Date("2026-08-31T12:00:00.000Z"),
        endAt: new Date("2026-09-02T12:00:00.000Z"),
        now,
      });
      await expect(absentReplacement.availability.persistReplacement(replacementInput(absentReplacement)))
        .resolves.toEqual({ inserted: false, activationCurrent: false, replacement: null });
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("rolls back replacement history and cohort state when event staging fails", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedReplacementFixture(db, "availability-event-rollback");
      await sql`create function reject_replacement_event() returns trigger language plpgsql as $$ begin raise exception 'replacement event rejected'; end; $$`.execute(db);
      await sql`create trigger reject_replacement_event before insert on decision_outbox for each row when (new.event_type = 'reviewer_replacement') execute function reject_replacement_event()`.execute(db);

      await expect(fixture.availability.persistReplacement(replacementInput(fixture)))
        .rejects.toThrow("replacement event rejected");
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("decision_outbox").select("id").execute()).resolves.toEqual([]);
      await expect(readSelectedActors(db, fixture.decisionId)).resolves.toEqual([unavailableActor]);
    });
  });
});

async function seedWorkspace(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  externalKey: string,
  provider: ProviderKind,
  externalConnectionId: string,
) {
  const workspace = await db.insertInto("workspaces")
    .values({ external_key: externalKey })
    .returning("id")
    .executeTakeFirstOrThrow();
  const connection = await db.insertInto("provider_connections").values({
    workspace_id: workspace.id,
    provider,
    external_connection_id: externalConnectionId,
    workspace_login: externalKey,
    account_type: "organization",
    status: "active",
    permissions: {},
  }).returning("id").executeTakeFirstOrThrow();
  return { workspaceId: workspace.id, provider, providerConnectionId: connection.id };
}

async function seedReplacementFixture(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  externalKey: string,
) {
  const scope = await seedWorkspace(db, externalKey, "github", `${externalKey}-connection`);
  const repository = await db.insertInto("repositories").values({
    workspace_id: scope.workspaceId,
    provider: scope.provider,
    provider_connection_id: scope.providerConnectionId,
    external_repository_id: `${externalKey}-repository`,
    owner: "example",
    name: "service",
    default_branch: "main",
    config_state: "valid",
  }).returning("id").executeTakeFirstOrThrow();
  const availability = createWorkspaceReviewerAvailability(db, scope.workspaceId);
  const absence = await availability.scheduleAbsence({
    provider: scope.provider,
    providerConnectionId: scope.providerConnectionId,
    externalActorId: unavailableActor,
    startAt: new Date("2026-08-31T12:00:00.000Z"),
    endAt: new Date("2026-09-02T12:00:00.000Z"),
    now,
  });
  const decision = await persistDecision(db, scope.workspaceId, {
    repositoryId: repository.id,
    deliveryId: `${externalKey}-delivery`,
    routingKey: `${externalKey}-routing`,
    changeRequestId,
    pullNumber: 17,
    headSha: "head-1",
    mode: "enforce",
    action: "request_human_review",
    actionStatus: "pending",
    riskScore: 50,
    selectedReviewers: [unavailableActor],
    details: {
      ownership: {
        preferredReviewers: [unavailableActor, replacementActor],
        eligibleReviewers: [unavailableActor, replacementActor],
      },
      routing: { requestedReviewerCount: 1 },
    },
  });
  const mutationIntent = await availability.prepareMutationIntent({
    workspaceId: scope.workspaceId,
    provider: scope.provider,
    providerConnectionId: scope.providerConnectionId,
    absenceId: absence.id,
    absenceRevision: absence.revision,
    decisionId: decision.decisionId,
    repositoryId: `${externalKey}-repository`,
    changeRequestId,
    expectedHeadRevision: "head-1",
    unavailableActorId: unavailableActor,
    replacementActorId: replacementActor,
  });
  return {
    db,
    scope,
    availability,
    absence,
    decisionId: decision.decisionId,
    mutationIntentId: mutationIntent.id,
    externalRepositoryId: `${externalKey}-repository`,
  };
}

function replacementInput(fixture: Awaited<ReturnType<typeof seedReplacementFixture>>) {
  const event: ReviewerReplacementEventV1 = {
    schemaVersion: 1,
    eventType: "reviewer_replacement",
    eventId: `replacement:${fixture.absence.id}:revision:1:${fixture.decisionId}`,
    occurredAt: now.toISOString(),
    workspaceId: fixture.scope.workspaceId,
    provider: fixture.scope.provider,
    providerConnectionId: fixture.scope.providerConnectionId,
    absenceId: fixture.absence.id,
    absenceRevision: fixture.absence.revision,
    decisionId: fixture.decisionId,
    repositoryId: fixture.externalRepositoryId,
    changeRequestId,
    unavailableActor,
    replacementActor,
    outcome: "replaced",
  };
  return {
    provider: fixture.scope.provider,
    providerConnectionId: fixture.scope.providerConnectionId,
    absenceId: fixture.absence.id,
    absenceRevision: fixture.absence.revision,
    decisionId: fixture.decisionId,
    expectedHeadRevision: "head-1",
    unavailableActorId: unavailableActor,
    replacementActorId: replacementActor,
    mutationIntentId: fixture.mutationIntentId,
    outcome: "replaced" as const,
    reason: "scheduled absence",
    state: "finalizer_pending" as const,
    lastError: null,
    startedAt: now,
    completedAt: now,
    replaceCohort: true,
    event,
  };
}

function nonMutatingReplacementInput(
  fixture: Awaited<ReturnType<typeof seedReplacementFixture>>,
  outcome: "no_replacement_available" | "skipped_closed" | "permanent_failure",
) {
  const input = replacementInput(fixture);
  return {
    ...input,
    replacementActorId: null,
    outcome,
    state: outcome === "permanent_failure"
      ? "permanent_failure" as const
      : outcome === "no_replacement_available"
        ? "finalizer_pending" as const
        : "completed" as const,
    lastError: outcome === "permanent_failure" ? "provider rejected replacement" : null,
    replaceCohort: false,
    event: { ...input.event, replacementActor: null, outcome },
  };
}

function mutationIntentRecoveryInput(
  fixture: Awaited<ReturnType<typeof seedReplacementFixture>>,
  completedAt: Date,
  error: string,
) {
  const input = replacementInput(fixture);
  return {
    ...input,
    replacementActorId: null,
    outcome: "permanent_failure" as const,
    reason: error,
    state: "permanent_failure" as const,
    lastError: error,
    completedAt,
    replaceCohort: false,
    event: {
      ...input.event,
      occurredAt: completedAt.toISOString(),
      replacementActor: null,
      outcome: "permanent_failure" as const,
    },
  };
}

async function waitForBlockedDatabaseLock(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  transactionId: string,
): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await sql<{ blocked: boolean }>`
      select exists (
        select 1 from pg_locks
        where locktype = 'transactionid'
          and transactionid::text = ${transactionId}
          and granted = false
      ) as blocked
    `.execute(db);
    if (result.rows[0]?.blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function readSelectedActors(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  decisionId: string,
): Promise<string[]> {
  const row = await db.selectFrom("routing_decisions")
    .select("selected_reviewers")
    .where("id", "=", decisionId)
    .executeTakeFirstOrThrow();
  return row.selected_reviewers as string[];
}
