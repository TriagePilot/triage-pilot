import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { GitHubAdapter } from "../src/adapter";

describe("GitHubAdapter", () => {
  it("inspects current replacement state with normalized provider actors", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: { state: "open", head: { sha: "head-1" }, user: { login: "User-A91F5C" } },
      })
      .mockResolvedValueOnce({
        data: { users: [{ login: " USER-D82A5F " }], teams: [] },
      })
      .mockResolvedValueOnce({
        data: [{
          user: { login: "User-C91E46", type: "User" },
          state: "APPROVED",
          commit_id: "older-head",
          submitted_at: "2026-08-31T09:00:00.000Z",
        }],
      });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.inspectReviewerReplacement({
      pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
    })).resolves.toEqual({
      state: "open",
      currentHeadRevision: "head-1",
      authorActor: "@user-a91f5c",
      requestedActors: ["@user-d82a5f"],
      reviews: [{
        actor: "@user-c91e46",
        actorType: "human",
        state: "approved",
        submittedAt: "2026-08-31T09:00:00.000Z",
      }],
    });

    expect(request.mock.calls.map(([route]) => route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    ]);
  });

  it("performs an idempotent replacement no-op when provider state is already reconciled", async () => {
    const request = vi.fn().mockResolvedValue({
      data: { users: [{ login: "user-c91e46" }], teams: [] },
    });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.reconcileReviewerReplacement({
      pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
      unavailableActor: "@user-d82a5f",
      replacementActor: "@user-c91e46",
    })).resolves.toEqual({ changed: false });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("normalizes actors at the boundary and removes before requesting the replacement", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { users: [{ login: "USER-D82A5F" }], teams: [] } })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { users: [], teams: [] } })
      .mockResolvedValueOnce({ data: {} });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.reconcileReviewerReplacement({
      pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
      unavailableActor: " User-D82A5F ",
      replacementActor: "@User-C91E46",
    })).resolves.toEqual({ changed: true });

    expect(request).toHaveBeenNthCalledWith(2,
      "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      {
        owner: "acme",
        repo: "api",
        pull_number: 7,
        reviewers: ["user-d82a5f"],
        team_reviewers: [],
      },
    );
    expect(request).toHaveBeenNthCalledWith(4,
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      {
        owner: "acme",
        repo: "api",
        pull_number: 7,
        reviewers: ["user-c91e46"],
        team_reviewers: [],
      },
    );
  });

  it("completes a partial retry after removal without repeating that removal", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { users: [], teams: [] } })
      .mockResolvedValueOnce({ data: { users: [], teams: [] } })
      .mockResolvedValueOnce({ data: {} });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.reconcileReviewerReplacement({
      pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
      unavailableActor: "@user-d82a5f",
      replacementActor: "@user-c91e46",
    })).resolves.toEqual({ changed: true });

    expect(request.mock.calls.map(([route]) => route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
    ]);
  });

  it("re-lists after removal and repairs a concurrently removed replacement request", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: { users: [{ login: "user-d82a5f" }, { login: "user-c91e46" }], teams: [] },
      })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { users: [], teams: [] } })
      .mockResolvedValueOnce({ data: {} });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.reconcileReviewerReplacement({
      pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
      unavailableActor: "@user-d82a5f",
      replacementActor: "@user-c91e46",
    });

    expect(request.mock.calls.map(([route]) => route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
    ]);
  });

  it("re-lists after removal and skips a concurrently added replacement request", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { users: [{ login: "user-d82a5f" }], teams: [] } })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { users: [{ login: "user-c91e46" }], teams: [] } });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.reconcileReviewerReplacement({
      pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
      unavailableActor: "@user-d82a5f",
      replacementActor: "@user-c91e46",
    })).resolves.toEqual({ changed: true });

    expect(request.mock.calls.map(([route]) => route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
    ]);
  });

  it("fails closed on a malformed requested-reviewer payload", async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: { reviewers: [] } });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.listRequestedReviewers({
      pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
    })).rejects.toThrow("GitHub requested reviewers response is malformed");
  });

  it("classifies a malformed requested-reviewer payload as permanent", async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: { reviewers: [] } });
    const adapter = new GitHubAdapter({ request } as never);
    let caught: unknown;
    try {
      await adapter.listRequestedReviewers({
        pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
      });
    } catch (error) {
      caught = error;
    }

    expect(adapter.classifyReviewerReplacementError(caught)).toEqual({
      kind: "permanent",
      message: "GitHub requested reviewers response is malformed",
    });
  });

  it("fails closed on a malformed requested-reviewer user record", async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: { users: [{ login: "user-c91e46" }, { id: 42 }], teams: [] },
    });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.listRequestedReviewers({
      pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
    })).rejects.toThrow("GitHub requested reviewer user is malformed");
  });

  it("does not paginate the GitHub requested-reviewers endpoint for exactly 100 users", async () => {
    const users = Array.from({ length: 100 }, (_, index) => ({ login: `user-${index}` }));
    const request = vi.fn().mockResolvedValueOnce({ data: { users, teams: [] } });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.listRequestedReviewers({
      pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
    })).resolves.toHaveLength(100);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      { owner: "acme", repo: "api", pull_number: 7 },
    );
  });

  it.each([
    [429, "Too many requests", undefined, "retryable"],
    [403, "Forbidden", { "retry-after": "60" }, "retryable"],
    [403, "API rate limit exceeded for installation", { "x-ratelimit-remaining": "0" }, "retryable"],
    [403, "You have exceeded a secondary rate limit.", undefined, "retryable"],
    [403, "Resource not accessible by integration", undefined, "permanent"],
    [422, "Validation failed, or the endpoint has been spammed.", undefined, "retryable"],
    [422, "Validation Failed", undefined, "permanent"],
    [503, "provider failed", undefined, "retryable"],
    [undefined, "network unavailable", undefined, "retryable"],
  ] as const)("maps GitHub status %s, message '%s', and headers %j to a %s provider error", (status, message, headers, kind) => {
    const adapter = new GitHubAdapter({ request: vi.fn() } as never);
    const error = status === undefined
      ? new Error(message)
      : Object.assign(new Error(message), { status, response: { headers } });

    expect(adapter.classifyReviewerReplacementError(error)).toEqual({
      kind,
      message: error.message,
    });
  });

  it.each([
    ["same actor", "@user-d82a5f", "@user-d82a5f", "GitHub unavailable and replacement actors must differ"],
    ["team actor", "@user-d82a5f", "@acme/reviewers", "GitHub reviewer actor must identify an individual user"],
  ] as const)("classifies deterministic %s replacement input as permanent", async (_name, unavailable, replacement, message) => {
    const adapter = new GitHubAdapter({ request: vi.fn() } as never);
    let caught: unknown;
    try {
      await adapter.reconcileReviewerReplacement({
        pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
        unavailableActor: unavailable,
        replacementActor: replacement,
      });
    } catch (error) {
      caught = error;
    }

    expect(adapter.classifyReviewerReplacementError(caught)).toEqual({ kind: "permanent", message });
  });

  it.each([
    ["inspection", "GET /repos/{owner}/{repo}/pulls/{pull_number}", "inspection failed"],
    ["removal", "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", "removal failed"],
    ["request", "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", "request failed"],
  ] as const)("propagates a provider %s error", async (operation, failingRoute, message) => {
    const request = vi.fn(async (route: string) => {
      if (route === failingRoute) throw new Error(message);
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return { data: { state: "open", head: { sha: "head-1" }, user: { login: "user-a91f5c" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
        return { data: { users: [{ login: "user-d82a5f" }], teams: [] } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data: [] };
      return { data: {} };
    });
    const adapter = new GitHubAdapter({ request } as never);

    const action = operation === "inspection"
      ? adapter.inspectReviewerReplacement({ pullRequest: { owner: "acme", repo: "api", pullNumber: 7 } })
      : adapter.reconcileReviewerReplacement({
        pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
        unavailableActor: "@user-d82a5f",
        replacementActor: "@user-c91e46",
      });

    await expect(action).rejects.toThrow(message);
    if (operation === "removal") {
      expect(request.mock.calls.map(([route]) => route)).not.toContain(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      );
    }
  });

  it("upserts the routing comment using a stable marker", async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: { id: 55 } });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.upsertRoutingComment({
      pullRequest: { owner: "acme", repo: "app", pullNumber: 7 },
      decisionId: "decision-1",
      body: "Risk: low",
    });

    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: "acme",
      repo: "app",
      issue_number: 7,
      page: 1,
      per_page: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: "acme",
      repo: "app",
      issue_number: 7,
      body: "<!-- triagepilot:decision:decision-1 -->\nRisk: low",
    });
  });

  it("updates the routing comment for the same decision", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 55, body: "<!-- triagepilot:decision:decision-1 -->\nOld" }] })
      .mockResolvedValueOnce({ data: { id: 55 } });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.upsertRoutingComment({
      pullRequest: { owner: "acme", repo: "app", pullNumber: 7 },
      decisionId: "decision-1",
      body: "Risk: low",
    });

    expect(request).toHaveBeenNthCalledWith(2, "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner: "acme",
      repo: "app",
      comment_id: 55,
      body: "<!-- triagepilot:decision:decision-1 -->\nRisk: low",
    });
  });

  it("updates a decision comment found on the second page without creating a duplicate", async () => {
    const firstPage = Array.from({ length: 100 }, (_, id) => ({ id, body: `comment ${id}` }));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: [{ id: 155, body: "<!-- triagepilot:decision:decision-1 -->\nOld" }] })
      .mockResolvedValueOnce({ data: { id: 155 } });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.upsertRoutingComment({
      pullRequest: { owner: "acme", repo: "app", pullNumber: 7 },
      decisionId: "decision-1",
      body: "Risk: low",
    });

    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: "acme",
      repo: "app",
      issue_number: 7,
      page: 1,
      per_page: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: "acme",
      repo: "app",
      issue_number: 7,
      page: 2,
      per_page: 100,
    });
    expect(request).toHaveBeenNthCalledWith(3, "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner: "acme",
      repo: "app",
      comment_id: 155,
      body: "<!-- triagepilot:decision:decision-1 -->\nRisk: low",
    });
    expect(request.mock.calls.map(([route]) => route)).not.toContain(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    );
  });

  it("requests at most two distinct human reviewers in one GitHub call", async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.requestHumanReviewers({
      pullRequest: { owner: "acme", repo: "app", pullNumber: 7 },
      reviewers: ["@user-b4e82d", "@team-a7f19c/security", "@user-b4e82d"],
    });

    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
      owner: "acme",
      repo: "app",
      pull_number: 7,
      reviewers: ["user-b4e82d"],
      team_reviewers: ["security"],
    });
  });

  it("submits a low-risk policy approval review", async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: {} });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.submitPolicyApproval({
      pullRequest: { owner: "acme", repo: "app", pullNumber: 7 },
      expectedHeadSha: "abc",
      decisionId: "decision-1",
      body: "Policy approval",
    });

    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: "acme",
      repo: "app",
      pull_number: 7,
      page: 1,
      per_page: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: "acme",
      repo: "app",
      pull_number: 7,
      commit_id: "abc",
      event: "APPROVE",
      body: "<!-- triagepilot:decision:decision-1 -->\nPolicy approval",
    });
  });

  it("skips a policy approval already submitted for the same decision", async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: [{ body: "Approved\n<!-- triagepilot:decision:decision-1 -->" }],
    });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.submitPolicyApproval({
      pullRequest: { owner: "acme", repo: "app", pullNumber: 7 },
      expectedHeadSha: "abc",
      decisionId: "decision-1",
      body: "Policy approval",
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("finds a policy approval on the second page and does not submit a duplicate", async () => {
    const firstPage = Array.from({ length: 100 }, (_, id) => ({ id, body: `review ${id}` }));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: [{ body: "<!-- triagepilot:decision:decision-1 -->\nApproved" }] });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.submitPolicyApproval({
      pullRequest: { owner: "acme", repo: "app", pullNumber: 7 },
      expectedHeadSha: "abc",
      decisionId: "decision-1",
      body: "Policy approval",
    });

    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: "acme",
      repo: "app",
      pull_number: 7,
      page: 1,
      per_page: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: "acme",
      repo: "app",
      pull_number: 7,
      page: 2,
      per_page: 100,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([route]) => route)).not.toContain(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    );
  });

  it("lists valid pull-request reviews across pages", async () => {
    const firstPage: unknown[] = Array.from({ length: 100 }, (_, index) => ({
      user: { login: `user-${index}`, type: "User" },
      state: "COMMENTED",
      commit_id: "head-1",
      submitted_at: "2026-08-21T09:00:00Z",
    }));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({
        data: [
          { user: { login: "user-7a3d9c", type: "Bot" }, state: "CHANGES_REQUESTED", commit_id: null, submitted_at: null },
        ],
      });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.listPullRequestReviews({ pullRequest: { owner: "acme", repo: "app", pullNumber: 7 } })).resolves
      .toHaveLength(101);

    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: "acme",
      repo: "app",
      pull_number: 7,
      page: 1,
      per_page: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: "acme",
      repo: "app",
      pull_number: 7,
      page: 2,
      per_page: 100,
    });
  });

  it.each([
    ["non-array response", { reviews: [] }],
    ["missing user", [{ state: "APPROVED", commit_id: "head-1", submitted_at: null }]],
    ["missing actor", [{ user: { type: "User" }, state: "APPROVED", commit_id: "head-1", submitted_at: null }]],
    ["missing user type", [{ user: { login: "user-b4e82d" }, state: "APPROVED", commit_id: "head-1", submitted_at: null }]],
    ["missing state", [{ user: { login: "user-b4e82d", type: "User" }, commit_id: "head-1", submitted_at: null }]],
    ["missing commit", [{ user: { login: "user-b4e82d", type: "User" }, state: "APPROVED", submitted_at: null }]],
    ["blank commit", [{ user: { login: "user-b4e82d", type: "User" }, state: "APPROVED", commit_id: " ", submitted_at: null }]],
    ["invalid submission", [{ user: { login: "user-b4e82d", type: "User" }, state: "APPROVED", commit_id: null, submitted_at: 42 }]],
  ])("fails closed on a %s in replacement reviews", async (_name, data) => {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return { data: { state: "open", head: { sha: "head-1" }, user: { login: "user-a91f5c" } } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
        return { data: { users: [{ login: "user-d82a5f" }], teams: [] } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return { data };
      throw new Error(`unexpected route ${route}`);
    });
    const adapter = new GitHubAdapter({ request } as never);
    let caught: unknown;
    try {
      await adapter.inspectReviewerReplacement({ pullRequest: { owner: "acme", repo: "app", pullNumber: 7 } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(adapter.classifyReviewerReplacementError(caught)).toMatchObject({ kind: "permanent" });
  });

  it("does not turn a malformed approval review into an apparently safe replacement state", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: { state: "open", head: { sha: "head-1" }, user: { login: "user-a91f5c" } },
      })
      .mockResolvedValueOnce({ data: { users: [{ login: "user-d82a5f" }], teams: [] } })
      .mockResolvedValueOnce({
        data: [{ user: { login: "user-c91e46" }, state: "APPROVED", commit_id: "head-1", submitted_at: null }],
      });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.inspectReviewerReplacement({
      pullRequest: { owner: "acme", repo: "api", pullNumber: 7 },
    })).rejects.toThrow("GitHub pull request review is malformed");
  });

  it("creates an in-progress human-review policy check", async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: { id: 71 } });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(
      adapter.createHumanReviewPolicyCheck({
        checkRun: { owner: "acme", repo: "app", headSha: "head-1" },
        decisionId: "decision-1",
        state: "in_progress",
        summary: "Waiting for the required human review.",
      }),
    ).resolves.toEqual({ checkRunId: "71" });

    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/check-runs", {
      owner: "acme",
      repo: "app",
      head_sha: "head-1",
      name: "triagepilot/human-review-policy",
      external_id: "decision-1",
      status: "in_progress",
      output: {
        title: "TriagePilot human review policy",
        summary: "Waiting for the required human review.",
      },
    });
  });

  it("finds the latest decision-keyed human-review policy check", async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: {
        check_runs: [
          {
            id: 71,
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: "completed",
            conclusion: "success",
            app: { id: 123 },
          },
          {
            id: 99,
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: "in_progress",
            conclusion: null,
            app: { id: 999 },
          },
          {
            id: 72,
            name: "triagepilot/human-review-policy",
            external_id: "decision-1",
            status: "in_progress",
            conclusion: null,
            app: { id: 123 },
          },
        ],
      },
    });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(
      adapter.findHumanReviewPolicyCheck({
        checkRun: { owner: "acme", repo: "app", headSha: "head-1" },
        decisionId: "decision-1",
        appId: 123,
      }),
    ).resolves.toEqual({ checkRunId: "72", state: "in_progress" });

    expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner: "acme",
      repo: "app",
      ref: "head-1",
      check_name: "triagepilot/human-review-policy",
      app_id: 123,
      filter: "all",
      page: 1,
      per_page: 100,
    });
  });

  it("accepts only terminal states when updating a human-review policy check", () => {
    type UpdateInput = Parameters<GitHubAdapter["updateHumanReviewPolicyCheck"]>[0];

    expectTypeOf<UpdateInput["state"]>().toEqualTypeOf<"success" | "failure">();
  });

  it.each(["success", "failure"] as const)("completes a human-review policy check with %s", async (state) => {
    const request = vi.fn().mockResolvedValueOnce({ data: {} });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.updateHumanReviewPolicyCheck({
      checkRun: { owner: "acme", repo: "app", headSha: "head-1" },
      checkRunId: "71",
      state,
      summary: "Human-review policy evaluation complete.",
    });

    expect(request).toHaveBeenCalledWith("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner: "acme",
      repo: "app",
      check_run_id: "71",
      name: "triagepilot/human-review-policy",
      status: "completed",
      conclusion: state,
      output: {
        title: "TriagePilot human review policy",
        summary: "Human-review policy evaluation complete.",
      },
    });
  });

  it("creates a decision-keyed triagepilot routing check", async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: { check_runs: [] } }).mockResolvedValueOnce({ data: {} });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.writeRoutingCheck({
      checkRun: { owner: "acme", repo: "app", headSha: "abc" },
      decisionId: "decision-1",
      conclusion: "success",
      summary: "Low risk PR routed by policy approval",
    });

    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner: "acme",
      repo: "app",
      ref: "abc",
      check_name: "triagepilot/routing",
      filter: "all",
      page: 1,
      per_page: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "POST /repos/{owner}/{repo}/check-runs", {
      owner: "acme",
      repo: "app",
      name: "triagepilot/routing",
      head_sha: "abc",
      external_id: "decision-1",
      status: "completed",
      conclusion: "success",
      output: {
        title: "TriagePilot routing",
        summary: "Low risk PR routed by policy approval",
      },
    });
  });

  it("updates the routing check for the same decision", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: { check_runs: [{ id: 71, name: "triagepilot/routing", external_id: "decision-1" }] },
      })
      .mockResolvedValueOnce({ data: {} });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.writeRoutingCheck({
      checkRun: { owner: "acme", repo: "app", headSha: "abc" },
      decisionId: "decision-1",
      conclusion: "success",
      summary: "Low risk PR routed by policy approval",
    });

    expect(request).toHaveBeenNthCalledWith(2, "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner: "acme",
      repo: "app",
      check_run_id: 71,
      name: "triagepilot/routing",
      external_id: "decision-1",
      status: "completed",
      conclusion: "success",
      output: {
        title: "TriagePilot routing",
        summary: "Low risk PR routed by policy approval",
      },
    });
  });

  it("updates a decision check found on the second page without creating a duplicate", async () => {
    const firstPage = Array.from({ length: 100 }, (_, id) => ({
      id,
      name: "triagepilot/routing",
      external_id: `other-decision-${id}`,
    }));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { check_runs: firstPage } })
      .mockResolvedValueOnce({
        data: { check_runs: [{ id: 171, name: "triagepilot/routing", external_id: "decision-1" }] },
      })
      .mockResolvedValueOnce({ data: {} });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.writeRoutingCheck({
      checkRun: { owner: "acme", repo: "app", headSha: "abc" },
      decisionId: "decision-1",
      conclusion: "success",
      summary: "Low risk PR routed by policy approval",
    });

    const pageParameters = {
      owner: "acme",
      repo: "app",
      ref: "abc",
      check_name: "triagepilot/routing",
      filter: "all",
      per_page: 100,
    };
    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      ...pageParameters,
      page: 1,
    });
    expect(request).toHaveBeenNthCalledWith(2, "GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      ...pageParameters,
      page: 2,
    });
    expect(request).toHaveBeenNthCalledWith(3, "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner: "acme",
      repo: "app",
      check_run_id: 171,
      name: "triagepilot/routing",
      external_id: "decision-1",
      status: "completed",
      conclusion: "success",
      output: {
        title: "TriagePilot routing",
        summary: "Low risk PR routed by policy approval",
      },
    });
    expect(request.mock.calls.map(([route]) => route)).not.toContain("POST /repos/{owner}/{repo}/check-runs");
  });

  it("replaces only an older TriagePilot risk label", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { name: "triagepilot:risk-high" } })
      .mockResolvedValueOnce({
        data: [{ name: "triagepilot:risk-low" }, { name: "team:release" }],
      })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: [{ name: "triagepilot:risk-high" }, { name: "team:release" }] });
    const adapter = new GitHubAdapter({ request } as never);

    await adapter.syncRiskLabel({
      pullRequest: { owner: "acme", repo: "app", pullNumber: 7 },
      tier: "high",
    });

    expect(request).toHaveBeenNthCalledWith(1, "POST /repos/{owner}/{repo}/labels", {
      owner: "acme",
      repo: "app",
      name: "triagepilot:risk-high",
      color: "b60205",
      description: "TriagePilot risk: high",
    });
    expect(request).toHaveBeenNthCalledWith(2, "GET /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      owner: "acme",
      repo: "app",
      issue_number: 7,
      per_page: 100,
      page: 1,
    });
    expect(request).toHaveBeenNthCalledWith(3, "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
      owner: "acme",
      repo: "app",
      issue_number: 7,
      name: "triagepilot:risk-low",
    });
    expect(request).toHaveBeenNthCalledWith(4, "POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      owner: "acme",
      repo: "app",
      issue_number: 7,
      labels: ["triagepilot:risk-high"],
    });
  });
});
