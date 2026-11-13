import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "./kysely.js";
import type { JobLease } from "./jobs.js";
import { queueAuthority, type QueueInstallationKey } from "./pull-request-projection.js";

type Tx = Transaction<Database>;
export interface QueueSyncRepository { repositoryId: string; externalRepositoryId: string }
export interface QueueSyncToken { selectionRevision: string; revision: number; lease: JobLease; repository: QueueSyncRepository | null; previousRepository: QueueSyncRepository | null }
export interface QueueSyncRun { runId: string; status: "queued" | "running" | "succeeded" | "failed"; checkpoint: unknown; membershipComplete: boolean; classificationComplete: boolean; verifiedAt: Date | null; verificationError: string | null; revision: number; jobId: string | null; updatedAt: Date }
function runs(trx: Tx, scope: QueueInstallationKey, runId: string) {
  return trx.selectFrom("queue_sync_runs").selectAll().where("id", "=", runId).where("workspace_id", "=", scope.workspaceId).where("provider_connection_id", "=", scope.providerConnectionId).where("external_installation_id", "=", scope.externalInstallationId);
}
async function enqueue(trx: Tx, scope: QueueInstallationKey, runId: string, epoch: number, runAt: Date = new Date()): Promise<string> {
  return (await trx.insertInto("jobs").values({ workspace_id: scope.workspaceId, provider: "github", provider_connection_id: scope.providerConnectionId, external_installation_id: scope.externalInstallationId, external_repository_id: null, kind: "reconcile_queue_connection", run_at: runAt, payload: { kind: "reconcile_queue_connection", ...scope, runId }, idempotency_key: `queue-sync:${runId}:${epoch}` }).returning("id").executeTakeFirstOrThrow()).id;
}
async function leaseValid(trx: Tx, scope: QueueInstallationKey, lease: JobLease, jobId: string | null): Promise<boolean> {
  if (lease.jobId !== jobId || lease.workspaceId !== scope.workspaceId || lease.provider !== "github" || lease.providerConnectionId !== scope.providerConnectionId) return false;
  return Boolean(await trx.selectFrom("jobs").select("id").where("id", "=", lease.jobId).where("workspace_id", "=", scope.workspaceId).where("provider_connection_id", "=", scope.providerConnectionId).where("external_installation_id", "=", scope.externalInstallationId).where("kind", "=", "reconcile_queue_connection").where("status", "=", "running").where("locked_by", "=", lease.lockedBy).where("locked_at", "=", lease.lockedAt).where("attempt_count", "=", lease.attemptCount).where(sql<boolean>`locked_at > now() - interval '15 minutes'`).forUpdate().executeTakeFirst());
}
export async function startQueueSyncRun(db: Kysely<Database>, scope: QueueInstallationKey): Promise<{ runId: string; jobId: string; state: "scheduled" | "running" }> {
  return db.transaction().execute(trx => startQueueSyncRunTransaction(trx, scope));
}
async function startQueueSyncRunTransaction(trx: Tx, scope: QueueInstallationKey): Promise<{ runId: string; jobId: string; state: "scheduled" | "running" }> {
    if (!await queueAuthority(trx, scope)) throw new Error("queue authority unavailable");
    const connection = await trx.selectFrom("provider_connections").select("queue_selection_revision").where("id", "=", scope.providerConnectionId).where("workspace_id", "=", scope.workspaceId).executeTakeFirstOrThrow();
    const current = await trx.selectFrom("queue_sync_runs").selectAll().where("workspace_id", "=", scope.workspaceId).where("provider_connection_id", "=", scope.providerConnectionId).where("external_installation_id", "=", scope.externalInstallationId).where("status", "in", ["queued", "running"]).forUpdate().executeTakeFirst();
    if (current) {
      const job = current.dispatch_job_id ? await trx.selectFrom("jobs").select("status").where("id", "=", current.dispatch_job_id).executeTakeFirst() : undefined;
      if (current.selection_revision === connection.queue_selection_revision && job && current.dispatch_job_id && (job.status === "queued" || job.status === "running")) return { runId: current.id, jobId: current.dispatch_job_id, state: "running" };
      if (current.selection_revision !== connection.queue_selection_revision && current.dispatch_job_id) await trx.updateTable("jobs").set({ status: "failed", locked_at: null, locked_by: null, last_error: "queue selection changed during sync", updated_at: new Date() }).where("id", "=", current.dispatch_job_id).where("status", "in", ["queued", "running"]).execute();
      await trx.updateTable("queue_sync_runs").set({ status: "failed", updated_at: new Date() }).where("id", "=", current.id).execute();
    }
    const run = await trx.insertInto("queue_sync_runs").values({ selection_revision: connection.queue_selection_revision, workspace_id: scope.workspaceId, provider_connection_id: scope.providerConnectionId, external_installation_id: scope.externalInstallationId, status: "queued", checkpoint: "{}" }).returning("id").executeTakeFirstOrThrow();
    const jobId = await enqueue(trx, scope, run.id, 1);
    await trx.updateTable("queue_sync_runs").set({ dispatch_job_id: jobId }).where("id", "=", run.id).execute();
    return { runId: run.id, jobId, state: "scheduled" };
}
export async function claimQueueSyncCheckpoint(db: Kysely<Database>, scope: QueueInstallationKey, runId: string, lease: JobLease, repository: QueueSyncRepository | null = null): Promise<QueueSyncToken> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, scope, repository ?? undefined)) throw new Error("queue authority unavailable");
    const observed = await runs(trx, scope, runId).executeTakeFirst();
    if (!observed) throw new Error("queue sync lease unavailable");
    if (observed.checkpoint_repository_id && observed.checkpoint_external_repository_id && !await queueAuthority(trx, scope, { repositoryId: observed.checkpoint_repository_id, externalRepositoryId: observed.checkpoint_external_repository_id })) throw new Error("queue authority unavailable");
    const run = await runs(trx, scope, runId).forUpdate().executeTakeFirst();
    if (!run || run.revision !== observed.revision || !["queued", "running"].includes(run.status) || !await leaseValid(trx, scope, lease, run.dispatch_job_id)) throw new Error("queue sync lease unavailable");
    await trx.updateTable("queue_sync_runs").set({ status: "running", updated_at: new Date() }).where("id", "=", runId).execute();
    const connection = await trx.selectFrom("provider_connections").select("queue_selection_revision").where("id", "=", scope.providerConnectionId).where("workspace_id", "=", scope.workspaceId).executeTakeFirstOrThrow();
    if (connection.queue_selection_revision !== run.selection_revision) throw new Error("queue selection changed during sync");
    const previousRepository = run.checkpoint_repository_id && run.checkpoint_external_repository_id ? { repositoryId: run.checkpoint_repository_id, externalRepositoryId: run.checkpoint_external_repository_id } : null;
    return { selectionRevision: connection.queue_selection_revision, revision: run.revision, lease, repository, previousRepository };
  });
}
export async function commitQueueSyncCheckpoint(db: Kysely<Database>, scope: QueueInstallationKey, runId: string, token: QueueSyncToken, checkpoint: unknown): Promise<boolean> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, scope, token.repository ?? undefined)) return false;
    if (token.previousRepository && !await queueAuthority(trx, scope, token.previousRepository)) return false;
    const connection = await trx.selectFrom("provider_connections").select("queue_selection_revision").where("id", "=", scope.providerConnectionId).where("workspace_id", "=", scope.workspaceId).executeTakeFirst();
    if (!connection || connection.queue_selection_revision !== token.selectionRevision) return false;
    const run = await runs(trx, scope, runId).forUpdate().executeTakeFirst();
    if (!run || run.selection_revision !== token.selectionRevision || run.status !== "running" || run.revision !== token.revision || !await leaseValid(trx, scope, token.lease, run.dispatch_job_id)) return false;
    await trx.updateTable("queue_sync_runs").set({ checkpoint: JSON.stringify(checkpoint), checkpoint_repository_id: token.repository?.repositoryId ?? null, checkpoint_external_repository_id: token.repository?.externalRepositoryId ?? null, revision: run.revision + 1, updated_at: new Date() }).where("id", "=", runId).execute();
    return true;
  });
}
export async function completeQueueSyncChunk(db: Kysely<Database>, scope: QueueInstallationKey, runId: string, lease: JobLease, options: { done: boolean }): Promise<{ state: "continued" | "completed" | "stale_lease" }> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, scope)) return { state: "stale_lease" };
    const observed = await runs(trx, scope, runId).executeTakeFirst();
    if (!observed) return { state: "stale_lease" };
    const repo = observed.checkpoint_repository_id && observed.checkpoint_external_repository_id ? { repositoryId: observed.checkpoint_repository_id, externalRepositoryId: observed.checkpoint_external_repository_id } : undefined;
    if (repo && !await queueAuthority(trx, scope, repo)) return { state: "stale_lease" };
    const run = await runs(trx, scope, runId).forUpdate().executeTakeFirst();
    const connection = await trx.selectFrom("provider_connections").select("queue_selection_revision").where("workspace_id", "=", scope.workspaceId).where("id", "=", scope.providerConnectionId).executeTakeFirst();
    if (!run || !connection || run.selection_revision !== connection.queue_selection_revision || run.revision !== observed.revision || run.status !== "running" || !await leaseValid(trx, scope, lease, run.dispatch_job_id)) return { state: "stale_lease" };
    if (options.done && (!run.membership_complete || !run.classification_complete || !run.verified_at)) return { state: "stale_lease" };
    if (run.verification_error) {
      await trx.updateTable("jobs").set({ status: "failed", locked_at: null, locked_by: null, last_error: run.verification_error, updated_at: new Date() }).where("id", "=", lease.jobId).execute();
      await trx.updateTable("queue_sync_runs").set({ status: "failed", dispatch_job_id: null, updated_at: new Date() }).where("id", "=", runId).execute();
      return { state: "completed" };
    }
    await trx.updateTable("jobs").set({ status: "succeeded", locked_at: null, locked_by: null, updated_at: new Date() }).where("id", "=", lease.jobId).execute();
    const epoch = run.dispatch_epoch + 1;
    const runAt = run.membership_complete && !run.classification_complete ? new Date(Date.now() + 2000) : new Date();
    const jobId = options.done ? null : await enqueue(trx, scope, runId, epoch, runAt);
    await trx.updateTable("queue_sync_runs").set({ status: options.done ? "succeeded" : "queued", dispatch_epoch: options.done ? run.dispatch_epoch : epoch, dispatch_job_id: jobId, updated_at: new Date() }).where("id", "=", runId).execute();
    return { state: options.done ? "completed" : "continued" };
  });
}
export async function readQueueSyncRun(db: Kysely<Database>, scope: QueueInstallationKey, runId: string): Promise<QueueSyncRun | null> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, scope)) throw new Error("queue authority unavailable");
    const run = await runs(trx, scope, runId).executeTakeFirst();
    if (!run) return null;
    const connection = await trx.selectFrom("provider_connections").select("queue_selection_revision").where("workspace_id", "=", scope.workspaceId).where("id", "=", scope.providerConnectionId).executeTakeFirstOrThrow();
    if (run.selection_revision !== connection.queue_selection_revision) throw new Error("queue selection changed during sync");
    if (run.checkpoint_repository_id && run.checkpoint_external_repository_id && !await queueAuthority(trx, scope, { repositoryId: run.checkpoint_repository_id, externalRepositoryId: run.checkpoint_external_repository_id })) throw new Error("queue authority unavailable");
    return { runId: run.id, status: run.status, checkpoint: run.checkpoint, membershipComplete: run.membership_complete, classificationComplete: run.classification_complete, verifiedAt: run.verified_at, verificationError: run.verification_error, revision: run.revision, jobId: run.dispatch_job_id, updatedAt: run.updated_at };
  });
}

