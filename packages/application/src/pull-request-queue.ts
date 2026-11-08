import { PullRequestQueueUnavailableError, queuePullRequestKey, type PullRequestQueueScope, type PullRequestQueueSnapshot, type QueueAssessment, type QueueItem, type QueuePullRequest, type QueueReviewState, type RepositoryRef, type WorkspaceId } from "@triagepilot/contracts";
import { classifyPullRequestAttention } from "./pull-request-attention.js";

export interface PullRequestQueueContext { signal: AbortSignal; assertAuthorized(): Promise<void> }
export interface PullRequestQueuePorts {
  now(): Date;
  createSnapshotId(): string;
  resolveScope(workspaceId: WorkspaceId): Promise<PullRequestQueueScope>;
  assertActive(scope: PullRequestQueueScope): Promise<void>;
  listRepositories(scope: PullRequestQueueScope, context: PullRequestQueueContext): Promise<RepositoryRef[]>;
  listOpenPullRequests(scope: PullRequestQueueScope, repository: RepositoryRef, context: PullRequestQueueContext): Promise<QueuePullRequest[]>;
  readAssessments(scope: PullRequestQueueScope, pulls: QueuePullRequest[]): Promise<Map<string, QueueAssessment>>;
  readReviewState(scope: PullRequestQueueScope, pull: QueuePullRequest, includeLifecycle: boolean, context: PullRequestQueueContext): Promise<QueueReviewState | { status: "closed" }>;
  linksFor(scope: PullRequestQueueScope, pull: QueuePullRequest, assessment: QueueAssessment | null): QueueItem["links"];
}
const ttl = 60_000;
const unknownReview = (): QueueReviewState => ({ status: "unavailable", reviews: [], observedAt: null, lifecycle: { status: "unavailable", openedSince: null } });
const safeError = (error: unknown) => error instanceof PullRequestQueueUnavailableError ? error : new PullRequestQueueUnavailableError("provider_unavailable");
const identity = (repository: RepositoryRef) => [repository.provider, repository.externalId, repository.owner, repository.name];
function keyFor(scope: PullRequestQueueScope, repositories: RepositoryRef[]) {
  return JSON.stringify([scope.workspaceId, scope.providerConnectionId, scope.externalConnectionId, scope.githubOrganization, repositories.map(identity).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), scope.knownRepositories.map(r => [r.recordId, ...identity(r.repository)]).sort()]);
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
class ScopeChanged extends Error {}

