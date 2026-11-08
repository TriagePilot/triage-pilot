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

describe("queue acquisition boundaries", () => {
  it.each([
    [{ total_count: 101, repositories: [] }],
    [{ total_count: 101, repositories: [repo()] }],
    [{ total_count: 101, repositories: Array.from({ length: 100 }, (_, i) => repo(i + 1)) }, { total_count: 102, repositories: [repo(101)] }],
  ])("rejects incomplete or inconsistent inventory %#", async (...responses) => {
    let index = 0;
    const reader = createGitHubPullRequestQueueReader({ request: async () => ({ data: responses[index++] }) });
    await expect(reader.listRepositories(context())).rejects.toMatchObject({ reason: "invalid_response" });
  });
  it("stops before a second page when authority is revoked or cancelled", async () => {
    for (const mode of ["authority", "abort"]) {
      const controller = new AbortController();
      const assertAuthorized = vi.fn(async () => { if (mode === "authority" && assertAuthorized.mock.calls.length === 2) throw new Error("revoked"); });
      const request = vi.fn(async () => { if (mode === "abort") controller.abort(); return { data: { total_count: 101, repositories: Array.from({ length: 100 }, (_, i) => repo(i + 1)) } }; });
      const reader = createGitHubPullRequestQueueReader({ request });
      await expect(reader.listRepositories({ signal: controller.signal, assertAuthorized, githubOrganization: "acme" })).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
  it("stops before fallback on authority loss and rejects mismatched repositories", async () => {
    const assertAuthorized = vi.fn(async () => { if (assertAuthorized.mock.calls.length === 2) throw new Error("revoked"); });
    const request = vi.fn(async () => ({ data: [{ ...pr(), requested_reviewers: undefined }] }));
    await expect(createGitHubPullRequestQueueReader({ request }).listOpenPullRequests({ ...context(), assertAuthorized, repository })).rejects.toThrow("revoked");
    expect(request).toHaveBeenCalledTimes(1);
    const mismatch = createGitHubPullRequestQueueReader({ request: async () => ({ data: [{ ...pr(), base: { sha: "base", repo: repo(2) } }] }) });
    await expect(mismatch.listOpenPullRequests({ ...context(), repository })).rejects.toMatchObject({ reason: "invalid_response" });
  });
  it("does not issue a fallback request after cancellation", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { controller.abort(); return { data: [{ ...pr(), requested_reviewers: undefined }] }; });
    await expect(createGitHubPullRequestQueueReader({ request }).listOpenPullRequests({ ...context(), signal: controller.signal, repository })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("uses stable IDs across renamed logins and detects target, head and base changes", async () => {
    const bot = { id: 33, login: "robot", type: "Bot" };
    const listed = { ...pr(), requested_reviewers: [bot] };
    const pull = (await createGitHubPullRequestQueueReader({ request: async () => ({ data: [listed] }) }).listOpenPullRequests({ ...context(), repository }))[0]!;
    expect(pull.requestedUsers).toEqual([{ id: "33", login: "robot", type: "bot" }]);
    let detail = { ...listed, requested_reviewers: [{ ...bot, login: "renamed" }] };
    const reader = createGitHubPullRequestQueueReader({ request: async (route) => ({ data: route.endsWith("/reviews") ? [] : detail }) });
    const read = () => reader.readReviewState({ ...context(), pullRequest: pull, includeLifecycle: false });
    expect(await read()).toMatchObject({ status: "complete" });
    detail = { ...detail, head: { sha: "new" } }; expect(await read()).toMatchObject({ status: "changed" });
    detail = { ...listed, base: { ...listed.base, sha: "new" } }; expect(await read()).toMatchObject({ status: "changed" });
    detail = { ...listed, requested_reviewers: [user] }; expect(await read()).toMatchObject({ status: "changed" });
  });
  it("paginates timeline and preserves unavailable lifecycle on transient failure", async () => {
    const pull = (await createGitHubPullRequestQueueReader({ request: async () => ({ data: [pr()] }) }).listOpenPullRequests({ ...context(), repository }))[0]!;
    let fail = false;
    const reader = createGitHubPullRequestQueueReader({ request: async (route, params) => {
      if (route.endsWith("/reviews")) return { data: [] };
      if (route.endsWith("/timeline")) {
        if (fail) throw { status: 500, message: "private" };
        return { data: params.page === 1 ? Array.from({ length: 100 }, () => ({ event: "commented", body: "private" })) : [{ event: "reopened", created_at: "2020-02-01T00:00:00Z" }] };
      }
      return { data: pr() };
    } });
    const read = () => reader.readReviewState({ ...context(), pullRequest: pull, includeLifecycle: true });
    expect(await read()).toMatchObject({ lifecycle: { status: "complete", openedSince: "2020-02-01T00:00:00Z" } });
    fail = true; expect(await read()).toMatchObject({ lifecycle: { status: "unavailable", openedSince: null } });
  });
});

describe("authorization at every queue request boundary", () => {
  const review = (n: number) => ({ id: n, user, state: "APPROVED", commit_id: "head", submitted_at: "2020-01-02T00:00:00Z" });
  it.each(["abort", "authority"])("blocks subsequent PR pages after %s", async (mode) => {
    const controller = new AbortController(); let authorizations = 0;
    const assertAuthorized = async () => { if (++authorizations === 2 && mode === "authority") throw new Error("revoked"); };
    const request = vi.fn(async () => { if (mode === "abort") controller.abort(); return { data: Array.from({ length: 100 }, (_, i) => pr(i + 1)) }; });
    await expect(createGitHubPullRequestQueueReader({ request }).listOpenPullRequests({ signal: controller.signal, assertAuthorized, githubOrganization: "acme", repository })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["reviews", "timeline"] as const)("blocks a second %s page after abort or authority revocation", async (boundary) => {
    const pull = (await createGitHubPullRequestQueueReader({ request: async () => ({ data: [pr()] }) }).listOpenPullRequests({ ...context(), repository }))[0]!;
    for (const mode of ["abort", "authority"]) {
      const controller = new AbortController(); let blocked = false;
      const assertAuthorized = async () => { if (blocked && mode === "authority") throw new Error("revoked"); };
      const request = vi.fn(async (route: string) => {
        if (route.endsWith(`/${boundary}`)) {
          blocked = true; if (mode === "abort") controller.abort();
          return { data: boundary === "reviews" ? Array.from({ length: 100 }, (_, i) => review(i + 1)) : Array.from({ length: 100 }, () => ({ event: "commented" })) };
        }
        return { data: [] };
      });
      await expect(createGitHubPullRequestQueueReader({ request }).readReviewState({ signal: controller.signal, assertAuthorized, githubOrganization: "acme", pullRequest: pull, includeLifecycle: boundary === "timeline" })).rejects.toThrow();
      expect(request.mock.calls.filter(([route]) => route.endsWith(`/${boundary}`))).toHaveLength(1);
      expect(request.mock.calls.some(([route]) => route === "GET /repos/{owner}/{repo}/pulls/{pull_number}")).toBe(false);
    }
  });
  it.each(["abort", "authority"])("blocks detail reviewer fallback after %s", async (mode) => {
    const pull = (await createGitHubPullRequestQueueReader({ request: async () => ({ data: [pr()] }) }).listOpenPullRequests({ ...context(), repository }))[0]!;
    const controller = new AbortController(); let detailRead = false;
    const assertAuthorized = async () => { if (detailRead && mode === "authority") throw new Error("revoked"); };
    const request = vi.fn(async (route: string) => {
      if (route.endsWith("/reviews")) return { data: [] };
      detailRead = true; if (mode === "abort") controller.abort();
      return { data: { ...pr(), requested_reviewers: undefined } };
    });
    await expect(createGitHubPullRequestQueueReader({ request }).readReviewState({ signal: controller.signal, assertAuthorized, githubOrganization: "acme", pullRequest: pull, includeLifecycle: false })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.some(([route]) => route.endsWith("/requested_reviewers"))).toBe(false);
  });
  it("matches human reviewer IDs after a login rename", async () => {
    const pull = (await createGitHubPullRequestQueueReader({ request: async () => ({ data: [pr()] }) }).listOpenPullRequests({ ...context(), repository }))[0]!;
    const reader = createGitHubPullRequestQueueReader({ request: async (route) => ({ data: route.endsWith("/reviews") ? [] : { ...pr(), requested_reviewers: [{ ...user, login: "NewName" }] } }) });
    expect(await reader.readReviewState({ ...context(), pullRequest: pull, includeLifecycle: false })).toMatchObject({ status: "complete" });
  });
});
