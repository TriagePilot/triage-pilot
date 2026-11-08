import { describe, expect, it, vi } from "vitest";
import { createGitHubPullRequestQueueReader } from "../src/pull-request-queue.js";

const repository = { provider: "github" as const, externalId: "1", owner: "Acme", name: "repo" };
const user = { id: 12, login: "Alex", type: "User" };
const repo = (n = 1) => ({ id: n, name: n === 1 ? "repo" : `repo${n}`, owner: { login: "Acme" } });
const pr = (n = 1) => ({ id: n, number: n, state: "open", title: "PR", user, created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-02T00:00:00Z", draft: true, base: { sha: "base", repo: repo() }, head: { sha: "head" }, requested_reviewers: [user], requested_teams: [{ id: 19, slug: "platform" }] });
const context = () => ({ signal: new AbortController().signal, assertAuthorized: vi.fn(async () => {}), githubOrganization: "acme" });

describe("GitHub queue reader", () => {
  it("paginates inventory and open PRs, retaining old drafts and stable actor IDs", async () => {
    const request = vi.fn(async (route: string, p: Record<string, unknown>) => ({ data: route.includes("installation") ? { total_count: 101, repositories: p.page === 1 ? Array.from({ length: 100 }, (_, i) => repo(i + 1)) : [repo(101)] } : p.page === 1 ? Array.from({ length: 100 }, (_, i) => pr(i + 1)) : [pr(101)] }));
    const reader = createGitHubPullRequestQueueReader({ request }); const ctx = context();
    expect(await reader.listRepositories(ctx)).toHaveLength(101);
    const pulls = await reader.listOpenPullRequests({ ...ctx, repository });
    expect(pulls).toHaveLength(101); expect(pulls[0]).toMatchObject({ isDraft: true, requestedUsers: [{ id: "12", login: "alex" }], requestedTeams: [{ id: "19", name: "acme/platform" }] });
    expect(ctx.assertAuthorized).toHaveBeenCalledTimes(4);
  });
  it("rejects duplicate identities and excludes foreign owners", async () => {
    const reader = createGitHubPullRequestQueueReader({ request: async () => ({ data: { total_count: 2, repositories: [repo(), { ...repo(2), owner: { login: "other" } }] } }) });
    expect(await reader.listRepositories(context())).toHaveLength(1);
    const duplicates = createGitHubPullRequestQueueReader({ request: async () => ({ data: [pr(), pr()] }) });
    await expect(duplicates.listOpenPullRequests({ ...context(), repository })).rejects.toMatchObject({ reason: "invalid_response" });
  });
  it("rechecks changes and closure after paginated reviews and lifecycle", async () => {
    let detail = pr();
    const reader = createGitHubPullRequestQueueReader({ request: async (route, p) => ({ data: route.endsWith("/reviews") ? (p.page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, user, state: "APPROVED", commit_id: "head", submitted_at: "2020-01-02T00:00:00Z" })) : []) : route.endsWith("/timeline") ? [{ event: "reopened", created_at: "2020-01-03T00:00:00Z" }] : detail }) });
    const pull = (await createGitHubPullRequestQueueReader({ request: async () => ({ data: [pr()] }) }).listOpenPullRequests({ ...context(), repository }))[0]!;
    const state = await reader.readReviewState({ ...context(), pullRequest: pull, includeLifecycle: true });
    expect(state).toMatchObject({ status: "complete", lifecycle: { status: "complete", openedSince: "2020-01-03T00:00:00Z" } });
    detail = { ...pr(), draft: false }; expect(await reader.readReviewState({ ...context(), pullRequest: pull, includeLifecycle: false })).toMatchObject({ status: "changed" });
    detail = { ...pr(), state: "closed" }; expect(await reader.readReviewState({ ...context(), pullRequest: pull, includeLifecycle: false })).toEqual({ status: "closed" });
  });
  it("falls back for missing reviewer fields and sanitizes failures", async () => {
    const missing = { ...pr(), requested_reviewers: undefined, requested_teams: undefined };
    const reader = createGitHubPullRequestQueueReader({ request: async (route) => ({ data: route.endsWith("requested_reviewers") ? { users: [user], teams: [] } : [missing] }) });
    expect((await reader.listOpenPullRequests({ ...context(), repository }))[0]?.requestedUsers[0]?.id).toBe("12");
    for (const status of [401, 403, 404, 429]) {
      const failing = createGitHubPullRequestQueueReader({ request: async () => { throw { status, message: "secret payload" }; } });
      await expect(failing.listRepositories(context())).rejects.toMatchObject({ reason: status === 429 ? "rate_limited" : "authority", message: expect.not.stringContaining("secret") });
    }
  });
});
