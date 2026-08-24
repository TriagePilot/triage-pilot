import { describe, expect, it } from "vitest";

import { evaluateHumanReviewPolicy } from "../src/review-policy";

describe("evaluateHumanReviewPolicy", () => {
  it("keeps a reviewer with only a prior-head approval outstanding", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@alice", "@bob"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "alice",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "bob",
            state: "APPROVED",
            commitId: "head-1",
            submittedAt: "2026-08-21T11:00:00Z",
          },
        ],
      }),
    ).toEqual({
      state: "in_progress",
      summary: "Waiting for approval from @bob.",
      missingReviewers: ["@bob"],
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

  it("succeeds only after both selected reviewers approve the current head", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@alice", "@bob"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "alice",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "bob",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T11:00:00Z",
          },
        ],
      }),
    ).toEqual({
      state: "success",
      summary: "All required human reviewers approved the current head.",
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
        selectedReviewers: ["@alice"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "alice",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "alice",
            state,
            commitId: "head-2",
            submittedAt: "2026-08-21T11:00:00Z",
          },
        ],
      }),
    ).toMatchObject({ state: "in_progress", missingReviewers: ["@alice"] });
  });

  it("uses the newest duplicate review for a selected reviewer", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@alice"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "alice",
            state: "CHANGES_REQUESTED",
            commitId: "head-2",
            submittedAt: "2026-08-21T09:00:00Z",
          },
          {
            userLogin: "alice",
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
        selectedReviewers: ["@alice"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "alice",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "alice",
            state: "CHANGES_REQUESTED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
        ],
      }),
    ).toMatchObject({ state: "in_progress", missingReviewers: ["@alice"] });
  });

  it("uses response order when a later pending review has no submitted timestamp", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@alice"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "alice",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
          {
            userLogin: "alice",
            state: "PENDING",
            commitId: "head-2",
            submittedAt: null,
          },
        ],
      }),
    ).toMatchObject({ state: "in_progress", missingReviewers: ["@alice"] });
  });

  it("matches selected reviewer handles to GitHub logins case-insensitively", () => {
    expect(
      evaluateHumanReviewPolicy({
        route: "human_review",
        selectedReviewers: ["@Alice"],
        headSha: "head-2",
        reviews: [
          {
            userLogin: "aLiCe",
            state: "APPROVED",
            commitId: "head-2",
            submittedAt: "2026-08-21T10:00:00Z",
          },
        ],
      }),
    ).toMatchObject({ state: "success", missingReviewers: [] });
  });
});
