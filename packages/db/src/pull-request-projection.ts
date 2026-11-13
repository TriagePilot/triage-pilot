import { sql, type Kysely, type Transaction } from "kysely";
import type { QueuePullRequest, QueueReviewState, WorkspaceId } from "@triagepilot/contracts";
import type { Database } from "./kysely.js";
import type { JobLease } from "./jobs.js";

export interface QueueInstallationKey { workspaceId: WorkspaceId; providerConnectionId: string; externalInstallationId: string }
export interface QueueProjectionKey extends QueueInstallationKey { repositoryId: string; externalRepositoryId: string; pullNumber: number }
export interface QueueReadToken { generation: number; snapshotRevision: number; lease: JobLease }
export interface QueueSnapshotInput { pull: QueuePullRequest; reviewState: QueueReviewState; isOpen: boolean; verifiedAt: Date }
export interface QueueProjection { syncRun: { runId: string; status: "queued" | "running" | "succeeded" | "failed"; revision: number; jobId: string | null; updatedAt: Date; membershipComplete: boolean; classificationComplete: boolean; verificationError: string | null; verifiedAt: Date | null; completedRepositories: number; totalRepositories: number | null; coveredRepositoryIds: string[]; retryAt: Date | null } | null; lastVerifiedAt: Date | null; runnableClassification: boolean; pendingClassification: boolean; snapshots: Array<{ key: QueueProjectionKey; snapshot: QueueSnapshotInput; revision: number; desiredGeneration: number; appliedGeneration: number }>; }
type Tx = Transaction<Database>;

