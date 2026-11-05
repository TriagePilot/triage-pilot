import type { AnalyticsRepositoryScope, CurrentBacklogSnapshot, ExternalActorId, OpenReviewRequest, ProviderConnectionId, RepositoryRef, ReviewerBacklogScopeRequest, ReviewerLoadObservation, ReviewerLoadRequest, TrackedPullRequest, WorkspaceId } from "@triagepilot/contracts";

type Failure = NonNullable<ReviewerLoadObservation["reason"]>;
export interface ReviewerBacklogPorts {
  now(): Date;
  loadScope(input: ReviewerBacklogScopeRequest): Promise<AnalyticsRepositoryScope>;
  assertActive(scope: AnalyticsRepositoryScope): Promise<void>;
  readTracked(scope: AnalyticsRepositoryScope, window: { since: Date; end: Date }): Promise<{ pullRequests: TrackedPullRequest[]; knownActors: ExternalActorId[] }>;
  listOpenReviewRequests(input: { scope: AnalyticsRepositoryScope; repository: RepositoryRef; signal: AbortSignal; assertAuthorized: () => Promise<void> }): Promise<OpenReviewRequest[]>;
  classifyError(error: unknown): "authority" | Failure;
}
export interface ReviewerBacklogService {
  readCurrent(input: ReviewerBacklogScopeRequest & { forceRefresh?: boolean }): Promise<CurrentBacklogSnapshot>;
  readLoad(input: ReviewerLoadRequest): Promise<ReviewerLoadObservation>;
  invalidate(input: { workspaceId: WorkspaceId; providerConnectionId: ProviderConnectionId; repositoryRecordId?: string }): void;
}
class DeadlineError extends Error {}
class AuthorityError extends Error {}
const DAY = 86_400_000;
const repositoryIdentity = (repository: RepositoryRef) => JSON.stringify(repository);
export function createReviewerBacklogService(ports: ReviewerBacklogPorts): ReviewerBacklogService {
  const cache = new Map<string, { at: number; requests: OpenReviewRequest[] }>();
  const generations = new Map<string, number>();
  const connectionKey = (input: {workspaceId: WorkspaceId; providerConnectionId: ProviderConnectionId}) => JSON.stringify([input.workspaceId,input.providerConnectionId]);
  const classify = (error: unknown) => error instanceof AuthorityError ? "authority" : error instanceof DeadlineError ? "timeout" : ports.classifyError(error);
  async function acquire(input: ReviewerBacklogScopeRequest & {forceRefresh?: boolean}, exclude?: TrackedPullRequest) {
    const end = ports.now();
    const since = new Date(end.getTime() - 90 * DAY);
    const controller = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); reject(new DeadlineError("Backlog acquisition timed out")); }, 10_000); });
    const bounded = <T>(work: Promise<T>) => Promise.race([work, deadline]);
    const group = connectionKey(input);
    const generation = generations.get(group) ?? 0;
    let reason: Failure | null = null;
    try {
      const scope = await bounded(ports.loadScope(input));
      const authorize = async () => {
        if (expired) throw new DeadlineError();
        await bounded(ports.assertActive(scope));
        if (expired) throw new DeadlineError();
      };
      if (scope.workspaceId !== input.workspaceId || scope.providerConnectionId !== input.providerConnectionId || input.repositoryIds.some(id => !scope.repositories.some(r=>r.recordId===id))) throw new AuthorityError("Backlog scope mismatch");
      await authorize();
      // A removed repository or superseded connection must not leave reusable data.
      for (const key of cache.keys()) {
        const parts = JSON.parse(key) as string[];
        if (parts[0] === group && (parts[1] !== scope.externalConnectionId || !scope.repositories.some(repository => repository.recordId === parts[2] && repositoryIdentity(repository.repository) === parts[3]))) cache.delete(key);
      }
      if (exclude && (exclude.providerConnectionId !== scope.providerConnectionId || !scope.repositories.some(r=>r.recordId===exclude.repositoryRecordId && repositoryIdentity(r.repository)===repositoryIdentity(exclude.repository)) || !exclude.changeRequestId || !Number.isInteger(exclude.changeRequestNumber) || exclude.changeRequestNumber < 1)) throw new AuthorityError("Backlog exclusion mismatch");
      const tracked = await bounded(ports.readTracked(scope, { since, end }));
      const repositories = scope.repositories.filter(r=>input.repositoryIds.length===0 || input.repositoryIds.includes(r.recordId));
      const pairs: CurrentBacklogSnapshot["pairs"] = [];
      const coveredRepositoryIds: string[] = [], unavailableRepositoryIds: string[] = [];
      const observed: number[] = [];
      let cursor = 0;
      async function worker() {
        while (cursor < repositories.length) {
          const repository = repositories[cursor++]!;
          try {
            await authorize();
            const key = JSON.stringify([group,scope.externalConnectionId,repository.recordId,repositoryIdentity(repository.repository)]);
            let snapshot = cache.get(key);
            if (input.forceRefresh || !snapshot || ports.now().getTime()-snapshot.at >= 60_000) {
              const requests = await bounded(ports.listOpenReviewRequests({scope, repository:repository.repository,signal:controller.signal,assertAuthorized:authorize}));
              await authorize();
              snapshot = {at:ports.now().getTime(),requests};
              if (!controller.signal.aborted && generation === (generations.get(group) ?? 0)) cache.set(key,snapshot);
            }
            const seen = new Set<string>();
            for (const pending of snapshot.requests) {
              const pr = tracked.pullRequests.find(pr=>pr.repositoryRecordId===repository.recordId && pr.providerConnectionId===scope.providerConnectionId && repositoryIdentity(pr.repository)===repositoryIdentity(repository.repository) && pr.changeRequestId===pending.changeRequestId && pr.changeRequestNumber===pending.changeRequestNumber);
              if (!pr) continue;
              for (const actor of pending.requestedActors) {
                const pairKey=JSON.stringify([pr.changeRequestId,pr.changeRequestNumber,actor]);
                if (!seen.has(pairKey)) { seen.add(pairKey);pairs.push({changeRequest:pr,actor}); }
              }
            }
            coveredRepositoryIds.push(repository.recordId);observed.push(snapshot.at);
          } catch(error) {
            const failure=classify(error);
            if(failure==="authority") { controller.abort();throw error; }
            reason ??= failure;
            unavailableRepositoryIds.push(repository.recordId);
          }
        }
      }
      await Promise.all(Array.from({length:Math.min(4,repositories.length)},()=>worker()));
      if (!expired) await authorize();
      const snapshot: CurrentBacklogSnapshot = {status:unavailableRepositoryIds.length ? coveredRepositoryIds.length ? "partial":"unavailable":"complete",observedAt:observed.length ? new Date(Math.min(...observed)).toISOString() : repositories.length===0 ? end.toISOString():null,trackedSince:since.toISOString(),scope,pairs,knownActors:[...new Set([...tracked.knownActors,...pairs.map(p=>p.actor)])],coveredRepositoryIds,unavailableRepositoryIds};
      return {snapshot,reason};
    } finally { clearTimeout(timer!); }
  }
  return {
    async readCurrent(input) { return (await acquire(input)).snapshot; },
    async readLoad(input) {
      const trackedSince=new Date(ports.now().getTime()-90*DAY).toISOString();
      try {
        const {snapshot,reason}=await acquire({workspaceId:input.workspaceId,providerConnectionId:input.providerConnectionId,repositoryIds:[]},input.exclude);
        if(snapshot.status!=="complete") return {status:"fallback",source:"tracked_github_pending",observedAt:null,trackedSince:snapshot.trackedSince,loads:{},reason:reason ?? "provider_unavailable"};
        const loads: Record<string,number> = Object.fromEntries(input.actors.map(actor=>[actor,0]));
        for(const pair of snapshot.pairs) {
          const pr=pair.changeRequest;
          if(pr.repositoryRecordId===input.exclude.repositoryRecordId && pr.changeRequestId===input.exclude.changeRequestId && pr.changeRequestNumber===input.exclude.changeRequestNumber) continue;
          if(Object.hasOwn(loads,pair.actor)) loads[pair.actor]!++;
        }
        return {status:"complete",source:"tracked_github_pending",observedAt:snapshot.observedAt,trackedSince:snapshot.trackedSince,loads,reason:null};
      } catch(error) {
        const reason=classify(error);if(reason==="authority") throw error;
        return {status:"fallback",source:"tracked_github_pending",observedAt:null,trackedSince,loads:{},reason};
      }
    },
    invalidate(input) {
      const group=connectionKey(input);generations.set(group,(generations.get(group)??0)+1);
      for(const key of cache.keys()) { const parts=JSON.parse(key) as string[];if(parts[0]===group && (!input.repositoryRecordId || parts[2]===input.repositoryRecordId)) cache.delete(key); }
    },
  };
}
