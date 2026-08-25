import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { GitHubAdapter } from "../src/adapter";

describe("GitHubAdapter", () => {
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
      reviewers: ["@devon", "@acme/security", "@devon"],
    });

    expect(request).toHaveBeenCalledWith("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
      owner: "acme",
      repo: "app",
      pull_number: 7,
      reviewers: ["devon"],
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

  it("lists valid pull-request reviews across pages and ignores malformed records", async () => {
    const firstPage: unknown[] = Array.from({ length: 100 }, () => null);
    firstPage[0] = {
      user: { login: "devon", type: "User" },
      state: "APPROVED",
      commit_id: "head-1",
      submitted_at: "2026-08-21T09:00:00Z",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({
        data: [
          { user: { login: "jules", type: "Bot" }, state: "CHANGES_REQUESTED", commit_id: null, submitted_at: null },
          { user: {}, state: "APPROVED" },
          { user: { login: "   " }, state: "APPROVED" },
          { user: { login: "sasha" }, state: "   " },
        ],
      });
    const adapter = new GitHubAdapter({ request } as never);

    await expect(adapter.listPullRequestReviews({ pullRequest: { owner: "acme", repo: "app", pullNumber: 7 } })).resolves
      .toEqual([
        {
          userLogin: "devon",
          userType: "User",
          state: "APPROVED",
          commitId: "head-1",
          submittedAt: "2026-08-21T09:00:00Z",
        },
        { userLogin: "jules", userType: "Bot", state: "CHANGES_REQUESTED", commitId: null, submittedAt: null },
      ]);

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
