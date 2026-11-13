import { describe, expect, it } from "vitest";
import { activeApprovedReviewers } from "@triagepilot/core";
import type { QueueAssessment, QueuePullRequest, QueueReview, QueueReviewState } from "@triagepilot/contracts";
import { classifyPullRequestAttention } from "../src/pull-request-attention.js";

const human = (id: string) => ({ id, login: id, type: "human" as const });
const review = (id: string, state: string, time = "2026-01-02T00:00:00Z"): QueueReview => ({ id: `${id}-${state}-${time}`, actor: human(id), state, commitId: "old", submittedAt: time });
const pr: QueuePullRequest = { repository: { provider: "github", externalId: "r", owner: "o", name: "n" }, changeRequestId: "p", number: 1, title: "PR", author: human("author"), createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", baseRevision: "base", headRevision: "head", isDraft: false, requestedUsers: [], requestedTeams: [] };
const state: QueueReviewState = { status: "complete", reviews: [], observedAt: "2026-01-03T00:00:00Z", lifecycle: { status: "complete", openedSince: "2026-01-01T00:00:00Z" } };
const assessment: QueueAssessment = { decisionId: "d", createdAt: "2026-01-02T00:00:00Z", headRevision: "head", repositoryConfigRevision: "base", mode: "enforce", action: "request_human_review", actionStatus: "succeeded", policyCheckState: "success", failureReason: null, riskTier: "low", requiredReviews: 1, selectedActors: ["selected"] };
const run = (p: Partial<QueuePullRequest> = {}, s: Partial<QueueReviewState> = {}, a: QueueAssessment | null = assessment) => classifyPullRequestAttention({ pullRequest: { ...pr, ...p }, reviewState: { ...state, ...s }, assessment: a });

describe("pull request attention", () => {
  it.each([
    ["draft", { isDraft: true }, { status: "unavailable" as const }, "draft"],
    ["changed", {}, { status: "changed" as const }, "status_unknown"],
    ["unavailable", {}, { status: "unavailable" as const }, "status_unknown"],
    ["changes requested", {}, { reviews: [review("a", "CHANGES_REQUESTED"), review("a", "COMMENTED", "2026-01-03T00:00:00Z")] }, "authors_move"],
    ["re-request", { requestedUsers: [human("a")] }, { reviews: [review("a", "CHANGES_REQUESTED")] }, "reviewers_move"],
    ["other request", { requestedUsers: [human("b")] }, { reviews: [review("a", "CHANGES_REQUESTED")] }, "authors_move"],
    ["team", { requestedTeams: [{ id: "team", name: "Team" }] }, {}, "reviewers_move"],
    ["bot", { requestedUsers: [{ id: "bot", login: "bot", type: "bot" as const }] }, {}, "needs_reviewer"],
    ["gap", {}, {}, "needs_reviewer"],
    ["met", {}, { reviews: [review("outsider", "APPROVED")] }, "policy_met"],
    ["comment", {}, { reviews: [review("a", "COMMENTED")] }, "needs_reviewer"],
    ["dismissed", {}, { reviews: [review("a", "CHANGES_REQUESTED"), review("a", "DISMISSED", "2026-01-03T00:00:00Z")] }, "needs_reviewer"],
  ])("classifies %s", (_name, p, s, badge) => expect(run(p, s).badge).toBe(badge));
  it("handles assessment provenance and policy states", () => {
    const approved = { reviews: [review("x", "APPROVED")] };
    expect(run({}, approved, { ...assessment, policyCheckState: "failure", failureReason: "failed" }).badge).toBe("policy_unknown");
    expect(run({}, approved, { ...assessment, policyCheckState: "in_progress" }).checkUpdatePending).toBe(true);
    expect(run({}, {}, { ...assessment, action: "policy_approval", requiredReviews: 0 }).badge).toBe("policy_met");
    expect(run({}, {}, { ...assessment, mode: "shadow" }).requiredCount).toBeNull();
    for (const a of [{ ...assessment, requiredReviews: null }, { ...assessment, headRevision: "old" }, { ...assessment, repositoryConfigRevision: "old" }, { ...assessment, policyCheckState: "not_started" as const }]) expect(run({}, {}, a).badge).toBe("policy_unknown");
    expect(run({}, { lifecycle: { status: "complete", openedSince: "2026-01-03T00:00:00Z" } }).assessmentStatus).toBe("historical");
    expect(run({}, {}, null).badge).toBe("policy_unknown");
  });
  it("reports historical routing shortages without asserting current reviewer availability", () => {
    const attention = run({}, {}, { ...assessment, action: "no_eligible_reviewer", policyCheckState: "failure" });
    expect(attention).toMatchObject({ group: "reviewer_gap", badge: "needs_reviewer", approvedCount: 0, requiredCount: 1 });
    expect(attention.reason).toContain("human approvals");
    expect(attention.reason).toContain("no human review request is outstanding");
    expect(attention.secondaryReasons).toContain("No eligible reviewer was found at routing time; current reviewer availability is unknown.");
    expect(attention.reason).not.toContain("No eligible human reviewer is available");
  });
  it("uses core approval semantics", () => {
    const reviews = [review("a", "APPROVED"), review("a", "COMMENTED", "2026-01-03T00:00:00Z"), review("b", "APPROVED"), review("b", "DISMISSED", "2026-01-03T00:00:00Z"), review("outsider", "APPROVED")];
    expect(run({}, { reviews }).approvedCount).toBe(activeApprovedReviewers(reviews.map((r) => ({ actor: r.actor.id, actorType: r.actor.type, state: r.state.toLowerCase(), submittedAt: r.submittedAt }))).length);
  });
});
