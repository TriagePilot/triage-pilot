import { describe, expect, it, vi } from "vitest";

import {
  createWorkspaceJobQueue,
  createWorkspaceRepositories,
  createWorkspaceReviewerAvailability,
  ensureLocalWorkspace,
  persistDecision,
} from "@triagepilot/db";
import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import {
  processReviewerAbsenceActivationJob,
  recoverReviewerReplacementFinalizer,
} from "../src/availability-processor";
import { createWorkerReviewerAvailabilityServiceFactory } from "../src/runtime-services";

const now = new Date("2026-09-01T12:00:00.000Z");
const unavailableActor = "@user-d82a5f";
const eligibleActors = [unavailableActor, "@user-c91e46", "@user-f37a82"];

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("worker reviewer availability runtime crash recovery", () => {
  it("commits revocation promptly while provider authority is blocked on its child-first lock order", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "disconnect-provider-first");
      const remote = new ReviewerRemote();
      const hold = holdAbsenceLock(db, fixture);
      await hold.acquired;
      const processing = processReviewerAbsenceActivationJob(fixture.message, fixture.buildServices(remote));
      await waitForBlockedAbsenceAuthority(db);

      const disconnect = createWorkspaceRepositories(db, fixture.message.workspaceId)
        .revokeConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" });
      const disconnectedPromptly = await settlesWithin(disconnect, 500);
      hold.release();
      await hold.transaction;
      await Promise.allSettled([disconnect, processing]);

      expect(disconnectedPromptly).toBe(true);
      expect(remote.deleteCount).toBe(0);
      expect(remote.postCount).toBe(0);
      await expect(db.selectFrom("provider_connections")
        .select("status").where("id", "=", fixture.connectionId)
        .executeTakeFirstOrThrow()).resolves.toEqual({ status: "revoked" });
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("rejects provider authority obtained after durable revocation without false history", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "disconnect-revocation-first");
      const repositories = createWorkspaceRepositories(db, fixture.message.workspaceId);
      await repositories.revokeConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" });
      await expect(db.selectFrom("provider_connections")
        .select("status").where("id", "=", fixture.connectionId)
        .executeTakeFirstOrThrow()).resolves.toEqual({ status: "revoked" });

      const remote = new ReviewerRemote();
      await expect(processReviewerAbsenceActivationJob(fixture.message, fixture.buildServices(remote)))
        .resolves.toBeNull();

      expect(remote.deleteCount).toBe(0);
      expect(remote.postCount).toBe(0);
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("reviewer_mutation_intents").select("id").execute()).resolves.toEqual([]);
    });
  });

  it("treats an old claim rejected behind a new claim as obsolete without terminal history", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "obsolete-behind-new-claim");
      const remote = new ReviewerRemote();
      const services = fixture.buildServices(remote);
      let releaseMutation!: () => void;
      let mutationReached!: () => void;
      const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
      const reached = new Promise<void>((resolve) => { mutationReached = resolve; });
      const reconcile = services.provider.reconcileReviewRequest;
      services.provider.reconcileReviewRequest = async (target) => {
        mutationReached();
        await release;
        return await reconcile(target);
      };

      const oldClaim = processReviewerAbsenceActivationJob(fixture.message, services);
      await reached;
      const newLockedAt = new Date(now.getTime() + 1_000);
      await db.updateTable("jobs").set({
        status: "running", locked_at: newLockedAt, locked_by: "new-claim-worker", attempt_count: 2,
      }).where("id", "=", fixture.lease.jobId).execute();
      releaseMutation();

      await expect(oldClaim).rejects.toThrow(/stale|obsolete|authority|lease/i);
      expect(remote.deleteCount).toBe(0);
      expect(remote.postCount).toBe(0);
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
      await expect(db.selectFrom("jobs").select(["status", "locked_by", "locked_at", "attempt_count"])
        .where("id", "=", fixture.lease.jobId).executeTakeFirstOrThrow()).resolves.toEqual({
        status: "running", locked_by: "new-claim-worker", locked_at: newLockedAt, attempt_count: 2,
      });
    });
  });

  it.each(["revise", "cancel", "suspend"] as const)(
    "revalidates live activation authority before provider mutation after %s",
    async (adminMutation) => {
      await withPostgresTestDatabase(async (db) => {
        const fixture = await seedActivation(db, `live-authority-${adminMutation}`);
        const remote = new ReviewerRemote();
        const services = fixture.buildServices(remote);
        let releaseMutation!: () => void;
        let mutationReached!: () => void;
        const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
        const reached = new Promise<void>((resolve) => { mutationReached = resolve; });
        const reconcile = services.provider.reconcileReviewRequest;
        services.provider.reconcileReviewRequest = async (target) => {
          mutationReached();
          await release;
          return await reconcile(target);
        };

        const processing = processReviewerAbsenceActivationJob(fixture.message, services);
        await reached;
        await applyAdminMutation(db, fixture, adminMutation);
        releaseMutation();

        await expect(processing).rejects.toThrow(/stale|obsolete|authority|lease/i);
        expect(remote.deleteCount).toBe(0);
        expect(remote.postCount).toBe(0);
        await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);
        await expect(db.selectFrom("reviewer_mutation_intents").select("id").execute())
          .resolves.toHaveLength(1);
      });
    },
  );

  it("times out hung provider I/O, releases the transaction, and prevents late writes", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "hung-provider-timeout");
      const remote = new ReviewerRemote();
      let releaseHungRequest!: () => void;
      const hungRequest = new Promise<void>((resolve) => { releaseHungRequest = resolve; });
      remote.beforeDelete = async () => await hungRequest;
      const services = fixture.buildServices(remote, { providerMutationTimeoutMs: 50 });

      await expect(processReviewerAbsenceActivationJob(fixture.message, services))
        .rejects.toThrow(/deadline|timeout|authority|lease/i);
      expect(remote.deleteCount).toBe(0);
      expect(remote.postCount).toBe(0);
      await expect(Promise.race([
        createWorkspaceJobQueue(db, fixture.message.workspaceId)
          .exhaustReviewerAbsenceActivation(fixture.lease, "timeout released authority", now),
        new Promise((_, reject) => setTimeout(() => reject(new Error("database lock was not released")), 1_000)),
      ])).resolves.toEqual({ updated: true });
      releaseHungRequest();
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(remote.deleteCount).toBe(0);
      expect(remote.postCount).toBe(0);
    });
  });

  it("performs no provider write when exhaustion wins before the mutation boundary", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "exhaust-before-provider");
      const remote = new ReviewerRemote();
      const services = fixture.buildServices(remote);
      let releaseMutation!: () => void;
      let mutationReached!: () => void;
      const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
      const reached = new Promise<void>((resolve) => { mutationReached = resolve; });
      const reconcile = services.provider.reconcileReviewRequest;
      services.provider.reconcileReviewRequest = async (target) => {
        mutationReached();
        await release;
        return await reconcile(target);
      };

      const processing = processReviewerAbsenceActivationJob(fixture.message, services);
      await reached;
      await expect(createWorkspaceJobQueue(db, fixture.message.workspaceId)
        .exhaustReviewerAbsenceActivation(fixture.lease, "exhaustion won", now))
        .resolves.toEqual({ updated: true });
      releaseMutation();
      await processing.catch(() => undefined);

      expect(remote.deleteCount).toBe(0);
      expect(remote.postCount).toBe(0);
      await expect(db.selectFrom("jobs").select("status").where("id", "=", fixture.lease.jobId)
        .executeTakeFirstOrThrow()).resolves.toEqual({ status: "failed" });
    });
  });

  it("keeps exhaustion behind an in-flight provider mutation lease fence", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "provider-before-exhaust");
      const remote = new ReviewerRemote();
      let releaseDelete!: () => void;
      let deleteReached!: () => void;
      const release = new Promise<void>((resolve) => { releaseDelete = resolve; });
      const reached = new Promise<void>((resolve) => { deleteReached = resolve; });
      remote.beforeDelete = async () => {
        deleteReached();
        await release;
      };
      const services = fixture.buildServices(remote);
      services.finalizers.run = vi.fn(async () => {});

      const processing = processReviewerAbsenceActivationJob(fixture.message, services);
      await reached;
      const exhausting = createWorkspaceJobQueue(db, fixture.message.workspaceId)
        .exhaustReviewerAbsenceActivation(fixture.lease, "exhaustion waited", now);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(db.selectFrom("jobs").select("status").where("id", "=", fixture.lease.jobId)
        .executeTakeFirstOrThrow()).resolves.toEqual({ status: "running" });

      releaseDelete();
      await processing.catch(() => undefined);
      await expect(exhausting).resolves.toEqual({ updated: true });
      expect(remote.deleteCount).toBe(1);
      expect(remote.postCount).toBe(1);
      await expect(db.selectFrom("jobs").select("status").where("id", "=", fixture.lease.jobId)
        .executeTakeFirstOrThrow()).resolves.toEqual({ status: "failed" });
    });
  });

  it("reuses the durable actor after process death immediately after prepare", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "prepare");
      const remote = new ReviewerRemote();
      const first = fixture.buildServices(remote);
      const prepare = first.availability.prepareMutationIntent;
      first.availability.prepareMutationIntent = async (input) => {
        await prepare(input);
        throw new Error("process terminated after prepare");
      };

      await expect(processReviewerAbsenceActivationJob(fixture.message, first))
        .rejects.toThrow("process terminated after prepare");
      const intent = await db.selectFrom("reviewer_mutation_intents")
        .select(["id", "replacement_actor_id as replacementActorId"])
        .executeTakeFirstOrThrow();
      expect(remote.deleteCount).toBe(0);
      expect(remote.postCount).toBe(0);

      const retry = fixture.buildServices(remote);
      retry.reviewerLoad = vi.fn(async () => {
        throw new Error("retry must not select a new actor");
      });
      retry.finalizers.run = vi.fn(async () => {});
      await expect(processReviewerAbsenceActivationJob(fixture.message, retry)).resolves.toBeNull();

      expect(retry.reviewerLoad).not.toHaveBeenCalled();
      expect(remote.requested).toEqual(new Set([intent.replacementActorId]));
      await expect(db.selectFrom("reviewer_replacements")
        .select(["mutation_intent_id as mutationIntentId", "replacement_actor_id as replacementActorId"])
        .executeTakeFirstOrThrow()).resolves.toEqual({
        mutationIntentId: intent.id,
        replacementActorId: intent.replacementActorId,
      });
    });
  });

  it("repairs process death between DELETE and POST without repeating DELETE", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "delete-post");
      const remote = new ReviewerRemote();
      remote.failAfterNextDelete = true;
      const first = fixture.buildServices(remote);
      first.finalizers.run = vi.fn(async () => {});

      await expect(processReviewerAbsenceActivationJob(fixture.message, first))
        .rejects.toThrow("process terminated between DELETE and POST");
      const intent = await db.selectFrom("reviewer_mutation_intents")
        .select("replacement_actor_id as replacementActorId")
        .executeTakeFirstOrThrow();
      expect(remote.deleteCount).toBe(1);
      expect(remote.postCount).toBe(0);

      const retry = fixture.buildServices(remote);
      retry.finalizers.run = vi.fn(async () => {});
      await expect(processReviewerAbsenceActivationJob(fixture.message, retry)).resolves.toBeNull();

      expect(remote.deleteCount).toBe(1);
      expect(remote.postCount).toBe(1);
      expect(remote.requested).toEqual(new Set([intent.replacementActorId]));
    });
  });

  it("does not repeat provider effects after POST when final persistence was interrupted", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "post-persist");
      const remote = new ReviewerRemote();
      const first = fixture.buildServices(remote);
      first.finalizers.run = vi.fn(async () => {});
      const persist = first.availability.persistReplacement;
      first.availability.persistReplacement = async () => {
        throw new Error("process terminated after POST");
      };

      await expect(processReviewerAbsenceActivationJob(fixture.message, first)).resolves.toMatchObject({
        phase: "persist_replacement",
        lastError: "process terminated after POST",
      });
      expect(remote.deleteCount).toBe(1);
      expect(remote.postCount).toBe(1);
      await expect(db.selectFrom("reviewer_replacements").select("id").execute()).resolves.toEqual([]);

      const retry = fixture.buildServices(remote);
      retry.availability.persistReplacement = persist;
      retry.finalizers.run = vi.fn(async () => {});
      await expect(processReviewerAbsenceActivationJob(fixture.message, retry)).resolves.toBeNull();

      expect(remote.deleteCount).toBe(1);
      expect(remote.postCount).toBe(1);
      await expect(db.selectFrom("reviewer_replacements")
        .select(["outcome", "mutation_intent_id as mutationIntentId"])
        .executeTakeFirstOrThrow()).resolves.toEqual({
        outcome: "replaced",
        mutationIntentId: expect.any(String),
      });
    });
  });

  it("replays only the mapped pending finalizer after terminal persistence", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "finalizer");
      const remote = new ReviewerRemote();
      const first = fixture.buildServices(remote);
      first.finalizers.run = vi.fn(async () => {
        throw new Error("process terminated before finalizer");
      });

      await expect(processReviewerAbsenceActivationJob(fixture.message, first)).resolves.toMatchObject({
        phase: "run_finalizer",
        lastError: "process terminated before finalizer",
      });
      const providerCounts = remote.counts();
      const pending = await db.selectFrom("reviewer_replacements")
        .select(["id", "state", "mutation_intent_id as mutationIntentId"])
        .executeTakeFirstOrThrow();
      expect(pending).toMatchObject({ state: "finalizer_pending", mutationIntentId: expect.any(String) });

      const retry = fixture.buildServices(remote);
      retry.finalizers.run = vi.fn(async () => {});
      await expect(processReviewerAbsenceActivationJob(fixture.message, retry)).resolves.toBeNull();

      expect(retry.finalizers.run).toHaveBeenCalledOnce();
      expect(remote.counts()).toEqual(providerCounts);
      await expect(db.selectFrom("reviewer_replacements")
        .select(["state", "mutation_intent_id as mutationIntentId"])
        .where("id", "=", pending.id)
        .executeTakeFirstOrThrow()).resolves.toEqual({
        state: "completed",
        mutationIntentId: pending.mutationIntentId,
      });
    });
  });

  it("terminates a pending policy finalizer locally after provider revocation", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "revoked-policy-finalizer");
      const remote = new ReviewerRemote();
      const first = fixture.buildServices(remote);
      first.finalizers.run = vi.fn(async () => {
        throw new Error("process terminated before policy finalization");
      });
      const recovery = await processReviewerAbsenceActivationJob(fixture.message, first);
      expect(recovery).toMatchObject({ phase: "run_finalizer", retryable: true });
      const providerCallsBeforeRevocation = remote.request.mock.calls.length;

      await createWorkspaceRepositories(db, fixture.message.workspaceId)
        .revokeConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" });
      const nextRecovery = await recoverReviewerReplacementFinalizer(
        recovery!,
        fixture.buildServices(remote),
      );

      expect(nextRecovery).toMatchObject({
        phase: "run_finalizer",
        retryable: false,
        lastError: expect.stringMatching(/revoked|inactive provider connection/i),
      });
      expect(remote.request).toHaveBeenCalledTimes(providerCallsBeforeRevocation);
      await expect(db.selectFrom("reviewer_replacements")
        .select(["id", "state", "last_error as lastError"])
        .executeTakeFirstOrThrow()).resolves.toMatchObject({
        id: recovery!.replacementId,
        state: "finalizer_pending",
        lastError: null,
      });

      await expect(createWorkspaceJobQueue(db, fixture.message.workspaceId)
        .exhaustReviewerAbsenceActivation(fixture.lease, nextRecovery!.lastError, now))
        .resolves.toEqual({ updated: true });
      await expect(db.selectFrom("reviewer_replacements")
        .select(["id", "state", "last_error as lastError"])
        .execute()).resolves.toEqual([{
        id: recovery!.replacementId,
        state: "permanent_failure",
        lastError: nextRecovery!.lastError,
      }]);
      expect(remote.request).toHaveBeenCalledTimes(providerCallsBeforeRevocation);
    });
  });

  it("blocks a pending failure-check finalizer after provider revocation", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "revoked-failure-finalizer", [unavailableActor]);
      const remote = new ReviewerRemote();
      const first = fixture.buildServices(remote);
      first.finalizers.run = vi.fn(async () => {
        throw new Error("process terminated before failure-check finalization");
      });
      const recovery = await processReviewerAbsenceActivationJob(fixture.message, first);
      expect(recovery).toMatchObject({
        phase: "run_finalizer",
        outcome: "no_replacement_available",
        finalizer: { action: "fail_policy" },
      });
      const providerCallsBeforeRevocation = remote.request.mock.calls.length;

      await createWorkspaceRepositories(db, fixture.message.workspaceId)
        .revokeConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" });
      const nextRecovery = await recoverReviewerReplacementFinalizer(
        recovery!,
        fixture.buildServices(remote),
      );

      expect(nextRecovery).toMatchObject({ phase: "run_finalizer", retryable: false });
      expect(remote.request).toHaveBeenCalledTimes(providerCallsBeforeRevocation);
      await expect(db.selectFrom("reviewer_replacements")
        .select(["state", "last_error as lastError"])
        .executeTakeFirstOrThrow()).resolves.toEqual({ state: "finalizer_pending", lastError: null });
    });
  });

  it("keeps a suspended pending policy finalizer retryable without provider access", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "suspended-policy-finalizer");
      const remote = new ReviewerRemote();
      const first = fixture.buildServices(remote);
      first.finalizers.run = vi.fn(async () => {
        throw new Error("process terminated before policy finalization");
      });
      const recovery = await processReviewerAbsenceActivationJob(fixture.message, first);
      const providerCallsBeforeSuspension = remote.request.mock.calls.length;
      await db.updateTable("provider_connections")
        .set({ status: "suspended" })
        .where("id", "=", fixture.connectionId)
        .execute();

      const suspendedRecovery = await recoverReviewerReplacementFinalizer(
        recovery!,
        fixture.buildServices(remote),
      );

      expect(suspendedRecovery).toMatchObject({
        phase: "run_finalizer",
        retryable: true,
        lastError: expect.stringMatching(/suspended|inactive provider connection/i),
      });
      expect(remote.request).toHaveBeenCalledTimes(providerCallsBeforeSuspension);
      await expect(db.selectFrom("reviewer_replacements")
        .select(["state", "last_error as lastError"])
        .executeTakeFirstOrThrow()).resolves.toEqual({ state: "finalizer_pending", lastError: null });
      await expect(db.selectFrom("jobs")
        .select("status")
        .where("id", "=", fixture.lease.jobId)
        .executeTakeFirstOrThrow()).resolves.toEqual({ status: "running" });

      await db.updateTable("provider_connections")
        .set({ status: "active" })
        .where("id", "=", fixture.connectionId)
        .execute();
      await expect(recoverReviewerReplacementFinalizer(
        suspendedRecovery!,
        fixture.buildServices(remote),
      )).resolves.toBeNull();
      expect(remote.policyWriteCount).toBe(1);
      await expect(db.selectFrom("reviewer_replacements")
        .select(["state", "last_error as lastError"])
        .executeTakeFirstOrThrow()).resolves.toEqual({ state: "completed", lastError: null });
    });
  });

  it.each(["suspended", "revoked"] as const)(
    "completes local-only replacement finalization after the connection is %s",
    async (status) => {
      await withPostgresTestDatabase(async (db) => {
        const fixture = await seedActivation(db, `local-completion-${status}`);
        const remote = new ReviewerRemote();
        const first = fixture.buildServices(remote);
        first.finalizers.run = vi.fn(async () => {
          throw new Error("process terminated after policy finalization");
        });
        const recovery = await processReviewerAbsenceActivationJob(fixture.message, first);
        if (recovery?.phase !== "run_finalizer") {
          throw new Error("expected a pending provider-facing finalizer recovery");
        }
        const providerCallsBeforeStatusChange = remote.request.mock.calls.length;
        if (status === "revoked") {
          await createWorkspaceRepositories(db, fixture.message.workspaceId)
            .revokeConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" });
        } else {
          await db.updateTable("provider_connections")
            .set({ status: "suspended" })
            .where("id", "=", fixture.connectionId)
            .execute();
        }

        await expect(recoverReviewerReplacementFinalizer({
          ...recovery,
          phase: "complete_replacement",
        }, fixture.buildServices(remote))).resolves.toBeNull();

        expect(remote.request).toHaveBeenCalledTimes(providerCallsBeforeStatusChange);
        await expect(db.selectFrom("reviewer_replacements")
          .select(["id", "state", "last_error as lastError"])
          .execute()).resolves.toEqual([{
          id: recovery.replacementId,
          state: "completed",
          lastError: null,
        }]);
      });
    },
  );

  it.each(["suspended", "revoked"] as const)(
    "serializes a pending policy finalizer ahead of concurrent connection %s",
    async (status) => {
      await withPostgresTestDatabase(async (db) => {
        const fixture = await seedActivation(db, `concurrent-finalizer-${status}`);
        const remote = new ReviewerRemote();
        const first = fixture.buildServices(remote);
        first.finalizers.run = vi.fn(async () => {
          throw new Error("process terminated before policy finalization");
        });
        const recovery = await processReviewerAbsenceActivationJob(fixture.message, first);
        let releaseProvider!: () => void;
        let providerReached!: () => void;
        const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
        const reached = new Promise<void>((resolve) => { providerReached = resolve; });
        remote.beforeRequest = async () => {
          remote.beforeRequest = null;
          providerReached();
          await release;
        };

        const finalizing = recoverReviewerReplacementFinalizer(recovery!, fixture.buildServices(remote));
        await reached;
        const statusChange = status === "revoked"
          ? createWorkspaceRepositories(db, fixture.message.workspaceId)
              .revokeConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" })
          : db.updateTable("provider_connections")
              .set({ status: "suspended" })
              .where("id", "=", fixture.connectionId)
              .execute();

        expect(await settlesWithin(statusChange, 100)).toBe(false);
        await expect(db.selectFrom("provider_connections")
          .select("status")
          .where("id", "=", fixture.connectionId)
          .executeTakeFirstOrThrow()).resolves.toEqual({ status: "active" });
        releaseProvider();
        await expect(finalizing).resolves.toBeNull();
        await statusChange;

        expect(remote.policyWriteCount).toBe(1);
        await expect(db.selectFrom("provider_connections")
          .select("status")
          .where("id", "=", fixture.connectionId)
          .executeTakeFirstOrThrow()).resolves.toEqual({ status });
        await expect(db.selectFrom("reviewer_replacements")
          .select(["state", "last_error as lastError"])
          .executeTakeFirstOrThrow()).resolves.toEqual({ state: "completed", lastError: null });
      });
    },
  );

  it("prevents later policy requests after finalizer authority ends and revocation commits", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "timed-out-policy-finalizer");
      const remote = new ReviewerRemote();
      const first = fixture.buildServices(remote);
      first.finalizers.run = vi.fn(async () => {
        throw new Error("process terminated before policy finalization");
      });
      const recovery = await processReviewerAbsenceActivationJob(fixture.message, first);
      let releaseProvider!: () => void;
      let providerReached!: () => void;
      const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
      const reached = new Promise<void>((resolve) => { providerReached = resolve; });
      remote.beforeRequest = async () => {
        remote.beforeRequest = null;
        providerReached();
        await release;
      };

      const finalizing = recoverReviewerReplacementFinalizer(
        recovery!,
        fixture.buildServices(remote, { providerMutationTimeoutMs: 50 }),
      );
      await reached;
      await expect(finalizing).resolves.toMatchObject({
        phase: "run_finalizer",
        retryable: true,
        lastError: expect.stringMatching(/deadline|authority/i),
      });
      await createWorkspaceRepositories(db, fixture.message.workspaceId)
        .revokeConfiguredProviderConnection({ provider: "github", externalConnectionId: "99" });
      const providerCallsAtRevocation = remote.request.mock.calls.length;
      releaseProvider();
      await new Promise((resolve) => setTimeout(resolve, 75));

      expect(remote.request).toHaveBeenCalledTimes(providerCallsAtRevocation);
      expect(remote.policyWriteCount).toBe(0);
      await expect(db.selectFrom("reviewer_replacements")
        .select(["state", "last_error as lastError"])
        .executeTakeFirstOrThrow()).resolves.toEqual({ state: "finalizer_pending", lastError: null });
    });
  });

  it("continues the same activation from recovered A to fresh B without replaying A provider effects", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "continue-fresh");
      await seedAdditionalCandidate(db, fixture, "continue-fresh-b", 8);
      const remote = new ReviewerRemote();
      const first = fixture.buildServices(remote);
      first.finalizers.run = vi.fn(async () => {
        throw new Error("A finalizer interrupted");
      });
      const recoveryA = await processReviewerAbsenceActivationJob(fixture.message, first);
      expect(recoveryA).toMatchObject({ phase: "run_finalizer", lastError: "A finalizer interrupted" });
      expect(remote.mutationCounts(7)).toEqual({ deletes: 1, posts: 1 });
      expect(remote.mutationCounts(8)).toEqual({ deletes: 0, posts: 0 });

      const retry = fixture.buildServices(remote);
      retry.finalizers.run = vi.fn(async () => {});
      await expect(recoverReviewerReplacementFinalizer(recoveryA!, retry)).resolves.toBeNull();
      await expect(processReviewerAbsenceActivationJob(fixture.message, retry)).resolves.toBeNull();

      expect(remote.mutationCounts(7)).toEqual({ deletes: 1, posts: 1 });
      expect(remote.mutationCounts(8)).toEqual({ deletes: 1, posts: 1 });
      await expect(db.selectFrom("reviewer_replacements").select("state").orderBy("decision_id").execute())
        .resolves.toHaveLength(2);
    });
  });

  it("continues the same activation from recovered A to pending-finalizer B", async () => {
    await withPostgresTestDatabase(async (db) => {
      const fixture = await seedActivation(db, "continue-pending");
      await seedAdditionalCandidate(db, fixture, "continue-pending-b", 8);
      const remote = new ReviewerRemote();
      const first = fixture.buildServices(remote);
      first.finalizers.run = vi.fn(async () => {
        throw new Error("A finalizer interrupted");
      });
      const recoveryA = await processReviewerAbsenceActivationJob(fixture.message, first);

      const retry = fixture.buildServices(remote);
      retry.finalizers.run = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("B finalizer interrupted"));
      await expect(recoverReviewerReplacementFinalizer(recoveryA!, retry)).resolves.toBeNull();
      const recoveryB = await processReviewerAbsenceActivationJob(fixture.message, retry);

      expect(recoveryB).toMatchObject({
        phase: "run_finalizer",
        lastError: "B finalizer interrupted",
        replacementId: expect.any(String),
      });
      expect(recoveryB!.replacementId).not.toBe(recoveryA!.replacementId);
      expect(remote.mutationCounts(7)).toEqual({ deletes: 1, posts: 1 });
      expect(remote.mutationCounts(8)).toEqual({ deletes: 1, posts: 1 });
    });
  });

  it.each([
    ["prepare", "revise"],
    ["prepare", "cancel"],
    ["prepare", "suspend"],
    ["delete", "revise"],
    ["delete", "cancel"],
    ["delete", "suspend"],
    ["post", "revise"],
    ["post", "cancel"],
    ["post", "suspend"],
  ] as const)(
    "audits an orphaned %s-phase intent without provider replay after absence %s",
    async (crashPhase, adminMutation) => {
      await withPostgresTestDatabase(async (db) => {
        const fixture = await seedActivation(db, `orphan-${crashPhase}-${adminMutation}`);
        const remote = new ReviewerRemote();
        const first = fixture.buildServices(remote);
        first.finalizers.run = vi.fn(async () => {});

        if (crashPhase === "prepare") {
          const prepare = first.availability.prepareMutationIntent;
          first.availability.prepareMutationIntent = async (input) => {
            await prepare(input);
            throw new Error("process terminated after prepare");
          };
          await expect(processReviewerAbsenceActivationJob(fixture.message, first))
            .rejects.toThrow("process terminated after prepare");
        } else if (crashPhase === "delete") {
          remote.failAfterNextDelete = true;
          await expect(processReviewerAbsenceActivationJob(fixture.message, first))
            .rejects.toThrow("process terminated between DELETE and POST");
        } else {
          first.availability.persistReplacement = async () => {
            throw new Error("process terminated after POST");
          };
          await expect(processReviewerAbsenceActivationJob(fixture.message, first)).resolves.toMatchObject({
            phase: "persist_replacement",
            lastError: "process terminated after POST",
          });
        }

        const intent = await db.selectFrom("reviewer_mutation_intents")
          .select("id")
          .executeTakeFirstOrThrow();
        const providerEffectsBeforeRetry = { deletes: remote.deleteCount, posts: remote.postCount };
        await applyAdminMutation(db, fixture, adminMutation);

        const retry = fixture.buildServices(remote);
        retry.reviewerLoad = vi.fn(async () => {
          throw new Error("orphan recovery must not select a new actor");
        });
        retry.finalizers.run = vi.fn(async () => {
          throw new Error("orphan recovery must not run a finalizer");
        });
        await expect(processReviewerAbsenceActivationJob(fixture.message, retry)).resolves.toBeNull();

        expect(retry.reviewerLoad).not.toHaveBeenCalled();
        expect(remote.deleteCount).toBe(providerEffectsBeforeRetry.deletes);
        expect(remote.postCount).toBe(providerEffectsBeforeRetry.posts);
        await expect(db.selectFrom("reviewer_replacements")
          .select(["outcome", "state", "last_error as lastError", "mutation_intent_id as mutationIntentId"])
          .executeTakeFirstOrThrow()).resolves.toEqual({
          outcome: "permanent_failure",
          state: "permanent_failure",
          lastError: "Durable reviewer mutation intent could not resume after activation scope changed.",
          mutationIntentId: intent.id,
        });
        await expect(db.selectFrom("routing_decisions")
          .select("selected_reviewers as selectedReviewers")
          .where("id", "=", fixture.decisionId)
          .executeTakeFirstOrThrow()).resolves.toEqual({ selectedReviewers: [unavailableActor] });
      });
    },
  );
});

