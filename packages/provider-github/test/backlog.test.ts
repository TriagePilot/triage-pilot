import { describe, expect, it, vi } from "vitest";
import { GitHubAdapter } from "../src/adapter";

const repository = { provider: "github" as const, externalId: "42", owner: "acme", name: "api" };
const user = { login: "Alex", type: "User" };
const pull = (number = 1) => ({ id: number + 1000, number, state: "open", draft: true,
  base: { repo: { id: 42, name: "api", owner: { login: "acme" } } },
  requested_reviewers: [user, { ...user, login: "aLEX" }, { login: "robot[bot]", type: "Bot" }],
  requested_teams: [{ id: 1, slug: "team" }],
});
const input = () => ({ repository, signal: new AbortController().signal, assertAuthorized: vi.fn(async () => {}) });

describe("GitHub pending review backlog", () => {
  it("reads every page, retains drafts, normalizes humans and omits bots/teams", async () => {
    const args = input();
    const request = vi.fn(async (_route, params) => {
      expect(args.assertAuthorized).toHaveBeenCalledTimes(request.mock.calls.length);
      expect(params).toMatchObject({ state: "open", sort: "created", direction: "asc", per_page: 100, request: { signal: args.signal } });
      return { data: params.page === 1 ? Array.from({ length: 100 }, (_, i) => pull(i + 1)) : [pull(101)] };
    });
    const result = await new GitHubAdapter({ request }).listOpenReviewRequests(args);
    expect(result).toHaveLength(101);
    expect(result[0]).toEqual({ changeRequestId: "1", changeRequestNumber: 1, requestedActors: ["@alex"] });
    expect(args.assertAuthorized).toHaveBeenCalledTimes(2);
  });
  it("uses the documented complete users/teams fallback with fresh authority", async () => {
    const args = input();
    const pr: Record<string, unknown> = pull(); delete pr.requested_reviewers;
    const request = vi.fn(async (route, params) => {
      expect(args.assertAuthorized).toHaveBeenCalledTimes(request.mock.calls.length);
      expect(params.request.signal).toBe(args.signal);
      return { data: route.endsWith("requested_reviewers") ? { users: [user], teams: [] } : [pr] };
    });
    expect((await new GitHubAdapter({ request }).listOpenReviewRequests(args))[0]?.requestedActors).toEqual(["@alex"]);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("stops before a revoked fallback read", async () => {
    const args = input(); args.assertAuthorized.mockImplementationOnce(async () => {}).mockRejectedValue(new Error("revoked"));
    const pr: Record<string, unknown> = pull(); delete pr.requested_reviewers;
    const request = vi.fn(async () => ({ data: [pr] }));
    await expect(new GitHubAdapter({ request }).listOpenReviewRequests(args)).rejects.toThrow("revoked");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("stops before a revoked second page", async () => {
    const args = input(); args.assertAuthorized.mockImplementationOnce(async () => {}).mockRejectedValue(new Error("revoked"));
    const request = vi.fn(async () => ({ data: Array.from({ length: 100 }, (_, i) => pull(i + 1)) }));
    await expect(new GitHubAdapter({ request }).listOpenReviewRequests(args)).rejects.toThrow("revoked");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, [{ ...pull(), id: null }], [{ ...pull(), base: { repo: { id: 99 } } }],
    [{ ...pull(), requested_reviewers: null }], [{ ...pull(), requested_reviewers: [{}] }],
    [{ ...pull(), requested_teams: null }], [{ ...pull(), requested_teams: [{}] }],
    [{ ...pull(), requested_reviewers: [{ login: "org/team", type: "User" }] }], [pull(), { ...pull(), id: 99 }],
  ])("rejects malformed or mismatched inventory %j", async (data) => {
    await expect(new GitHubAdapter({ request: async () => ({ data }) }).listOpenReviewRequests(input()))
      .rejects.toMatchObject({ reason: "invalid_response" });
  });
  it("rejects missing fallback collections", async () => {
    const pr: Record<string, unknown> = pull(); delete pr.requested_reviewers;
    const request = async (route: string) => ({ data: route.endsWith("requested_reviewers") ? { users: [] } : [pr] });
    await expect(new GitHubAdapter({ request }).listOpenReviewRequests(input())).rejects.toMatchObject({ reason: "invalid_response" });
  });
  it.each([[401, {}, "unauthorized"], [403, {}, "forbidden"], [404, {}, "not_found"], [429, {}, "rate_limited"],
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited"], [503, {}, "provider_unavailable"],
  ])("classifies %s without exposing provider content", async (status, headers, reason) => {
    const request = async () => { throw { status, response: { headers }, message: "secret raw response" }; };
    await expect(new GitHubAdapter({ request }).listOpenReviewRequests(input())).rejects.toMatchObject({ reason });
    await expect(new GitHubAdapter({ request }).listOpenReviewRequests(input())).rejects.not.toThrow("secret");
  });
  it("does not request after cancellation", async () => {
    const args = input(); const controller = new AbortController(); controller.abort(); args.signal = controller.signal;
    const request = vi.fn();
    await expect(new GitHubAdapter({ request }).listOpenReviewRequests(args)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

it.each([[503, {}, "provider_unavailable"], [429, {}, "rate_limited"], [403, { "retry-after": "1" }, "rate_limited"]] as const)("classifies installation probe %s as %s", async (status, headers, reason) => {
  const { listOpenReviewRequestsWithInstallationProbe } = await import("../src/backlog");
  const request = vi.fn(async (route: string) => {
    if (route === "GET /installation/repositories") throw { status, response: { headers } };
    throw { status: 404 };
  });
  await expect(listOpenReviewRequestsWithInstallationProbe({ request }, input())).rejects.toMatchObject({ reason });
});

it("preserves the repository denial if the installation probe is unauthorized", async () => {
  const { listOpenReviewRequestsWithInstallationProbe } = await import("../src/backlog");
  const request = vi.fn(async (route: string) => { throw { status: route === "GET /installation/repositories" ? 401 : 404 }; });
  await expect(listOpenReviewRequestsWithInstallationProbe({ request }, input())).rejects.toMatchObject({ reason: "not_found" });
});

it("preserves cancellation during an installation probe", async () => {
  const { listOpenReviewRequestsWithInstallationProbe } = await import("../src/backlog");
  const controller = new AbortController();
  const request = vi.fn(async (route: string) => {
    if (route === "GET /installation/repositories") { controller.abort(new Error("cancelled")); throw { status: 503 }; }
    throw { status: 404 };
  });
  await expect(listOpenReviewRequestsWithInstallationProbe({ request }, { ...input(), signal: controller.signal })).rejects.toThrow("cancelled");
});
