import { PullRequestQueueUnavailableError, type QueuePullRequest, type QueueReview, type QueueReviewState, type RepositoryRef } from "@triagepilot/contracts";
import type { PullRequestQueueContext } from "./pull-request-queue.js";

/** The persistence adapter must enforce immutable scope, revision and lease on every transition. */
export interface SyncPullKey { workspaceId: string; providerConnectionId: string; externalInstallationId: string; repositoryId: string; externalRepositoryId: string; pullNumber: number }
export interface SyncToken<L> { generation: number; snapshotRevision: number; lease: L }
export interface SyncSnapshot { pull: QueuePullRequest; reviewState: QueueReviewState; isOpen: boolean; verifiedAt: Date }
type PullCheckpoint = { generation: number; revision: number; stage: "reviews" | "lifecycle" | "confirm"; pull: QueuePullRequest; reviews: QueueReview[]; page: number; openedSince: string; lifecycleAvailable: boolean };
type ProviderContext = PullRequestQueueContext & { repository: RepositoryRef; pullNumber: number };
export interface PullRequestSyncPorts<L, Scope, RunToken> {
  now(): Date;
  resolveRepository(key: SyncPullKey): Promise<RepositoryRef>;
  assertAuthorized(scope: SyncPullKey | Scope, repository?: RepositoryRef): Promise<void>;
  claimPull(key: SyncPullKey, lease: L): Promise<{ token: SyncToken<L>; checkpoint: unknown; snapshot: SyncSnapshot | null }>;
  continuePull(key: SyncPullKey, token: SyncToken<L>, checkpoint: unknown): Promise<boolean>;
  commitPull(key: SyncPullKey, token: SyncToken<L>, snapshot: SyncSnapshot): Promise<boolean>;
  readPull(context: ProviderContext): Promise<{ status: "missing" } | { status: "open" | "closed"; pull: QueuePullRequest }>;
  listReviews(context: ProviderContext & { page: number }): Promise<{ reviews: QueueReview[]; nextPage: number | null }>;
  listLifecycle(context: ProviderContext & { page: number }): Promise<{ reopenedAt: string[]; nextPage: number | null }>;
  claimRun(scope: Scope, runId: string, lease: L): Promise<{ token: RunToken; checkpoint: unknown }>;
  /** Atomically validate run revision/lease and apply the page's membership and checkpoint. */
  commitRunPage(scope: Scope, runId: string, token: RunToken, checkpoint: unknown, effect: ReconcileEffect): Promise<boolean>;
  listRepositories(scope: Scope, context: PullRequestQueueContext & { page: number }): Promise<{ repositories: RepositoryRef[]; totalCount: number; nextPage: number | null }>;
  listPulls(scope: Scope, context: PullRequestQueueContext & { repository: RepositoryRef; page: number }): Promise<{ pulls: QueuePullRequest[]; nextPage: number | null }>;
}
export type ReconcileEffect = { type: "inventory"; repositories: RepositoryRef[] } | { type: "pulls"; repository: RepositoryRef; pulls: QueuePullRequest[]; complete: boolean } | { type: "missing"; repository: RepositoryRef; nextCheckpoint: unknown } | { type: "finish" };
type RunCheckpoint = { stage: "inventory"; page: number; totalCount: number | null; repositories: RepositoryRef[] } | { stage: "pulls"; page: number; repositories: RepositoryRef[]; index: number } | { stage: "missing"; repositories: RepositoryRef[]; index: number } | { stage: "done" };
const unavailable = (): QueueReviewState => ({ status: "unavailable", reviews: [], observedAt: null, lifecycle: { status: "unavailable", openedSince: null } });
const fingerprint = (p: QueuePullRequest) => JSON.stringify([p.number, p.headRevision, p.baseRevision, p.isDraft, p.updatedAt, p.requestedUsers.map(x => x.id).sort(), p.requestedTeams.map(x => x.id).sort()]);
function validCheckpoint(value: unknown, token: SyncToken<unknown>): value is PullCheckpoint {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<PullCheckpoint>;
  return c.generation === token.generation && c.revision === token.snapshotRevision && ["reviews", "lifecycle", "confirm"].includes(c.stage ?? "") && !!c.pull && Array.isArray(c.reviews) && Number.isSafeInteger(c.page) && typeof c.openedSince === "string" && typeof c.lifecycleAvailable === "boolean";
}
export function createPullRequestSyncService<L, Scope, RunToken>(ports: PullRequestSyncPorts<L, Scope, RunToken>) {
  async function provider<T>(scope: SyncPullKey | Scope, repository: RepositoryRef | undefined, fn: (context: PullRequestQueueContext) => Promise<T>): Promise<T> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new PullRequestQueueUnavailableError("timeout")), 10_000);
    const context = { signal: controller.signal, assertAuthorized: async () => { controller.signal.throwIfAborted(); await ports.assertAuthorized(scope, repository); controller.signal.throwIfAborted(); } };
    try {
      await context.assertAuthorized();
      return await Promise.race([fn(context), new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }))]);
    } finally { clearTimeout(timer); }
  }
  async function refreshPullChunk(key: SyncPullKey, lease: L): Promise<{ done: boolean }> {
    const { token, checkpoint } = await ports.claimPull(key, lease);
    const repository = await ports.resolveRepository(key);
    if (repository.externalId !== key.externalRepositoryId) throw new PullRequestQueueUnavailableError("authority");
    const base = (ctx: PullRequestQueueContext): ProviderContext => ({ ...ctx, repository, pullNumber: key.pullNumber });
    const commit = async (pull: QueuePullRequest, isOpen: boolean, reviewState: QueueReviewState) => {
      await ports.commitPull(key, token, { pull, isOpen, reviewState, verifiedAt: ports.now() });
      // The worker acknowledges even a rejected commit; pending generations are
      // atomically rescheduled by completeQueueWork.
      return { done: true };
    };
    let state: PullCheckpoint;
    if (!validCheckpoint(checkpoint, token)) {
      const detail = await provider(key, repository, ctx => ports.readPull(base(ctx)));
      // GitHub can hide inaccessible repositories behind 404; retain existing rows.
      if (detail.status === "missing") throw new PullRequestQueueUnavailableError("authority");
      if (detail.status === "closed" || detail.pull.isDraft || detail.pull.author.type === "bot") return commit(detail.pull, detail.status === "open", unavailable());
      state = { generation: token.generation, revision: token.snapshotRevision, stage: "reviews", pull: detail.pull, reviews: [], page: 1, openedSince: detail.pull.createdAt, lifecycleAvailable: true };
    } else {
      state = checkpoint;
      if (state.stage === "reviews") {
        const page = await provider(key, repository, ctx => ports.listReviews({ ...base(ctx), page: state.page }));
        const ids = new Set(state.reviews.map(review => review.id));
        for (const review of page.reviews) { if (ids.has(review.id)) throw new PullRequestQueueUnavailableError("invalid_response"); ids.add(review.id); }
        state = { ...state, reviews: [...state.reviews, ...page.reviews], stage: page.nextPage === null ? "lifecycle" : "reviews", page: page.nextPage ?? 1 };
      } else if (state.stage === "lifecycle") {
        try {
          const page = await provider(key, repository, ctx => ports.listLifecycle({ ...base(ctx), page: state.page }));
          const openedSince = page.reopenedAt.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest, state.openedSince);
          state = { ...state, openedSince, stage: page.nextPage === null ? "confirm" : "lifecycle", page: page.nextPage ?? 1 };
        } catch (error) {
          if (!(error instanceof PullRequestQueueUnavailableError) || error.reason === "authority" || error.reason === "rate_limited") throw error;
          state = { ...state, stage: "confirm", page: 1, lifecycleAvailable: false };
        }
      } else {
        const detail = await provider(key, repository, ctx => ports.readPull(base(ctx)));
        if (detail.status === "missing") throw new PullRequestQueueUnavailableError("authority");
        if (detail.status === "closed" || detail.pull.isDraft || detail.pull.author.type === "bot") return commit(detail.pull, detail.status === "open", unavailable());
        if (fingerprint(detail.pull) !== fingerprint(state.pull)) {
          state = { generation: token.generation, revision: token.snapshotRevision, stage: "reviews", pull: detail.pull, reviews: [], page: 1, openedSince: detail.pull.createdAt, lifecycleAvailable: true };
        } else {
          return commit(detail.pull, true, { status: "complete", reviews: state.reviews, observedAt: ports.now().toISOString(), lifecycle: state.lifecycleAvailable ? { status: "complete", openedSince: state.openedSince } : { status: "unavailable", openedSince: null } });
        }
      }
    }
    const continued = await ports.continuePull(key, token, state);
    return { done: !continued };
  }
  async function reconcileConnectionChunk(scope: Scope, runId: string, lease: L): Promise<{ done: boolean }> {
    const { token, checkpoint } = await ports.claimRun(scope, runId, lease);
    const state = checkpoint && typeof checkpoint === "object" && "stage" in checkpoint ? checkpoint as RunCheckpoint : { stage: "inventory" as const, page: 1, totalCount: null, repositories: [] };
    if (state.stage === "done") return { done: true };
    if (state.stage === "inventory") {
      const page = await provider(scope, undefined, ctx => ports.listRepositories(scope, { ...ctx, page: state.page }));
      if (state.totalCount !== null && state.totalCount !== page.totalCount) throw new PullRequestQueueUnavailableError("invalid_response");
      const ids = new Set(state.repositories.map(repo => repo.externalId));
      for (const repo of page.repositories) { if (ids.has(repo.externalId)) throw new PullRequestQueueUnavailableError("invalid_response"); ids.add(repo.externalId); }
      const repositories = [...state.repositories, ...page.repositories];
      const next: RunCheckpoint = page.nextPage === null ? { stage: "pulls", page: 1, repositories, index: 0 } : { stage: "inventory", page: page.nextPage, totalCount: page.totalCount, repositories };
      await ports.commitRunPage(scope, runId, token, next, { type: "inventory", repositories: page.repositories });
      return { done: false };
    }
    const repository = state.repositories[state.index];
    if (!repository) { const accepted = await ports.commitRunPage(scope, runId, token, { stage: "done" }, { type: "finish" }); return { done: accepted }; }
    if (state.stage === "missing") {
      const next: RunCheckpoint = { stage: "pulls", repositories: state.repositories, index: state.index + 1, page: 1 };
      await ports.commitRunPage(scope, runId, token, state, { type: "missing", repository, nextCheckpoint: next });
      return { done: false };
    }
    const page = await provider(scope, repository, ctx => ports.listPulls(scope, { ...ctx, repository, page: state.page }));
    const next: RunCheckpoint = page.nextPage === null ? { stage: "missing", repositories: state.repositories, index: state.index } : { ...state, page: page.nextPage };
    await ports.commitRunPage(scope, runId, token, next, { type: "pulls", repository, pulls: page.pulls, complete: page.nextPage === null });
    return { done: false };
  }
  return { refreshPullChunk, reconcileConnectionChunk };
}