export function createPullRequestQueueService(ports: PullRequestQueuePorts) {
  const cache = new Map<string, PullRequestQueueSnapshot>();
  const flights = new Map<string, { controller: AbortController; promise: Promise<PullRequestQueueSnapshot> }>();
  const generations = new Map<WorkspaceId, { key: string; generation: number }>();
  const controllers = new Set<AbortController>();
  let disposed = false, generation = 0, running = 0;
  const waiting: Array<() => void> = [];
  async function provider<T>(scope: PullRequestQueueScope, signal: AbortSignal, operation: (context: PullRequestQueueContext) => Promise<T>): Promise<T> {
    // Reserve a slot before waking the next waiter, including concurrent scope checks.
    signal.throwIfAborted();
    if (running >= 4) {
      await new Promise<void>((resolve, reject) => {
        const grant = () => { signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => {
          const index = waiting.indexOf(grant);
          if (index !== -1) waiting.splice(index, 1);
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        waiting.push(grant);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else running++;
    try {
      signal.throwIfAborted();
      await abortable(ports.assertActive(scope), signal);
      return await abortable(operation({ signal, assertAuthorized: () => ports.assertActive(scope) }), signal);
    } finally { const next = waiting.shift(); if (next) next(); else running--; }
  }
  function budget() {
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new PullRequestQueueUnavailableError("timeout")), ttl);
    return { controller, deadline: ports.now().getTime() + ttl, close: () => { clearTimeout(timer); controllers.delete(controller); } };
  }
  async function scopeCheck(workspaceId: WorkspaceId, signal: AbortSignal) {
    try {
      if (disposed) throw new PullRequestQueueUnavailableError("authority");
      const scope = await abortable(ports.resolveScope(workspaceId), signal);
      const repositories = await provider(scope, signal, context => ports.listRepositories(scope, context));
      await abortable(ports.assertActive(scope), signal);
      return { scope, repositories, key: keyFor(scope, repositories) };
    } catch (error) { if (error instanceof ScopeChanged) throw error; throw safeError(error); }
  }
  async function acquire(scope: PullRequestQueueScope, repositories: RepositoryRef[], key: string, currentGeneration: number, task: ReturnType<typeof budget>): Promise<PullRequestQueueSnapshot> {
    // Reserve five seconds of the overall budget for final live authority checks.
    const content = new AbortController();
    const contentTimer = setTimeout(() => content.abort(new PullRequestQueueUnavailableError("timeout")), Math.max(0, task.deadline - ports.now().getTime() - 5000));
    const signal = AbortSignal.any([content.signal, task.controller.signal]);
    let observedAt: string | null = null, failure: PullRequestQueueUnavailableError | null = null, assessmentsComplete = true;
    const lists = new Map<string, QueuePullRequest[]>();
    const reviews = new Map<string, QueueReviewState | { status: "closed" }>();
    let assessments = new Map<string, QueueAssessment>();
    const recordFailure = (error: unknown) => { if (error instanceof ScopeChanged) throw error; const sanitized = safeError(error); if (sanitized.reason === "authority") throw sanitized; failure ??= sanitized; };
    try {
      await Promise.all(repositories.map(async repository => {
        try {
          const started = ports.now().toISOString();
          const pulls = await provider(scope, signal, context => ports.listOpenPullRequests(scope, repository, context));
          if (!observedAt || started < observedAt) observedAt = started;
          lists.set(repository.externalId, pulls);
        } catch (error) { recordFailure(error); }
      }));
      const pulls = [...lists.values()].flat();
      try { await abortable(ports.assertActive(scope), signal); assessments = await abortable(ports.readAssessments(scope, pulls), signal); }
      catch (error) { assessmentsComplete = false; recordFailure(error); }
      await Promise.all(pulls.map(async pull => {
        const prKey = queuePullRequestKey(pull.repository, pull.number);
        try { reviews.set(prKey, await provider(scope, signal, context => ports.readReviewState(scope, pull, assessments.has(prKey), context))); }
        catch (error) { recordFailure(error); }
      }));
      // Final live inventory is also required for partial/deadline and stale results.
      clearTimeout(contentTimer);
      let verified: Awaited<ReturnType<typeof scopeCheck>>;
      try { verified = await scopeCheck(scope.workspaceId, task.controller.signal); }
      catch (error) {
        if (error instanceof ScopeChanged) throw error;
        const failure = safeError(error);
        if (failure.reason === "authority") throw failure;
        // No content, including stale content, is safe without final inventory proof.
        const acquiredAt = ports.now();
        return { workspaceId: scope.workspaceId, snapshotId: ports.createSnapshotId(), status: "unavailable", observedAt: null, acquiredAt: acquiredAt.toISOString(), expiresAt: new Date(acquiredAt.getTime() + ttl).toISOString(), cacheTtlSeconds: 60, membershipComplete: false, classificationComplete: false, repositories: [], coveredRepositoryIds: [], unavailableRepositoryIds: [], items: [], totalOpen: null, stale: false, refreshError: failure.message };
      }
      if (verified.key !== key || generations.get(scope.workspaceId)?.generation !== currentGeneration) throw new ScopeChanged();
      const items: QueueItem[] = [];
      for (const pull of pulls) {
        const prKey = queuePullRequestKey(pull.repository, pull.number), reviewState = reviews.get(prKey) ?? unknownReview();
        if (reviewState.status === "closed") continue;
        const assessment = assessments.get(prKey) ?? null;
        if (reviewState.observedAt && (!observedAt || reviewState.observedAt < observedAt)) observedAt = reviewState.observedAt;
        items.push({ pullRequest: pull, reviewState, assessment, attention: classifyPullRequestAttention({ pullRequest: pull, reviewState, assessment }), links: ports.linksFor(scope, pull, assessment) });
      }
      const membershipComplete = lists.size === repositories.length;
      const classificationComplete = assessmentsComplete && items.every(i => i.reviewState.status === "complete" && (i.assessment === null || i.reviewState.lifecycle.status === "complete"));
      const acquiredAt = ports.now();
      const result: PullRequestQueueSnapshot = {
        workspaceId: scope.workspaceId, snapshotId: ports.createSnapshotId(), status: membershipComplete && classificationComplete ? "complete" : lists.size > 0 ? "partial" : "unavailable",
        observedAt, acquiredAt: acquiredAt.toISOString(), expiresAt: new Date(acquiredAt.getTime() + ttl).toISOString(), cacheTtlSeconds: 60,
        membershipComplete, classificationComplete, repositories: repositories.map(repository => ({ repository, recordId: scope.knownRepositories.find(r => r.repository.provider === repository.provider && r.repository.externalId === repository.externalId)?.recordId ?? null })),
        coveredRepositoryIds: [...lists.keys()], unavailableRepositoryIds: repositories.filter(r => !lists.has(r.externalId)).map(r => r.externalId), items, totalOpen: membershipComplete ? items.length : null, stale: false, refreshError: failure ? (failure as PullRequestQueueUnavailableError).message : null,
      };
      const previous = cache.get(key);
      if (result.status !== "complete" && previous) return { ...previous, stale: true, refreshError: result.refreshError ?? new PullRequestQueueUnavailableError("provider_unavailable").message };
      if (result.status === "complete") {
        cache.delete(key); cache.set(key, result);
        while (cache.size > 4) cache.delete(cache.keys().next().value!);
      }
      return result;
    } finally { clearTimeout(contentTimer); task.controller.abort(new PullRequestQueueUnavailableError("timeout")); task.close(); }
  }
  async function readShared(workspaceId: WorkspaceId, forceRefresh: boolean): Promise<PullRequestQueueSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const task = budget();
      let checked: Awaited<ReturnType<typeof scopeCheck>>;
      try { checked = await scopeCheck(workspaceId, task.controller.signal); }
      catch (error) { task.close(); throw error; }
      const { scope, repositories, key } = checked;
      let current = generations.get(workspaceId);
      if (!current || current.key !== key) {
        if (current) { cache.delete(current.key); flights.get(current.key)?.controller.abort(new ScopeChanged()); }
        current = { key, generation: ++generation }; generations.set(workspaceId, current);
      }
      const existing = flights.get(key);
      if (existing) { task.close(); try { return await existing.promise; } catch (error) { if (error instanceof ScopeChanged) continue; throw safeError(error); } }
      const cached = cache.get(key);
      if (!forceRefresh && cached && ports.now().getTime() < Date.parse(cached.expiresAt)) { task.close(); cache.delete(key); cache.set(key, cached); return cached; }
      const flight = { controller: task.controller, promise: acquire(scope, repositories, key, current.generation, task) };
      flights.set(key, flight);
      try { return await flight.promise; }
      catch (error) { if (error instanceof ScopeChanged) continue; throw safeError(error); }
      finally { if (flights.get(key) === flight) flights.delete(key); }
    }
    throw new PullRequestQueueUnavailableError("authority");
  }
  return {
    read(input: { workspaceId: WorkspaceId; forceRefresh?: boolean; signal?: AbortSignal }) {
      if (input.signal?.aborted) return Promise.reject(input.signal.reason);
      const result = readShared(input.workspaceId, input.forceRefresh === true);
      return input.signal ? abortable(result, input.signal) : result;
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(new PullRequestQueueUnavailableError("authority")); cache.clear(); generations.clear(); },
  };
}
