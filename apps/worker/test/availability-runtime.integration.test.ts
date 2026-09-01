import { describe, expect, it, vi } from "vitest";

import {
  createWorkspaceReviewerAvailability,
  ensureLocalWorkspace,
  persistDecision,
} from "@triagepilot/db";
import { withPostgresTestDatabase } from "../../../packages/db/test/postgres";
import { processReviewerAbsenceActivationJob } from "../src/availability-processor";
import { createWorkerReviewerAvailabilityServiceFactory } from "../src/runtime-services";

const now = new Date("2026-09-01T12:00:00.000Z");
const unavailableActor = "@user-d82a5f";
const eligibleActors = [unavailableActor, "@user-c91e46", "@user-f37a82"];

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("worker reviewer availability runtime crash recovery", () => {
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
});

async function seedActivation(
  db: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0],
  suffix: string,
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
        preferredReviewers: eligibleActors,
        eligibleReviewers: eligibleActors,
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
  return {
    message,
    buildServices(remote: ReviewerRemote) {
      return createWorkerReviewerAvailabilityServiceFactory({
        db,
        github: { appId: "123", privateKey: "test" },
        createRequester: async () => ({ request: remote.request }) as never,
        clock: { now: () => now },
      })(message);
    },
  };
}

class ReviewerRemote {
  readonly requested = new Set([unavailableActor]);
  deleteCount = 0;
  postCount = 0;
  failAfterNextDelete = false;

  readonly request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: { state: "open", head: { sha: "head-1" }, user: { login: "user-a91f5c" } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
      if (this.failAfterNextDelete && this.deleteCount > 0) {
        this.failAfterNextDelete = false;
        throw new Error("process terminated between DELETE and POST");
      }
      return { data: { users: [...this.requested].map((actor) => ({ login: actor.slice(1) })), teams: [] } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data: [] };
    if (route === "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
      this.deleteCount += 1;
      for (const reviewer of parameters.reviewers as string[]) this.requested.delete(`@${reviewer}`);
      return { data: {} };
    }
    if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
      this.postCount += 1;
      for (const reviewer of parameters.reviewers as string[]) this.requested.add(`@${reviewer}`);
      return { data: {} };
    }
    throw new Error(`unexpected GitHub route: ${route}`);
  });

  counts() {
    return { requests: this.request.mock.calls.length, deletes: this.deleteCount, posts: this.postCount };
  }
}
