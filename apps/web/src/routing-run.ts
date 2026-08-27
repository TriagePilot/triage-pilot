export type RoutingRunRequest = { decisionId: string } | { pullRequestUrl: string };

export class RoutingRunError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422,
    readonly code: "not_found" | "pull_request_closed" | "invalid_pull_request",
  ) {
    super(message);
  }
}

export function parsePullRequestUrl(value: string): { owner: string; repo: string; pullNumber: number } | null {
  try {
    const url = new URL(value);
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !match) return null;
    const pullNumber = Number(match[3]);
    if (!Number.isSafeInteger(pullNumber) || pullNumber > 2_147_483_647) return null;
    return { owner: match[1]!, repo: match[2]!, pullNumber };
  } catch {
    return null;
  }
}