function fields(key: QueueProjectionKey) {
  return { workspace_id: key.workspaceId, provider_connection_id: key.providerConnectionId, external_installation_id: key.externalInstallationId, repository_id: key.repositoryId, external_repository_id: key.externalRepositoryId, pull_number: key.pullNumber };
}
function workQuery(trx: Tx, key: QueueProjectionKey) {
  return trx.selectFrom("queue_pull_work").selectAll().where("workspace_id", "=", key.workspaceId).where("provider_connection_id", "=", key.providerConnectionId).where("external_installation_id", "=", key.externalInstallationId).where("repository_id", "=", key.repositoryId).where("external_repository_id", "=", key.externalRepositoryId).where("pull_number", "=", key.pullNumber);
}
export async function queueAuthority(trx: Tx, key: QueueInstallationKey, repository?: Pick<QueueProjectionKey, "repositoryId" | "externalRepositoryId">): Promise<boolean> {
  const connection = await trx.selectFrom("provider_connections").select("id").where("workspace_id", "=", key.workspaceId).where("id", "=", key.providerConnectionId).where("provider", "=", "github").where("external_connection_id", "=", key.externalInstallationId).where("status", "=", "active").forUpdate().executeTakeFirst();
  if (!connection) return false;
  if (await trx.selectFrom("provider_connection_revocations").select("revoked_connection_id").where("workspace_id", "=", key.workspaceId).where("provider", "=", "github").where("external_connection_id", "=", key.externalInstallationId).executeTakeFirst()) return false;
  if (!repository) return true;
  return Boolean(await trx.selectFrom("repositories").select("id").where("workspace_id", "=", key.workspaceId).where("provider", "=", "github").where("provider_connection_id", "=", key.providerConnectionId).where("id", "=", repository.repositoryId).where("external_repository_id", "=", repository.externalRepositoryId).forUpdate().executeTakeFirst());
}
async function leaseValid(trx: Tx, key: QueueProjectionKey, lease: JobLease, dispatchJobId: string | null): Promise<boolean> {
  if (lease.workspaceId !== key.workspaceId || lease.provider !== "github" || lease.providerConnectionId !== key.providerConnectionId || lease.jobId !== dispatchJobId) return false;
  return Boolean(await trx.selectFrom("jobs").select("id").where("id", "=", lease.jobId).where("workspace_id", "=", key.workspaceId).where("provider_connection_id", "=", key.providerConnectionId).where("external_installation_id", "=", key.externalInstallationId).where("external_repository_id", "=", key.externalRepositoryId).where("status", "=", "running").where("locked_by", "=", lease.lockedBy).where("locked_at", "=", lease.lockedAt).where("attempt_count", "=", lease.attemptCount).where(sql<boolean>`locked_at > now() - interval '15 minutes'`).forUpdate().executeTakeFirst());
}
async function dispatch(trx: Tx, key: QueueProjectionKey, epoch: number): Promise<string> {
  const job = await trx.insertInto("jobs").values({ workspace_id: key.workspaceId, provider: "github", provider_connection_id: key.providerConnectionId, external_installation_id: key.externalInstallationId, external_repository_id: key.externalRepositoryId, kind: "refresh_queue_pull", payload: { kind: "refresh_queue_pull", ...key }, idempotency_key: `queue-pull:${JSON.stringify([key.providerConnectionId,key.externalInstallationId,key.repositoryId,key.externalRepositoryId,key.pullNumber,epoch])}` }).returning("id").executeTakeFirstOrThrow();
  return job.id;
}
export async function invalidateQueuePullTransaction(trx: Tx, key: QueueProjectionKey): Promise<number> {
  if (!Number.isSafeInteger(key.pullNumber) || key.pullNumber <= 0 || !await queueAuthority(trx, key, key)) throw new Error("queue authority unavailable");
  await trx.insertInto("queue_pull_work").values({ ...fields(key), snapshot: null }).onConflict(oc => oc.doNothing()).execute();
  const row = await workQuery(trx, key).forUpdate().executeTakeFirstOrThrow();
  let jobId = row.dispatch_job_id;
  let epoch = row.dispatch_epoch;
  const existing = jobId && await trx.selectFrom("jobs").select("status").where("id", "=", jobId).executeTakeFirst();
  if (!existing || !["queued", "running"].includes(existing.status)) { epoch++; jobId = await dispatch(trx, key, epoch); }
  const updated = await trx.updateTable("queue_pull_work").set({ desired_generation: row.desired_generation + 1, dispatch_epoch: epoch, dispatch_job_id: jobId, updated_at: new Date() }).where("workspace_id", "=", key.workspaceId).where("provider_connection_id", "=", key.providerConnectionId).where("external_installation_id", "=", key.externalInstallationId).where("repository_id", "=", key.repositoryId).where("external_repository_id", "=", key.externalRepositoryId).where("pull_number", "=", key.pullNumber).returning("desired_generation").executeTakeFirstOrThrow();
  return updated.desired_generation;
}
export async function invalidateQueuePull(db: Kysely<Database>, key: QueueProjectionKey): Promise<number> { return db.transaction().execute(trx => invalidateQueuePullTransaction(trx, key)); }
export async function claimQueueRead(db: Kysely<Database>, key: QueueProjectionKey, lease: JobLease): Promise<QueueReadToken> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, key, key)) throw new Error("queue authority unavailable");
    const row = await workQuery(trx, key).forUpdate().executeTakeFirst();
    if (!row || !await leaseValid(trx, key, lease, row.dispatch_job_id)) throw new Error("queue lease unavailable");
    return { generation: row.desired_generation, snapshotRevision: row.snapshot_revision, lease };
  });
}
export async function commitQueuePull(db: Kysely<Database>, key: QueueProjectionKey, token: QueueReadToken, snapshot: QueueSnapshotInput): Promise<boolean> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, key, key)) return false;
    const row = await workQuery(trx, key).forUpdate().executeTakeFirst();
    if (!row || row.desired_generation !== token.generation || row.snapshot_revision !== token.snapshotRevision || !await leaseValid(trx, key, token.lease, row.dispatch_job_id)) return false;
    if (snapshot.pull.number !== key.pullNumber || snapshot.pull.repository.externalId !== key.externalRepositoryId) return false;
    await trx.updateTable("queue_pull_work").set({ snapshot: JSON.stringify(snapshot), verified_at: snapshot.verifiedAt, snapshot_revision: row.snapshot_revision + 1, applied_generation: token.generation, checkpoint: null, updated_at: new Date() }).where("workspace_id", "=", key.workspaceId).where("provider_connection_id", "=", key.providerConnectionId).where("external_installation_id", "=", key.externalInstallationId).where("repository_id", "=", key.repositoryId).where("external_repository_id", "=", key.externalRepositoryId).where("pull_number", "=", key.pullNumber).execute();
    return true;
  });
}
export async function completeQueueWork(db: Kysely<Database>, key: QueueProjectionKey, lease: JobLease): Promise<{ state: "idle" | "rescheduled" | "stale_lease" }> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, key, key)) return { state: "stale_lease" };
    const row = await workQuery(trx, key).forUpdate().executeTakeFirst();
    if (!row || !await leaseValid(trx, key, lease, row.dispatch_job_id)) return { state: "stale_lease" };
    await trx.updateTable("jobs").set({ status: "succeeded", locked_at: null, locked_by: null, updated_at: new Date() }).where("id", "=", lease.jobId).execute();
    const pending = row.desired_generation > row.applied_generation;
    const epoch = pending ? row.dispatch_epoch + 1 : row.dispatch_epoch;
    const jobId = pending ? await dispatch(trx, key, epoch) : null;
    await trx.updateTable("queue_pull_work").set({ dispatch_job_id: jobId, dispatch_epoch: epoch, updated_at: new Date() }).where("workspace_id", "=", key.workspaceId).where("provider_connection_id", "=", key.providerConnectionId).where("external_installation_id", "=", key.externalInstallationId).where("repository_id", "=", key.repositoryId).where("external_repository_id", "=", key.externalRepositoryId).where("pull_number", "=", key.pullNumber).execute();
    return { state: pending ? "rescheduled" : "idle" };
  });
}
export async function readQueueProjection(db: Kysely<Database>, scope: QueueInstallationKey): Promise<QueueProjection> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, scope)) throw new Error("queue authority unavailable");
    const rows = await trx.selectFrom("queue_pull_work as w").innerJoin("repositories as r", join => join.onRef("r.id", "=", "w.repository_id").onRef("r.workspace_id", "=", "w.workspace_id").onRef("r.provider_connection_id", "=", "w.provider_connection_id").onRef("r.external_repository_id", "=", "w.external_repository_id")).selectAll("w").where("w.workspace_id", "=", scope.workspaceId).where("w.provider_connection_id", "=", scope.providerConnectionId).where("w.external_installation_id", "=", scope.externalInstallationId).where("r.provider", "=", "github").where("w.snapshot", "is not", null).execute();
    const sync = await trx.selectFrom("queue_sync_runs as run").selectAll("run")
      .where("run.workspace_id", "=", scope.workspaceId).where("run.provider_connection_id", "=", scope.providerConnectionId)
      .where("run.external_installation_id", "=", scope.externalInstallationId)
      .where(sql<boolean>`run.selection_revision = (select c.queue_selection_revision from provider_connections c where c.id = run.provider_connection_id and c.workspace_id = run.workspace_id)`)
      .where(sql<boolean>`(run.checkpoint_repository_id is null or exists (select 1 from repositories r
        where r.workspace_id = run.workspace_id and r.provider_connection_id = run.provider_connection_id
          and r.id = run.checkpoint_repository_id and r.external_repository_id = run.checkpoint_external_repository_id))`)
      .orderBy("run.updated_at", "desc").orderBy("run.id", "desc").executeTakeFirst();
    const verified = await trx.selectFrom("queue_sync_runs as run").select("run.verified_at")
      .where("run.workspace_id", "=", scope.workspaceId).where("run.provider_connection_id", "=", scope.providerConnectionId).where("run.external_installation_id", "=", scope.externalInstallationId)
      .where("run.status", "=", "succeeded").where("run.membership_complete", "=", true).where("run.classification_complete", "=", true).where("run.verified_at", "is not", null)
      .where(sql<boolean>`run.selection_revision = (select c.queue_selection_revision from provider_connections c where c.id = run.provider_connection_id and c.workspace_id = run.workspace_id)`)
      .orderBy("run.verified_at", "desc").executeTakeFirst();
    const dirty = await trx.selectFrom("queue_pull_work as w").innerJoin("repositories as r", join => join.onRef("r.id", "=", "w.repository_id").onRef("r.workspace_id", "=", "w.workspace_id").onRef("r.provider_connection_id", "=", "w.provider_connection_id").onRef("r.external_repository_id", "=", "w.external_repository_id")).select("w.pull_number").where("w.workspace_id", "=", scope.workspaceId).where("w.provider_connection_id", "=", scope.providerConnectionId).where("w.external_installation_id", "=", scope.externalInstallationId).where("r.provider", "=", "github").whereRef("w.desired_generation", ">", "w.applied_generation").executeTakeFirst();
    const pending = await trx.selectFrom("queue_pull_work as w").innerJoin("repositories as r", join => join.onRef("r.id", "=", "w.repository_id").onRef("r.workspace_id", "=", "w.workspace_id").onRef("r.provider_connection_id", "=", "w.provider_connection_id").onRef("r.external_repository_id", "=", "w.external_repository_id")).innerJoin("jobs as j", "j.id", "w.dispatch_job_id").select("j.id").where("w.workspace_id", "=", scope.workspaceId).where("w.provider_connection_id", "=", scope.providerConnectionId).where("w.external_installation_id", "=", scope.externalInstallationId).where("r.provider", "=", "github").whereRef("w.desired_generation", ">", "w.applied_generation").where("j.status", "in", ["queued", "running"]).where("j.run_at", "<=", new Date()).executeTakeFirst();
    const job = sync?.dispatch_job_id ? await trx.selectFrom("jobs").select(["status", "run_at"]).where("id", "=", sync.dispatch_job_id).executeTakeFirst() : null;
    const progress = sync?.checkpoint as { repositories?: unknown; stage?: unknown; index?: unknown; totalCount?: unknown } | null;
    const progressRepositories = Array.isArray(progress?.repositories) ? progress.repositories : [];
    const progressIndex = typeof progress?.index === "number" && Number.isSafeInteger(progress.index) ? Math.max(0, Math.min(progress.index, progressRepositories.length)) : 0;
    const coveredRepositoryIds = progressRepositories.slice(0, progressIndex).flatMap((repository: unknown) => typeof repository === "object" && repository !== null && "externalId" in repository && typeof repository.externalId === "string" ? [repository.externalId] : []);
    return { syncRun: sync ? { runId: sync.id, status: sync.status, revision: sync.revision, jobId: sync.dispatch_job_id, updatedAt: sync.updated_at, membershipComplete: sync.membership_complete, classificationComplete: sync.classification_complete, verificationError: sync.verification_error, verifiedAt: sync.verified_at, completedRepositories: coveredRepositoryIds.length, totalRepositories: progress?.stage === "inventory" && typeof progress.totalCount === "number" ? progress.totalCount : Array.isArray(progress?.repositories) && progress?.stage !== "inventory" ? progress.repositories.length : null, coveredRepositoryIds, retryAt: job?.status === "queued" && job.run_at > new Date() ? job.run_at : null } : null, lastVerifiedAt: verified?.verified_at ?? null, runnableClassification: Boolean(pending), pendingClassification: Boolean(dirty), snapshots: rows.map(row => ({ key: { ...scope, repositoryId: row.repository_id, externalRepositoryId: row.external_repository_id, pullNumber: row.pull_number }, snapshot: { ...(row.snapshot as QueueSnapshotInput), verifiedAt: row.verified_at! }, revision: row.snapshot_revision, desiredGeneration: row.desired_generation, appliedGeneration: row.applied_generation })) };
  });
}