/** Apply a provider page and its checkpoint in one transaction. An absent pull is only
 * scheduled for an individual refresh after the repository's complete scan. */
export async function commitQueueSyncPage(
  db: Kysely<Database>, scope: QueueInstallationKey, runId: string, token: QueueSyncToken,
  checkpoint: unknown,
  effect: { type: "inventory"; repositories: import("@triagepilot/contracts").RepositoryRef[] }
    | { type: "pulls"; repository: import("@triagepilot/contracts").RepositoryRef; pulls: import("@triagepilot/contracts").QueuePullRequest[]; complete: boolean }
    | { type: "missing"; repository: import("@triagepilot/contracts").RepositoryRef; nextCheckpoint: unknown }
    | { type: "finish" },
): Promise<boolean> {
  const { materializeQueueRepository, lockProviderConnectionProjection } = await import("./provider-connections.js");
  const { invalidateQueuePullTransaction } = await import("./pull-request-projection.js");
  class Stale extends Error {}
  try {
    return await db.transaction().execute(async trx => {
      await lockProviderConnectionProjection(trx, scope.workspaceId);
      if (!await queueAuthority(trx, scope, token.repository ?? undefined)) throw new Stale();
      if (token.previousRepository && !await queueAuthority(trx, scope, token.previousRepository)) throw new Stale();
      const connection = await trx.selectFrom("provider_connections").select("queue_selection_revision").where("id", "=", scope.providerConnectionId).where("workspace_id", "=", scope.workspaceId).executeTakeFirst();
      if (!connection || connection.queue_selection_revision !== token.selectionRevision) throw new Stale();
      let repository: QueueSyncRepository | null = null;
      if (effect.type === "inventory") {
        await sql`select set_config('triage.queue_scan_materialization', '1', true)`.execute(trx);
        for (const item of effect.repositories) {
          const repo = await materializeQueueRepository(trx, scope, { provider: item.provider, externalRepositoryId: item.externalId, owner: item.owner, name: item.name });
          await trx.insertInto("queue_sync_scan_members").values({ run_id: runId, repository_id: repo.repositoryId, external_repository_id: repo.externalRepositoryId, pull_number: 0 }).execute();
        }
        await sql`select set_config('triage.queue_scan_materialization', '0', true)`.execute(trx);
      } else if (effect.type === "pulls") {
        const selected = await trx.selectFrom("repositories").select("id").where("workspace_id", "=", scope.workspaceId).where("provider_connection_id", "=", scope.providerConnectionId).where("provider", "=", "github").where("external_repository_id", "=", effect.repository.externalId).forUpdate().executeTakeFirst();
        if (!selected) throw new Stale();
        repository = { repositoryId: selected.id, externalRepositoryId: effect.repository.externalId };
        if (!await queueAuthority(trx, scope, repository)) throw new Stale();
        const member = await trx.selectFrom("queue_sync_scan_members").select("run_id").where("run_id", "=", runId).where("repository_id", "=", repository.repositoryId).where("external_repository_id", "=", repository.externalRepositoryId).where("pull_number", "=", 0).executeTakeFirst();
        if (!member) throw new Stale();
        for (const pull of effect.pulls) {
          if (pull.repository.externalId !== repository.externalRepositoryId || !Number.isSafeInteger(pull.number) || pull.number <= 0) throw new Error("invalid queue scan member");
          await trx.insertInto("queue_sync_scan_members").values({ run_id: runId, repository_id: repository.repositoryId, external_repository_id: repository.externalRepositoryId, pull_number: pull.number }).execute();
          await invalidateQueuePullTransaction(trx, { ...scope, ...repository, pullNumber: pull.number });
        }
      } else if (effect.type === "missing") {
        const selected = await trx.selectFrom("repositories").select("id").where("workspace_id", "=", scope.workspaceId).where("provider_connection_id", "=", scope.providerConnectionId).where("provider", "=", "github").where("external_repository_id", "=", effect.repository.externalId).forUpdate().executeTakeFirst();
        if (!selected) throw new Stale();
        repository = { repositoryId: selected.id, externalRepositoryId: effect.repository.externalId };
        if (!await queueAuthority(trx, scope, repository)) throw new Stale();
        const missing = await trx.selectFrom("queue_pull_work as w").select("w.pull_number").where("w.workspace_id", "=", scope.workspaceId).where("w.provider_connection_id", "=", scope.providerConnectionId).where("w.external_installation_id", "=", scope.externalInstallationId).where("w.repository_id", "=", repository.repositoryId).where("w.external_repository_id", "=", repository.externalRepositoryId)
          .where(sql<boolean>`(w.snapshot is null or w.desired_generation > w.applied_generation or w.snapshot ->> 'isOpen' = 'true')`)
          .where(sql<boolean>`not exists (select 1 from queue_sync_scan_members m where m.run_id = ${runId} and m.repository_id = w.repository_id and m.external_repository_id = w.external_repository_id and m.pull_number = w.pull_number)`)
          .orderBy("w.pull_number").limit(1).executeTakeFirst();
        if (missing) {
          await trx.insertInto("queue_sync_scan_members").values({ run_id: runId, repository_id: repository.repositoryId, external_repository_id: repository.externalRepositoryId, pull_number: missing.pull_number, missing: true }).execute();
          await invalidateQueuePullTransaction(trx, { ...scope, ...repository, pullNumber: missing.pull_number });
        } else checkpoint = effect.nextCheckpoint;

      }
      const run = await runs(trx, scope, runId).forUpdate().executeTakeFirst();
      if (!run || run.selection_revision !== token.selectionRevision || run.status !== "running" || run.revision !== token.revision || !await leaseValid(trx, scope, token.lease, run.dispatch_job_id)) throw new Stale();
      let membershipComplete = run.membership_complete, classificationComplete = run.classification_complete;
      let verificationError: string | null = null; let verifiedAt: Date | null = null; let accepted = true;
      if (effect.type === "finish") {
        const progress = run.checkpoint as { stage?: unknown; index?: unknown; repositories?: unknown } | null;
        if (!progress || progress.stage !== "pulls" || !Array.isArray(progress.repositories) || !Number.isSafeInteger(progress.index) || Number(progress.index) < progress.repositories.length) throw new Stale();
        membershipComplete = true;
        const pending = await sql<{ failed: boolean }>`select exists (
          select 1 from queue_pull_work w join repositories r on r.id = w.repository_id and r.workspace_id = w.workspace_id and r.provider_connection_id = w.provider_connection_id and r.external_repository_id = w.external_repository_id
          left join jobs j on j.id = w.dispatch_job_id
          where w.workspace_id = ${scope.workspaceId} and w.provider_connection_id = ${scope.providerConnectionId} and w.external_installation_id = ${scope.externalInstallationId}
            and (w.snapshot is null or w.desired_generation > w.applied_generation)
            and (j.id is null or j.status not in ('queued', 'running'))
        ) as failed`.execute(trx);
        const remaining = await sql<{ exists: boolean }>`select exists (
          select 1 from queue_pull_work w join repositories r on r.id = w.repository_id and r.workspace_id = w.workspace_id and r.provider_connection_id = w.provider_connection_id and r.external_repository_id = w.external_repository_id
          where w.workspace_id = ${scope.workspaceId} and w.provider_connection_id = ${scope.providerConnectionId} and w.external_installation_id = ${scope.externalInstallationId}
            and (w.snapshot is null or w.desired_generation > w.applied_generation)
        ) as exists`.execute(trx);
        const incomplete = await sql<{ exists: boolean }>`select exists (
          select 1 from queue_pull_work w join repositories r on r.id = w.repository_id and r.workspace_id = w.workspace_id and r.provider_connection_id = w.provider_connection_id and r.external_repository_id = w.external_repository_id
          where w.workspace_id = ${scope.workspaceId} and w.provider_connection_id = ${scope.providerConnectionId} and w.external_installation_id = ${scope.externalInstallationId}
            and w.snapshot ->> 'isOpen' = 'true' and w.snapshot -> 'pull' ->> 'isDraft' = 'false' and w.snapshot -> 'pull' -> 'author' ->> 'type' <> 'bot'
            and (w.snapshot -> 'reviewState' ->> 'status' is distinct from 'complete' or w.snapshot -> 'reviewState' -> 'lifecycle' ->> 'status' is distinct from 'complete')
        ) as exists`.execute(trx);
        if (pending.rows[0]?.failed) verificationError = "pull request verification failed";
        else if (remaining.rows[0]?.exists) { accepted = false; checkpoint = run.checkpoint; }
        else if (incomplete.rows[0]?.exists) verificationError = "pull request classification incomplete";
        else { classificationComplete = true; verifiedAt = new Date(); }
        if (verificationError) { accepted = false; checkpoint = run.checkpoint; }
      }
      await trx.updateTable("queue_sync_runs").set({ checkpoint: JSON.stringify(checkpoint), checkpoint_repository_id: repository?.repositoryId ?? null, checkpoint_external_repository_id: repository?.externalRepositoryId ?? null, membership_complete: membershipComplete, classification_complete: classificationComplete, verification_error: verificationError, verified_at: verifiedAt, revision: run.revision + 1, updated_at: new Date() }).where("id", "=", runId).execute();
      return accepted;
    });
  } catch (error) { if (error instanceof Stale) return false; throw error; }
}

