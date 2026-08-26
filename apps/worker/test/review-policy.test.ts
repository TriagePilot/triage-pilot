import { describe, expect, it } from "vitest";

import { evaluateHumanReviewPolicy } from "../src/review-policy";

describe("evaluateHumanReviewPolicy", () => {
  it("accepts existing approvals from any human reviewers before TriagePilot routes the pull request", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@user-e64b19", "@user-f30c8a"],
        headSha: "head-3",
        reviews: [
          {
            userLogin: "user-d82a5f",
            state: "APPROVED",
            commitId: "head-1",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "user-a7f19c",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T11:00:00Z",
          },
        ],
      }),
    ).toEqual({
      state: "success",
      summary: "Required human approval count met.",
      missingReviewers: [],
    });
  });

  it("uses the configured high-risk approval requirement when fewer reviewers were available to request", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@user-e64b19"],
        requiredApprovalCount: 2,
        headSha: "head-3",
        reviews: [
          {
            userLogin: "user-d82a5f",
            state: "APPROVED",
            commitId: "head-1",
            submittedAt: "2026-08-21T10:00:00Z",
          },
        ],
      }),
    ).toMatchObject({ state: "in_progress", summary: "Waiting for 1 more human approval." });
  });

  it("counts approvals from prior heads toward the required total", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@user-d82a5f", "@user-e64b19"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "user-d82a5f",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "user-e64b19",
            state: "APPROVED",
            commitId: "head-1",
            submittedAt: "2026-08-21T11:00:00Z",
          },
        ],
      }),
    ).toEqual({
      state: "success",
      summary: "Required human approval count met.",
      missingReviewers: [],
    });
  });

  it("succeeds on the explicit no-human route", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "no_human",
        selectedReviewers: [],
        headSha: "head-2",
        reviews: [],
      }),
    ).toEqual({
      state: "success",
      summary: "No human approval is required for this pull request.",
      missingReviewers: [],
    });
  });

  it("fails a human-review route with no eligible reviewer", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "no_eligible_reviewer",
        selectedReviewers: [],
        headSha: "head-2",
        reviews: [],
      }),
    ).toEqual({
      state: "failure",
      summary: "No eligible human reviewer is available for this required review.",
      missingReviewers: [],
    });
  });

  it("succeeds when the required number of human approvals is present", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@user-d82a5f", "@user-e64b19"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "user-d82a5f",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "user-e64b19",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T11:00:00Z",
          },
        ],
      }),
    ).toEqual({
      state: "success",
      summary: "Required human approval count met.",
      missingReviewers: [],
    });
  });

  it.each([
    ["CHANGES_REQUESTED", "a newer request for changes"],
    ["DISMISSED", "a dismissed approval"],
    ["COMMENTED", "a comment-only review"],
  ])("does not count %s as approval (%s)", (state) => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@user-d82a5f"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "user-d82a5f",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "user-d82a5f",
            state,
            commitId: "head-2",
            submittedAt: "2026-08-21T11:00:00Z",
          },
        ],
      }),
    ).toMatchObject({ state: "in_progress", missingReviewers: ["@user-d82a5f"] });
  });

  it("uses the newest duplicate review for a selected reviewer", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@user-d82a5f"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "user-d82a5f",
            state: "CHANGES_REQUESTED",
            commitId: "head-2",
            submittedAt: "2026-08-21T09:00:00Z",
          },
          {
            userLogin: "user-d82a5f",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
        ],
      }),
    ).toMatchObject({ state: "success", missingReviewers: [] });
  });

  it("uses response order to break equal submitted-at ties", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@user-d82a5f"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "user-d82a5f",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "user-d82a5f",
            state: "CHANGES_REQUESTED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
        ],
      }),
    ).toMatchObject({ state: "in_progress", missingReviewers: ["@user-d82a5f"] });
  });

  it("uses response order when a later pending review has no submitted timestamp", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@user-d82a5f"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "user-d82a5f",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "user-d82a5f",
            state: "PENDING",
            commitId: "head-2",
            submittedAt: null,
          },
        ],
      }),
    ).toMatchObject({ state: "in_progress", missingReviewers: ["@user-d82a5f"] });
  });

  it("matches selected reviewer handles to GitHub logins case-insensitively", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@User-D82A5F"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "UsEr-D82A5F",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
        ],
      }),
    ).toMatchObject({ state: "success", missingReviewers: [] });
  });
});