/** Load a checkpoint only while its dispatch is owned by this lease. */
export async function claimQueuePullChunk(db: Kysely<Database>, key: QueueProjectionKey, lease: JobLease): Promise<{ token: QueueReadToken; checkpoint: unknown; snapshot: QueueSnapshotInput | null }> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, key, key)) throw new Error("queue authority unavailable");
    const row = await workQuery(trx, key).forUpdate().executeTakeFirst();
    if (!row || !await leaseValid(trx, key, lease, row.dispatch_job_id)) throw new Error("queue lease unavailable");
    return { token: { generation: row.desired_generation, snapshotRevision: row.snapshot_revision, lease }, checkpoint: row.checkpoint, snapshot: row.snapshot as QueueSnapshotInput | null };
  });
}
/** Atomically persist progress and yield to a fresh dispatch; stale reads have no effects. */
export async function continueQueuePullChunk(db: Kysely<Database>, key: QueueProjectionKey, token: QueueReadToken, checkpoint: unknown): Promise<boolean> {
  return db.transaction().execute(async trx => {
    if (!await queueAuthority(trx, key, key)) return false;
    const row = await workQuery(trx, key).forUpdate().executeTakeFirst();
    if (!row || row.desired_generation !== token.generation || row.snapshot_revision !== token.snapshotRevision || !await leaseValid(trx, key, token.lease, row.dispatch_job_id)) return false;
    await trx.updateTable("jobs").set({ status: "succeeded", locked_at: null, locked_by: null, updated_at: new Date() }).where("id", "=", token.lease.jobId).execute();
    const epoch = row.dispatch_epoch + 1, jobId = await dispatch(trx, key, epoch);
    await trx.updateTable("queue_pull_work").set({ checkpoint: JSON.stringify(checkpoint), dispatch_epoch: epoch, dispatch_job_id: jobId, updated_at: new Date() })
      .where("workspace_id", "=", key.workspaceId).where("provider_connection_id", "=", key.providerConnectionId).where("external_installation_id", "=", key.externalInstallationId).where("repository_id", "=", key.repositoryId).where("external_repository_id", "=", key.externalRepositoryId).where("pull_number", "=", key.pullNumber).execute();
    return true;
  });
}