function holdAbsenceLock(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  fixture: Awaited<ReturnType<typeof seedActivation>>,
) {
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const locked = new Promise<void>((resolve) => { acquired = resolve; });
  const transaction = db.transaction().execute(async (trx) => {
    await trx.selectFrom("reviewer_absences").select("id")
      .where("id", "=", fixture.absence.id).forUpdate().executeTakeFirstOrThrow();
    acquired();
    await gate;
  });
  return { acquired: locked, release, transaction };
}

async function waitForBlockedAbsenceAuthority(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const activity = await db.selectFrom("pg_stat_activity" as "jobs").selectAll().execute() as unknown as Array<{
      wait_event_type: string | null;
      query: string;
    }>;
    if (activity.some((row) => row.wait_event_type === "Lock" && row.query.includes("reviewer_absences"))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("provider authority did not block on the reviewer absence lock");
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    operation.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function seedActivation(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  suffix: string,
  originalActors = eligibleActors,
) {
  const workspaceId = await ensureLocalWorkspace(db);
  const connection = await db.insertInto("provider_connections").values({
    workspace_id: workspaceId,
    provider: "github",
    external_connection_id: "99",
    workspace_login: "example",
    account_type: "Organization",
    status: "active",
    permissions: {},
  }).returning("id").executeTakeFirstOrThrow();
  const repository = await db.insertInto("repositories").values({
    workspace_id: workspaceId,
    provider: "github",
    provider_connection_id: connection.id,
    external_repository_id: `101-${suffix}`,
    owner: "example",
    name: `api-${suffix}`,
    default_branch: "main",
    config_state: "valid",
  }).returning("id").executeTakeFirstOrThrow();
  const availability = createWorkspaceReviewerAvailability(db, workspaceId);
  const absence = await availability.scheduleAbsence({
    provider: "github",
    providerConnectionId: connection.id,
    externalActorId: unavailableActor,
    startAt: new Date("2026-09-01T11:00:00.000Z"),
    endAt: new Date("2026-09-01T13:00:00.000Z"),
    now: new Date("2026-09-01T10:00:00.000Z"),
  });
  await persistDecision(db, workspaceId, {
    repositoryId: repository.id,
    deliveryId: `delivery-${suffix}`,
    routingKey: `routing-${suffix}`,
    changeRequestId: "7",
    pullNumber: 7,
    headSha: "head-1",
    mode: "enforce",
    action: "request_human_review",
    actionStatus: "pending",
    riskScore: 50,
    selectedReviewers: [unavailableActor],
    details: {
      ownership: {
        preferredReviewers: originalActors,
        eligibleReviewers: originalActors,
      },
      routing: { requestedReviewerCount: 1 },
    },
  });
  const message = {
    kind: "activate_reviewer_absence" as const,
    workspaceId,
    provider: "github" as const,
    providerConnectionId: connection.id,
    absenceId: absence.id,
    absenceRevision: absence.revision,
  };
  const claimed = await db.updateTable("jobs").set({
    status: "running", locked_at: now, locked_by: "runtime-crash-worker", attempt_count: 1,
  }).where("workspace_id", "=", workspaceId).where("kind", "=", "activate_reviewer_absence")
    .where("status", "=", "queued").returningAll().executeTakeFirstOrThrow();
  const lease = {
    jobId: claimed.id, workspaceId, provider: claimed.provider,
    providerConnectionId: claimed.provider_connection_id, lockedBy: claimed.locked_by!, lockedAt: claimed.locked_at!,
    attemptCount: claimed.attempt_count, maxAttempts: claimed.max_attempts,
  };
  return {
    message,
    absence,
    availability,
    decisionId: (await db.selectFrom("routing_decisions")
      .select("id")
      .where("routing_key", "=", `routing-${suffix}`)
      .executeTakeFirstOrThrow()).id,
    connectionId: connection.id,
    repositoryRecordId: repository.id,
    lease,
    buildServices(remote: ReviewerRemote, options: { providerMutationTimeoutMs?: number } = {}) {
      return createWorkerReviewerAvailabilityServiceFactory({
        db,
        github: { appId: "123", privateKey: "test" },
        createRequester: async () => ({ request: remote.request }) as never,
        clock: { now: () => now },
        ...options,
      })(message, lease);
    },
  };
}

async function seedAdditionalCandidate(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  fixture: Awaited<ReturnType<typeof seedActivation>>,
  suffix: string,
  pullNumber: number,
) {
  await persistDecision(db, fixture.message.workspaceId, {
    repositoryId: fixture.repositoryRecordId,
    deliveryId: `delivery-${suffix}`,
    routingKey: `routing-${suffix}`,
    changeRequestId: String(pullNumber),
    pullNumber,
    headSha: "head-1",
    mode: "enforce",
    action: "request_human_review",
    actionStatus: "pending",
    riskScore: 50,
    selectedReviewers: [unavailableActor],
    details: {
      ownership: {
        preferredReviewers: eligibleActors,
        eligibleReviewers: eligibleActors,
      },
      routing: { requestedReviewerCount: 1 },
    },
  });
}

async function applyAdminMutation(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  fixture: Awaited<ReturnType<typeof seedActivation>>,
  mutation: "revise" | "cancel" | "suspend",
) {
  if (mutation === "revise") {
    await fixture.availability.reviseAbsence({
      provider: "github",
      providerConnectionId: fixture.connectionId,
      absenceId: fixture.absence.id,
      expectedRevision: fixture.absence.revision,
      externalActorId: "@user-a81c73",
      startAt: new Date("2026-09-01T10:00:00.000Z"),
      endAt: new Date("2026-09-01T14:00:00.000Z"),
      now,
    });
    return;
  }
  if (mutation === "cancel") {
    await fixture.availability.cancelAbsence({
      provider: "github",
      providerConnectionId: fixture.connectionId,
      absenceId: fixture.absence.id,
      expectedRevision: fixture.absence.revision,
      now,
    });
    return;
  }
  await db.updateTable("provider_connections")
    .set({ status: "suspended" })
    .where("id", "=", fixture.connectionId)
    .execute();
}

class ReviewerRemote {
  readonly requestedByPull = new Map<number, Set<string>>([[7, new Set([unavailableActor])]]);
  deleteCount = 0;
  postCount = 0;
  policyWriteCount = 0;
  failAfterNextDelete = false;
  beforeDelete: ((signal?: AbortSignal) => Promise<void>) | null = null;
  beforeRequest: (() => Promise<void>) | null = null;

  readonly request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    await this.beforeRequest?.();
    const pullNumber = Number(parameters.pull_number);
    const requested = this.reviewers(pullNumber);
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", head: { sha: "head-1" }, user: { login: "user-a91f5c" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
      if (this.failAfterNextDelete && this.deleteCount > 0) {
        this.failAfterNextDelete = false;
        throw new Error("process terminated between DELETE and POST");
      }
      return { data: { users: [...requested].map((actor) => ({ login: actor.slice(1) })), teams: [] } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data: [] };
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
      return { data: { check_runs: [] } };
    }
    if (route === "POST /repos/{owner}/{repo}/check-runs") {
      this.policyWriteCount += 1;
      return { data: { id: 72 } };
    }
    if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
      this.policyWriteCount += 1;
      return { data: {} };
    }
    if (route === "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
      const signal = (parameters.request as { signal?: AbortSignal } | undefined)?.signal;
      if (this.beforeDelete !== null) await this.beforeDelete(signal);
      signal?.throwIfAborted();
      this.deleteCount += 1;
      for (const reviewer of parameters.reviewers as string[]) requested.delete(`@${reviewer}`);
      return { data: {} };
    }
    if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
      this.postCount += 1;
      for (const reviewer of parameters.reviewers as string[]) requested.add(`@${reviewer}`);
      return { data: {} };
    }
    throw new Error(`unexpected GitHub route: ${route}`);
  });

  counts() {
    return { requests: this.request.mock.calls.length, deletes: this.deleteCount, posts: this.postCount };
  }

  get requested() {
    return this.reviewers(7);
  }

  reviewers(pullNumber: number) {
    const existing = this.requestedByPull.get(pullNumber);
    if (existing !== undefined) return existing;
    const created = new Set([unavailableActor]);
    this.requestedByPull.set(pullNumber, created);
    return created;
  }

  mutationCounts(pullNumber: number) {
    const calls = this.request.mock.calls as [string, Record<string, unknown>][];
    return {
      deletes: calls.filter(([route, parameters]) => route.startsWith("DELETE ") && parameters.pull_number === pullNumber).length,
      posts: calls.filter(([route, parameters]) => route.startsWith("POST ") && parameters.pull_number === pullNumber).length,
    };
  }
}
