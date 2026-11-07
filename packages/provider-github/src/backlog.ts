import type { OpenReviewRequest, RepositoryRef } from "@triagepilot/contracts";

// Retain the adapter's structural Octokit boundary.
type Requester = {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
};
export interface GitHubBacklogInput {
  repository: RepositoryRef;
  signal: AbortSignal;
  assertAuthorized: () => Promise<void>;
}
export type GitHubBacklogFailureReason =
  | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "provider_unavailable" | "invalid_response";

export class GitHubBacklogError extends Error {
  constructor(readonly reason: GitHubBacklogFailureReason) {
    super(`GitHub review backlog unavailable: ${reason}`);
    this.name = "GitHubBacklogError";
  }
}

export async function listOpenReviewRequests(
  requester: Requester,
  input: GitHubBacklogInput,
): Promise<OpenReviewRequest[]> {
  const { repository } = input;
  if (repository.provider !== "github") invalid();
  const result: OpenReviewRequest[] = [];
  const numbers = new Set<number>();
  const ids = new Set<number>();
  const request = async (route: string, parameters: Record<string, unknown>): Promise<unknown> => {
    input.signal.throwIfAborted();
    await input.assertAuthorized();
    input.signal.throwIfAborted();
    try {
      const response = await requester.request(route, {
        owner: repository.owner, repo: repository.name, ...parameters,
        request: { signal: input.signal },
      });
      input.signal.throwIfAborted();
      return response.data;
    } catch (error) {
      input.signal.throwIfAborted();
      throw classify(error);
    }
  };
  for (let page = 1; ; page += 1) {
    const data = await request("GET /repos/{owner}/{repo}/pulls", {
      state: "open", sort: "created", direction: "asc", per_page: 100, page,
    });
    if (!Array.isArray(data) || data.length > 100) invalid();
    for (const pr of data) {
      if (!record(pr) || !positiveInteger(pr.id) || !positiveInteger(pr.number)
        || pr.state !== "open" || !record(pr.base) || !record(pr.base.repo)) invalid();
      const repo = pr.base.repo;
      if (!positiveInteger(repo.id) || String(repo.id) !== repository.externalId
        || typeof repo.name !== "string" || repo.name.toLowerCase() !== repository.name.toLowerCase()
        || !record(repo.owner) || typeof repo.owner.login !== "string"
        || repo.owner.login.toLowerCase() !== repository.owner.toLowerCase()
        || numbers.has(pr.number) || ids.has(pr.id)) invalid();
      numbers.add(pr.number);
      ids.add(pr.id);
      let requestedActors: string[];
      if (pr.requested_reviewers === undefined) {
        // This endpoint documents a complete { users, teams } response, with no
        // page/per_page parameters. Both collections are required, even if empty.
        const fallback = await request("GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
          pull_number: pr.number,
        });
        if (!record(fallback)) invalid();
        requestedActors = readActors(fallback.users, fallback.teams);
      } else {
        requestedActors = readActors(pr.requested_reviewers, pr.requested_teams);
      }
      // Existing normalized event/DB identity is the repository-scoped PR number.
      result.push({ changeRequestId: String(pr.number), changeRequestNumber: pr.number, requestedActors });
    }
    if (data.length < 100) return result;
  }
}

export async function listOpenReviewRequestsWithInstallationProbe(requester: Requester, input: GitHubBacklogInput): Promise<OpenReviewRequest[]> {
  try {
    return await listOpenReviewRequests(requester, input);
  } catch (error) {
    if (!(error instanceof GitHubBacklogError) || (error.reason !== "forbidden" && error.reason !== "not_found")) throw error;
    await input.assertAuthorized();
    input.signal.throwIfAborted();
    let data: unknown;
    try {
      ({ data } = await requester.request("GET /installation/repositories", { per_page: 1, request: { signal: input.signal } }));
    } catch (probeError) {
      input.signal.throwIfAborted();
      const failure = classify(probeError);
      if (["unauthorized", "forbidden", "not_found"].includes(failure.reason)) throw error;
      throw failure;
    }
    input.signal.throwIfAborted();
    await input.assertAuthorized();
    if (!record(data) || !Number.isSafeInteger(data.total_count) || Number(data.total_count) < 0 || !Array.isArray(data.repositories)) throw error;
    throw new GitHubBacklogError("provider_unavailable");
  }
}

function readActors(users: unknown, teams: unknown): string[] {
  if (!Array.isArray(users) || !Array.isArray(teams)) invalid();
  for (const team of teams) {
    if (!record(team) || !positiveInteger(team.id) || typeof team.slug !== "string" || !team.slug.trim()) invalid();
  }
  const actors = new Set<string>();
  for (const user of users) {
    if (!record(user) || typeof user.login !== "string" || !user.login.trim()
      || (user.type !== "User" && user.type !== "Bot" && user.type !== "Organization")) invalid();
    if (user.type !== "User") continue;
    const login = user.login.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(login)) invalid();
    actors.add(`@${login}`);
  }
  return [...actors];
}

function classify(error: unknown): GitHubBacklogError {
  if (!record(error)) return new GitHubBacklogError("provider_unavailable");
  const headers = record(error.response) && record(error.response.headers) ? error.response.headers : {};
  const header = (name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  if (error.status === 429 || ((error.status === 403 || error.status === 422)
    && (String(header("x-ratelimit-remaining")) === "0" || header("retry-after") !== undefined
      || /rate limit|secondary limit|abuse|spam/.test(message)))) return new GitHubBacklogError("rate_limited");
  if (error.status === 401) return new GitHubBacklogError("unauthorized");
  if (error.status === 403) return new GitHubBacklogError("forbidden");
  if (error.status === 404) return new GitHubBacklogError("not_found");
  return new GitHubBacklogError("provider_unavailable");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function invalid(): never { throw new GitHubBacklogError("invalid_response"); }
