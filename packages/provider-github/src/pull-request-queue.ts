import { PullRequestQueueUnavailableError, type QueueActor, type QueuePullRequest, type QueueReview, type QueueReviewState, type RepositoryRef } from "@triagepilot/contracts";

type Requester = { request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown; headers?: Record<string, unknown> }> };
type Context = { signal: AbortSignal; assertAuthorized(): Promise<void>; githubOrganization: string };
function invalid(): never { throw new PullRequestQueueUnavailableError("invalid_response"); }
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown): string => typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : invalid();
const string = (v: unknown): string => typeof v === "string" && v.trim() ? v : invalid();
const timestamp = (v: unknown): string => { const s = string(v); if (!Number.isFinite(Date.parse(s))) invalid(); return s; };
function actor(v: unknown): QueueActor {
  if (!record(v)) return invalid();
  const type = v.type === "User" ? "human" : v.type === "Bot" ? "bot" : v.type === "Organization" ? "other" : invalid();
  return { id: id(v.id), login: string(v.login).toLowerCase(), type };
}
function targets(users: unknown, teams: unknown, organization: string) {
  if (!Array.isArray(users) || !Array.isArray(teams)) return invalid();
  const requestedUsers = users.map(actor);
  const requestedTeams = teams.map((team) => {
    if (!record(team)) return invalid();
    return { id: id(team.id), name: `${organization.toLowerCase()}/${string(team.slug).toLowerCase()}` };
  });
  if (new Set(requestedUsers.map((x) => x.id)).size !== requestedUsers.length || new Set(requestedTeams.map((x) => x.id)).size !== requestedTeams.length) invalid();
  return { requestedUsers, requestedTeams };
}
function classify(e: unknown): PullRequestQueueUnavailableError {
  if (!record(e)) return new PullRequestQueueUnavailableError("provider_unavailable");
  const headers = record(e.response) && record(e.response.headers) ? e.response.headers : {};
  const header = (name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (e.status === 429 || ((e.status === 403 || e.status === 422) && (String(header("x-ratelimit-remaining")) === "0" || header("retry-after") !== undefined || /rate limit|secondary limit|abuse|spam/.test(message)))) return new PullRequestQueueUnavailableError("rate_limited");
  if (e.status === 401 || e.status === 403 || e.status === 404) return new PullRequestQueueUnavailableError("authority");
  return new PullRequestQueueUnavailableError("provider_unavailable");
}
export function createGitHubPullRequestQueueReader(requester: Requester) {
  async function request(context: Context, route: string, parameters: Record<string, unknown>) {
    context.signal.throwIfAborted(); await context.assertAuthorized(); context.signal.throwIfAborted();
    try { const result = await requester.request(route, { ...parameters, request: { signal: context.signal } }); context.signal.throwIfAborted(); return result.data; }
    catch (e) { context.signal.throwIfAborted(); throw classify(e); }
  }
  async function pages(context: Context, route: string, parameters: Record<string, unknown>, unwrap: (data: unknown) => unknown, project: (item: unknown) => unknown = (item) => item): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; ; page++) {
      const data = unwrap(await request(context, route, { ...parameters, per_page: 100, page }));
      if (!Array.isArray(data) || data.length > 100) invalid();
      result.push(...data.map(project)); if (data.length < 100) return result;
    }
  }
  async function readTargets(context: Context, repository: RepositoryRef, pr: Record<string, unknown>, number: number) {
    if (pr.requested_reviewers === undefined || pr.requested_teams === undefined) {
      const data = await request(context, "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", { owner: repository.owner, repo: repository.name, pull_number: number });
      if (!record(data)) return invalid();
      return targets(data.users, data.teams, context.githubOrganization);
    }
    return targets(pr.requested_reviewers, pr.requested_teams, context.githubOrganization);
  }
  function verifyRepo(value: unknown, repository: RepositoryRef) {
    if (!record(value) || id(value.id) !== repository.externalId || string(value.name).toLowerCase() !== repository.name.toLowerCase() || !record(value.owner) || string(value.owner.login).toLowerCase() !== repository.owner.toLowerCase()) invalid();
  }
  function basic(pr: Record<string, unknown>, repository: RepositoryRef) {
    id(pr.id); const number = Number(id(pr.number));
    if (!record(pr.base) || !record(pr.head) || typeof pr.draft !== "boolean") return invalid();
    verifyRepo(pr.base.repo, repository);
    return { number, baseRevision: string(pr.base.sha), headRevision: string(pr.head.sha), isDraft: pr.draft };
  }
  return {
    async listRepositories(context: Context): Promise<RepositoryRef[]> {
      const entries = await pages(context, "GET /installation/repositories", {}, (data) => record(data) && Number.isSafeInteger(data.total_count) && Number(data.total_count) >= 0 ? data.repositories : invalid());
      const result: RepositoryRef[] = []; const ids = new Set<string>(); const names = new Set<string>();
      for (const entry of entries) {
        if (!record(entry) || !record(entry.owner)) invalid();
        const externalId = id(entry.id), owner = string(entry.owner.login), name = string(entry.name);
        if (ids.has(externalId) || names.has(`${owner.toLowerCase()}/${name.toLowerCase()}`)) invalid();
        ids.add(externalId); names.add(`${owner.toLowerCase()}/${name.toLowerCase()}`);
        if (owner.toLowerCase() === context.githubOrganization.toLowerCase()) result.push({ provider: "github", externalId, owner, name });
      }
      return result;
    },
    async listOpenPullRequests(context: Context & { repository: RepositoryRef }): Promise<QueuePullRequest[]> {
      const { repository } = context;
      if (repository.provider !== "github" || repository.owner.toLowerCase() !== context.githubOrganization.toLowerCase()) invalid();
      const entries = await pages(context, "GET /repos/{owner}/{repo}/pulls", { owner: repository.owner, repo: repository.name, state: "open" }, (data) => data);
      const result: QueuePullRequest[] = []; const ids = new Set<string>(); const numbers = new Set<number>();
      for (const entry of entries) {
        if (!record(entry) || entry.state !== "open") invalid();
        const metadata = basic(entry, repository); const prId = id(entry.id);
        if (ids.has(prId) || numbers.has(metadata.number)) invalid(); ids.add(prId); numbers.add(metadata.number);
        result.push({ repository, changeRequestId: String(metadata.number), ...metadata, title: string(entry.title), author: actor(entry.user), createdAt: timestamp(entry.created_at), updatedAt: timestamp(entry.updated_at), ...await readTargets(context, repository, entry, metadata.number) });
      }
      return result;
    },
    async readReviewState(context: Context & { pullRequest: QueuePullRequest; includeLifecycle: boolean }): Promise<QueueReviewState | { status: "closed" }> {
      const pull = context.pullRequest, repository = pull.repository;
      if (repository.provider !== "github" || repository.owner.toLowerCase() !== context.githubOrganization.toLowerCase() || pull.changeRequestId !== String(pull.number)) invalid();
      const params = { owner: repository.owner, repo: repository.name, pull_number: pull.number };
      const entries = await pages(context, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", params, (data) => data);
      const reviews: QueueReview[] = []; const ids = new Set<string>();
      for (const entry of entries) {
        if (!record(entry)) invalid(); const reviewId = id(entry.id); if (ids.has(reviewId)) invalid(); ids.add(reviewId);
        if (entry.submitted_at === null) continue;
        reviews.push({ id: reviewId, actor: actor(entry.user), state: string(entry.state), commitId: entry.commit_id === null ? null : string(entry.commit_id), submittedAt: timestamp(entry.submitted_at) });
      }
      reviews.sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
      let lifecycle: QueueReviewState["lifecycle"] = { status: "unavailable", openedSince: null };
      if (context.includeLifecycle) {
        try {
          const events = await pages(context, "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline", { owner: repository.owner, repo: repository.name, issue_number: pull.number }, (data) => data, (event) => { if (!record(event)) return invalid(); return event.event === "reopened" ? { event: "reopened", created_at: event.created_at } : {}; });
          let openedSince = pull.createdAt;
          for (const event of events) { if (!record(event)) invalid(); if (event.event === "reopened") { const at = timestamp(event.created_at); if (Date.parse(at) > Date.parse(openedSince)) openedSince = at; } }
          lifecycle = { status: "complete", openedSince };
        } catch (error) { context.signal.throwIfAborted(); if (!(error instanceof PullRequestQueueUnavailableError) || error.reason === "authority") throw error; }
      }
      const detail = await request(context, "GET /repos/{owner}/{repo}/pulls/{pull_number}", params);
      if (!record(detail)) invalid();
      const current = basic(detail, repository);
      if (current.number !== pull.number) invalid();
      if (detail.state === "closed") return { status: "closed" };
      if (detail.state !== "open") invalid();
      const currentTargets = await readTargets(context, repository, detail, pull.number);
      const targetIds = (values: Array<{ id: string }>) => values.map((x) => x.id).sort().join(",");
      const changed = current.headRevision !== pull.headRevision || current.baseRevision !== pull.baseRevision || current.isDraft !== pull.isDraft || targetIds(currentTargets.requestedUsers) !== targetIds(pull.requestedUsers) || targetIds(currentTargets.requestedTeams) !== targetIds(pull.requestedTeams);
      return { status: changed ? "changed" : "complete", reviews, observedAt: new Date().toISOString(), lifecycle };
    },
  };
}