/** Schedule one run per immutable installation and retain its next due time. */
export async function requestQueueReconciliation(db: Kysely<Database>, scope: QueueInstallationKey, reason: "startup" | "scheduled" | "manual", now = new Date()): Promise<{ state: "scheduled" | "running" | "cooldown" }> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, scope)) throw new Error("queue authority unavailable");
    const connection = await trx.selectFrom("provider_connections").select("queue_selection_revision").where("workspace_id", "=", scope.workspaceId).where("id", "=", scope.providerConnectionId).executeTakeFirstOrThrow();
    const found = await sql<{ next_due: Date; last_manual: Date | null; selection_revision: string }>`select next_due, last_manual, selection_revision from queue_sync_schedule where workspace_id = ${scope.workspaceId} and provider_connection_id = ${scope.providerConnectionId} and external_installation_id = ${scope.externalInstallationId} for update`.execute(trx);
    const current = found.rows[0];
    if (reason === "manual" && current?.last_manual && now.getTime() - current.last_manual.getTime() < 60_000) return { state: "cooldown" };
    if (reason === "scheduled" && current && current.selection_revision === connection.queue_selection_revision && current.next_due > now) return { state: "cooldown" };
    const run = await startQueueSyncRunTransaction(trx, scope);
    const next = new Date(now.getTime() + 15 * 60_000);
    await sql`insert into queue_sync_schedule (workspace_id, provider_connection_id, external_installation_id, next_due, selection_revision, last_manual) values (${scope.workspaceId}, ${scope.providerConnectionId}, ${scope.externalInstallationId}, ${next}, ${connection.queue_selection_revision}, ${reason === "manual" ? now : null}) on conflict (workspace_id, provider_connection_id, external_installation_id) do update set next_due = excluded.next_due, selection_revision = excluded.selection_revision, last_manual = coalesce(excluded.last_manual, queue_sync_schedule.last_manual)`.execute(trx);
    return { state: run.state };
  });
}
